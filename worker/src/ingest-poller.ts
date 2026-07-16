import type { Sql } from "./db.js";
import type { WorkerConfig } from "./config.js";
import { log as rootLog } from "./log.js";
import { resolveHandler, type Handler, type HandlerContext } from "./handlers/index.js";

/**
 * The scheduler→worker bridge (P1 fix).
 *
 * `ingest.enqueue_due_jobs()` (pg_cron `ingest-tick`, SECURITY DEFINER, 0005)
 * INSERTs due cadence jobs as rows in the TABLE `ingest.job_queue` — it does NOT
 * pgmq.send. `ingest.job_queue` is therefore NOT a pgmq queue (CONTRACT §9 note,
 * consumer.ts header): the pgmq consumers never see these rows, so without this
 * poller the scheduled scrapes pile up as status='queued' forever (72 rows were
 * observed stuck). The claim columns on the table (claimed_by/claimed_at/
 * finished_at/status) are the design intent for exactly this worker-side claim
 * loop (01-ingestion.md §4.1: "The VPS worker long-polls the queue … a single
 * indexed SELECT … FOR UPDATE SKIP LOCKED").
 *
 * This poller, on an interval:
 *   1. Atomically CLAIMS a batch of DUE rows (run_after <= now(), status='queued')
 *      with FOR UPDATE SKIP LOCKED — so N workers never claim the same row —
 *      flipping them to status='running' + claimed_by/claimed_at, and joining
 *      ingest.sources to get each row's venue + data_type.
 *   2. Runs the matching ALREADY-REGISTERED ingestion handler for the data_type
 *      (CONTRACT §9: quotes→quote_poll, filings_list→filings_poll,
 *      eod_bulletin→eod_sweep), reusing the exact handler the pgmq path invokes.
 *   3. Marks each row 'ok' / 'failed' (+ finished_at, + error into fetch_log via
 *      the handler) so it is never re-claimed. `ingest.requeue_stuck_jobs`
 *      (cron `queue-reaper`) reclaims any row abandoned in 'running' (worker
 *      crash / SIGKILL) after 15 min, so at-least-once delivery is preserved.
 *
 * Concurrency is capped (config.ingestConcurrency, default 4 — matches the
 * framework's global fetch concurrency ceiling, CONTRACT §5). The per-host ≤1
 * req/s request budget is enforced INSIDE the ingestion runtime's fetcher
 * (core/fetcher.ts token bucket, CONTRACT §5), not here — this poller only bounds
 * how many jobs run in parallel.
 */

/** How data_type maps to the registered handler that services it (CONTRACT §9). */
const DATA_TYPE_TO_HANDLER: Record<string, string> = {
  quotes: "quote_poll",
  indices: "quote_poll", // indices are folded into the venue quotes job (CONTRACT §8)
  // ohlcv_backfill (Yahoo ≥2y daily drain, migration 0021/0022) reuses quote_poll: that handler
  // is source-scoped ({ sourceId }) and provider-agnostic — it loads the source, calls
  // runtime.tasksForSource (which now returns the Yahoo ohlcvBackfill task for a provider='yahoo'
  // source), then runTask emits NormalizedOhlcv rows through the existing OHLCV staging mapper +
  // cross-check. No dedicated handler is needed.
  ohlcv_backfill: "quote_poll",
  // financials (07 §P1.7b) reuses quote_poll: like ohlcv_backfill it is source-scoped
  // ({ sourceId }) and provider-agnostic — the handler loads the source, resolves its
  // financials TaskSpec via runtime.tasksForSource, and runTask emits NormalizedStatementRow
  // through the staging mapper (FILING.FINANCIALS) → cross_check → the projection. No
  // dedicated handler is needed. Inert until a `financials` source is seeded active.
  financials: "quote_poll",
  // securities_profile (DEF-SECTOR-DATA, 07 §3.3/§P1.7e-I) reuses quote_poll: like ohlcv_backfill /
  // financials it is source-scoped ({ sourceId }) and provider-agnostic — the handler loads the source,
  // resolves its securities_profile TaskSpec via runtime.tasksForSource (mubasher_profile provider for
  // TDWL, or a native ADX/MSX adapter), and runTask emits NormalizedProfile through the staging mapper
  // (PROFILE.SECURITY) → cross_check → fn_security_profile_project → public.securities. The runtime's
  // coverage guard (withProfileSymbols) chunks + idles it. No dedicated handler is needed.
  securities_profile: "quote_poll",
  filings_list: "filings_poll",
  // filing_detail: the event-driven PDF-download drain (gap #1 — this mapping did not exist, so
  // every filing_detail wake-up row failed with "no handler for data_type"). filings_detail_poll
  // drains the venue's pending seen_items → 'filings' bucket → public.filings + extract queue.
  filing_detail: "filings_detail_poll",
  eod_bulletin: "eod_sweep",
};

interface ClaimedJob {
  /** ingest.job_queue.id (bigint → string from postgres.js). */
  id: string;
  /** ingest.job_queue.source_id (bigint → string). */
  sourceId: string;
  venue: string;
  dataType: string;
  /** Venue-local current date (YYYY-MM-DD), computed in SQL for eod_sweep. */
  venueLocalDate: string | null;
}

export interface IngestPoller {
  /** Resolves when the loop has fully drained after stop() is called. */
  done: Promise<void>;
  stop(): void;
}

export function startIngestPoller(
  sql: Sql,
  config: WorkerConfig,
): IngestPoller {
  const log = rootLog.child({ poller: "ingest.job_queue", workerId: config.workerId });
  const concurrency = config.ingestConcurrency;
  const pollIntervalMs = config.ingestPollIntervalMs;
  let stopping = false;

  async function loop(): Promise<void> {
    log.info("ingest poller started", {
      concurrency,
      pollIntervalMs,
    });
    // N PERSISTENT LANES, each independently claiming and running ONE job at a
    // time. This replaces the previous "claim a batch → Promise.all the whole
    // batch → claim the next batch" design, whose barrier let a single
    // long-running job (e.g. a deep OHLCV backfill streaming an entire venue) HOLD
    // the poller: no new work could be claimed until that marathon finished, so
    // every other due job — quotes, filings, other venues' backfills — piled up
    // as `queued` behind it (observed: 173 due rows stalled for 66 min behind one
    // ADX backfill). With independent lanes, a marathon occupies only its own lane
    // and the others keep claiming + running due work. Each `claimBatch(…, 1)` uses
    // FOR UPDATE SKIP LOCKED, so lanes never claim the same row. Backfill jobs are
    // separately kept short (chunked in the runtime), so no single job monopolises
    // a lane for long nor outlives the 15-min stuck-job reaper.
    const lanes = Array.from({ length: concurrency }, (_unused, i) => lane(i));
    await Promise.all(lanes);
    log.info("ingest poller drained");
  }

  /** One persistent worker lane: claim a single due job and run it, repeat. Idle-sleeps
   *  a tick when nothing is due; backs off on a claim error without dying. Claims with
   *  limit 1 (FOR UPDATE SKIP LOCKED) so lanes never collide; runs every row the claim
   *  returns (≤1 from the DB, but robust if a claim yields several) before re-claiming. */
  async function lane(laneId: number): Promise<void> {
    const laneLog = log.child({ lane: laneId });
    while (!stopping) {
      let jobs: ClaimedJob[];
      try {
        jobs = await claimBatch(sql, config.workerId, 1);
      } catch (err) {
        if (stopping) return;
        laneLog.error("ingest claim failed", { err });
        await sleep(pollIntervalMs);
        continue;
      }
      if (stopping) return;
      if (jobs.length === 0) {
        await sleep(pollIntervalMs); // nothing due — wait a tick
        continue;
      }
      for (const job of jobs) {
        if (stopping) return;
        await runClaimedJob(job);
      }
    }
  }

  /** Run one claimed job through its handler and mark the row terminal. */
  async function runClaimedJob(job: ClaimedJob): Promise<void> {
    const jobLog = log.child({
      jobId: job.id,
      sourceId: job.sourceId,
      venue: job.venue,
      dataType: job.dataType,
    });

    // Unknown data_type: no handler services it. Mark 'failed' with an
    // explanatory error (NOT retried — requeue_stuck_jobs only reclaims
    // 'running' rows, and this row is terminal) so it can never re-claim or loop.
    const handlerName = DATA_TYPE_TO_HANDLER[job.dataType];
    if (!handlerName) {
      jobLog.warn("no handler for job data_type; marking failed", { dataType: job.dataType });
      await finishJob(sql, job.id, "failed", `no handler for data_type '${job.dataType}'`);
      return;
    }

    const handler = resolveHandler(handlerName);
    if (!handler) {
      // Handlers register at boot before the poller starts, so this is a wiring
      // bug, not an expected envelope. Fail the row loudly.
      jobLog.error("handler not registered; marking failed", { handlerName });
      await finishJob(sql, job.id, "failed", `handler '${handlerName}' not registered`);
      return;
    }

    const payload = buildPayload(job, handlerName, jobLog);
    if (!payload) {
      // eod_sweep needs a venue-local date we could not compute — skip cleanly.
      await finishJob(sql, job.id, "skipped_closed", "could not derive tradeDate for eod_sweep");
      return;
    }

    const ctx: HandlerContext = {
      sql,
      log: jobLog,
      config,
      // The job_queue path is the ingest cadence surface, not a pgmq queue; label
      // it so handler logs/heartbeats can distinguish claim-loop runs.
      queue: "ingest.job_queue",
      msgId: job.id,
      readCt: 0,
    };

    try {
      await handler(payload, ctx);
      await finishJob(sql, job.id, "ok", null);
      jobLog.info("ingest job done", { handler: handlerName });
    } catch (err) {
      // The handler already wrote its own fetch_log + per-venue heartbeat trail
      // on failure (see quote-poll.ts / filings-poll.ts / eod-sweep.ts). Here we
      // only mark the queue row terminal so it is not re-claimed. The error text
      // is recorded on the row for the Desk queue view.
      jobLog.error("ingest job failed", { handler: handlerName, err });
      await finishJob(sql, job.id, "failed", errText(err));
    }
  }

  const done = loop().catch((err) => {
    log.error("ingest poller loop crashed", { err });
    throw err;
  });

  return {
    done,
    stop(): void {
      stopping = true;
    },
  };
}

/**
 * Build the handler payload for a claimed job. quote_poll and filings_poll are
 * source-scoped ({ sourceId }); eod_sweep is venue-scoped and needs a tradeDate
 * — we use the venue-local current date claimed alongside the row (the handler's
 * own close-gate then decides whether it is actually inside the post-close
 * window). Returns null when a required field is missing.
 */
function buildPayload(
  job: ClaimedJob,
  handlerName: string,
  jobLog: HandlerContext["log"],
): Record<string, unknown> | null {
  const sourceIdNum = Number(job.sourceId);
  switch (handlerName) {
    case "quote_poll":
      return { handler: "quote_poll", sourceId: sourceIdNum };
    case "filings_poll":
      return { handler: "filings_poll", sourceId: sourceIdNum };
    case "filings_detail_poll":
      return { handler: "filings_detail_poll", sourceId: sourceIdNum };
    case "eod_sweep": {
      if (!job.venueLocalDate) {
        jobLog.warn("eod_sweep job has no venue-local date; skipping");
        return null;
      }
      return { handler: "eod_sweep", venue: job.venue, tradeDate: job.venueLocalDate };
    }
    default:
      return null;
  }
}

/**
 * Atomically claim up to `limit` DUE queued jobs for this worker.
 *
 * The inner SELECT ... FOR UPDATE SKIP LOCKED locks only rows no other worker is
 * touching, ordered by (priority, run_after) to match the partial claim index
 * (job_queue_claim_idx, 0005). The outer UPDATE flips them to 'running' and
 * stamps claimed_by/claimed_at in the SAME statement, so a row is claimed exactly
 * once even with N concurrent workers. The join to ingest.sources returns the
 * venue + data_type the poller needs to pick the handler, plus the venue-local
 * date for eod_sweep (computed the same way eodCloseGate reads the venue tz).
 */
async function claimBatch(sql: Sql, workerId: string, limit: number): Promise<ClaimedJob[]> {
  const rows = (await sql`
    with claimed as (
      select jq.id, jq.source_id
      from ingest.job_queue jq
      where jq.status = 'queued'
        and jq.run_after <= now()
      order by jq.priority, jq.run_after
      for update skip locked
      limit ${limit}
    )
    update ingest.job_queue jq
      set status = 'running',
          claimed_by = ${workerId},
          claimed_at = now()
    from claimed c
    join ingest.sources s on s.id = c.source_id
    left join public.venues v on v.code = s.venue
    where jq.id = c.id
    returning
      jq.id::text                                         as id,
      jq.source_id::text                                  as source_id,
      s.venue                                             as venue,
      s.data_type                                         as data_type,
      to_char((now() at time zone v.timezone)::date, 'YYYY-MM-DD') as venue_local_date
  `) as unknown as Array<{
    id: string;
    source_id: string;
    venue: string;
    data_type: string;
    venue_local_date: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    venue: r.venue,
    dataType: r.data_type,
    venueLocalDate: r.venue_local_date,
  }));
}

type TerminalStatus = "ok" | "failed" | "skipped_closed";

/**
 * Mark a claimed row terminal (+ finished_at). Best-effort: a failure to update
 * the row must not crash the loop — requeue_stuck_jobs reclaims any row left in
 * 'running' after 15 min, so a lost terminal write self-heals into a retry.
 *
 * `error` is written into ingest.job_queue.error when present. NOTE: the live
 * 0005 job_queue DDL has no `error` column; the update below sets it
 * conditionally and tolerates its absence so it works whether or not a later
 * migration adds one.
 */
async function finishJob(
  sql: Sql,
  jobId: string,
  status: TerminalStatus,
  error: string | null,
): Promise<void> {
  try {
    await sql`
      update ingest.job_queue
        set status = ${status},
            finished_at = now()
      where id = ${jobId}::bigint
        and status = 'running'
    `;
  } catch (err) {
    rootLog.warn("failed to mark ingest job terminal", { jobId, status, err });
  }
  // The error string is intentionally not persisted onto job_queue here: the
  // live DDL has no error column and the handler already recorded the failure in
  // ingest.fetch_log + ops.job_heartbeats. Kept in the signature + log so the
  // Desk trail is complete and a future error column is a one-line change.
  if (error) {
    rootLog.info("ingest job terminal", { jobId, status, error: error.slice(0, 500) });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

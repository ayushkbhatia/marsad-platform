import type { Handler, HandlerContext } from './index.js';
import type {
  IngestionRuntime,
  FilingDetailTarget,
  FilingPdfResult,
} from './ingestion-runtime.js';
import type { FilingsDetailPollPayload } from './payloads.js';
import { resolveActiveAgent, AgentPausedError } from './identity.js';
import { logFetchFailure, logFetchSkipped } from './fetch-log.js';
import { heartbeatRun, heartbeatOk, heartbeatError } from './job-heartbeat.js';

/**
 * filings_detail_poll (CONTRACT §8/§9) — the event-driven filing_detail drain.
 *
 * The chain: filings_poll records each genuinely-new announcement as a pending ingest.seen_items row
 * (carrying its detail/pdf URL) and enqueues a priority-1 job_queue row against the venue's
 * filing_detail source. The poller routes that row here. This handler:
 *   1. Loads a CHUNK of the venue's pending seen_items (oldest-first, capped) — the per-announcement
 *      fetch targets, recorded against the LIST source.
 *   2. Hands them to runtime.fetchFilingPdfs, which downloads each PDF and stores it in the public
 *      'filings' bucket content-addressed by sha256 (seating WAF cookies once per chunk).
 *   3. For each stored PDF: upsert the public.filings linkage (pdf_storage_key + pdf_sha256), enqueue
 *      an ops.filing_extract_queue placeholder keyed by content sha256 (the seam the later extraction
 *      service drains), and flip the seen_items row to 'fetched'. A miss flips it to 'nopdf'/'failed'
 *      (both terminal — no re-drain, no poison).
 *   4. Self-chains a follow-up wake-up when a full chunk was drained, so a burst of new announcements
 *      is worked in bounded chunks (per-host budget + quote lanes protected), never one giant job.
 *
 * Crash-safety is by idempotency, not one cross-boundary tx: the PDF upload is content-addressed
 * (re-upload = upsert no-op), the filings upsert is on (venue_code, source_ref), the extract-queue
 * insert is ON CONFLICT (content_sha256) DO NOTHING, and a target left 'pending' after a crash is
 * simply re-drained on the next wake-up.
 */

/** Max announcements drained per run — keeps each job short so a burst never starves quote lanes. */
const DETAIL_CHUNK_SIZE = 10;

interface PendingRow {
  /** ingest.seen_items.source_id — the LIST source the announcement was recorded against. */
  source_id: string;
  external_id: string;
  detail_url: string | null;
  pdf_url: string | null;
  title: string | null;
  /** ISO-8601 text (to_char'd in SQL — never a JS Date; postgres.js Date trap). */
  filed_at: string | null;
}

export function makeFilingsDetailPoll(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as FilingsDetailPollPayload;
    const sourceId = payload.sourceId;
    if (typeof sourceId !== 'number') {
      throw new Error(`filings_detail_poll: missing/invalid sourceId: ${JSON.stringify(payloadRaw)}`);
    }
    const log = ctx.log.child({ handler: 'filings_detail_poll', sourceId });
    const startedAt = Date.now();

    let source;
    try {
      source = await runtime.loadSource(sourceId);
    } catch (err) {
      await logFetchFailure(ctx.sql, sourceId, err, Date.now() - startedAt);
      throw err;
    }

    await heartbeatRun(ctx.sql, 'filings_detail_poll', source.venue);

    if (!source.active) {
      log.warn('detail source inactive; skipping filings_detail_poll', { venue: source.venue });
      await logFetchSkipped(ctx.sql, sourceId, 'source_inactive');
      await heartbeatOk(ctx.sql, 'filings_detail_poll', source.venue);
      return;
    }

    // Filings run as DATA-FILINGS regardless of venue (kill-switch honored before any fetch).
    let identity;
    try {
      identity = await resolveActiveAgent(ctx.sql, runtime.agentAccountForSource(source));
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('filings_detail_poll skipped: agent paused');
        await logFetchSkipped(ctx.sql, sourceId, 'agent_paused');
        await heartbeatOk(ctx.sql, 'filings_detail_poll', source.venue);
        return;
      }
      await logFetchFailure(ctx.sql, sourceId, err, Date.now() - startedAt);
      throw err;
    }

    // Pending drain targets for this venue (recorded against the LIST source by filings_poll),
    // oldest-first, capped to one chunk. filed_at is to_char'd to ISO text (postgres.js Date trap).
    const pending = (await ctx.sql`
      select si.source_id::text                                        as source_id,
             si.external_id                                            as external_id,
             si.detail_url                                             as detail_url,
             si.pdf_url                                                as pdf_url,
             si.title                                                  as title,
             to_char(si.filed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as filed_at
        from ingest.seen_items si
        join ingest.sources ls on ls.id = si.source_id
       where ls.venue = ${source.venue}
         and ls.data_type = 'filings_list'
         and si.detail_state = 'pending'
       order by si.first_seen asc
       limit ${DETAIL_CHUNK_SIZE}
    `) as unknown as PendingRow[];

    if (pending.length === 0) {
      log.info('no pending filing details to drain', { venue: source.venue });
      await logFetchSkipped(ctx.sql, sourceId, 'no_pending_details');
      await heartbeatOk(ctx.sql, 'filings_detail_poll', source.venue);
      return;
    }

    const targets: FilingDetailTarget[] = pending.map((p) => ({
      externalId: p.external_id,
      detailUrl: p.detail_url,
      pdfUrl: p.pdf_url,
      title: p.title,
      filedAt: p.filed_at,
    }));

    let results: FilingPdfResult[];
    try {
      results = await runtime.fetchFilingPdfs({
        source,
        targets,
        agentPrincipalId: identity.principalId,
      });
    } catch (err) {
      await logFetchFailure(ctx.sql, sourceId, err, Date.now() - startedAt);
      await heartbeatError(ctx.sql, 'filings_detail_poll', source.venue, err);
      throw err;
    }

    const pendingByExt = new Map(pending.map((p) => [p.external_id, p]));
    let fetched = 0;
    let failed = 0;
    let nopdf = 0;

    for (const r of results) {
      const p = pendingByExt.get(r.externalId);
      if (!p) continue;
      const listSourceId = Number(p.source_id);

      if (r.ok && r.storageKey && r.sha256) {
        try {
          await linkFiling(ctx.sql, source.venue, p, r);
          await ctx.sql`
            update ingest.seen_items set detail_state = 'fetched'
             where source_id = ${listSourceId}::bigint and external_id = ${r.externalId}
          `;
          fetched++;
        } catch (err) {
          // Leave 'pending' → re-drained next wake-up (upload + queue inserts are idempotent).
          log.error('filing detail linkage failed; leaving pending', { externalId: r.externalId, err });
          failed++;
        }
      } else {
        // Distinguish a benign no-attachment announcement ('nopdf') from a real fetch error
        // ('failed'). Both are terminal — the row leaves the pending set either way (no poison).
        const isNoPdf = /no pdf|no pdfurl|no detail|has no detailurl/i.test(r.error ?? '');
        const state = isNoPdf ? 'nopdf' : 'failed';
        if (isNoPdf) nopdf++;
        else failed++;
        await ctx.sql`
          update ingest.seen_items set detail_state = ${state}
           where source_id = ${listSourceId}::bigint and external_id = ${r.externalId}
        `;
      }
    }

    // Summary fetch_log row for the detail source (changed = at least one PDF landed).
    try {
      await ctx.sql`
        insert into ingest.fetch_log (source_id, http_status, changed, duration_ms, error)
        values (${sourceId}::bigint, 200, ${fetched > 0}, ${Date.now() - startedAt},
                ${failed > 0 ? `${failed} detail fetch(es) failed` : null})
      `;
    } catch {
      /* best effort */
    }

    await heartbeatOk(ctx.sql, 'filings_detail_poll', source.venue);

    // Self-chain when a FULL chunk was drained (more likely remain). The 2-min cooldown paces the
    // fan-out so the per-host ≤1 req/s budget holds and the continuous-lane poller keeps servicing
    // quotes/other venues between chunks.
    const maybeMore = pending.length === DETAIL_CHUNK_SIZE;
    if (maybeMore) {
      try {
        await ctx.sql`
          insert into ingest.job_queue (source_id, priority, run_after, status)
          values (${sourceId}::bigint, 1, now() + interval '2 minutes', 'queued')
        `;
      } catch (err) {
        log.warn('failed to self-chain filings_detail_poll follow-up', { err });
      }
    }

    log.info('filings_detail_poll done', {
      venue: source.venue,
      pending: pending.length,
      fetched,
      failed,
      nopdf,
      selfChained: maybeMore,
    });
  };
}

/**
 * Upsert the public.filings linkage for one stored PDF and enqueue its extraction placeholder, in a
 * single tx. The filings row may already exist (0037 FILING.REF projection ran first) or not (the
 * detail beat the cross-check sweep) — the upsert on (venue_code, source_ref) handles both: it INSERTs
 * a self-sufficient row (title/filed_at/type from the seen_items ref) or UPDATEs only the pdf linkage
 * on an existing one (never clobbering a title/type the projection set). content_sha256 is UNIQUE so
 * the extract enqueue is idempotent.
 */
async function linkFiling(
  sql: HandlerContext['sql'],
  venue: string,
  p: PendingRow,
  r: FilingPdfResult,
): Promise<void> {
  const title = p.title && p.title.trim() !== '' ? p.title : p.external_id;
  await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into public.filings
        (venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key, pdf_sha256)
      values (${venue}, ${p.external_id},
              public.fn_classify_filing_type(${p.title}),
              ${title},
              coalesce(${p.filed_at}::timestamptz, now()),
              ${r.storageKey!}, ${r.sha256!})
      on conflict (venue_code, source_ref) do update
        set pdf_storage_key = excluded.pdf_storage_key,
            pdf_sha256      = excluded.pdf_sha256
      returning id::text as id
    `) as unknown as Array<{ id: string }>;
    const filingId = rows[0]?.id ?? null;

    // Untargeted ON CONFLICT: since PE.0 the queue carries TWO unique indexes — content_sha256
    // (bytes) and pdf_storage_key (the stored object). Both are real identities and neither
    // subsumes the other: the same bytes are sometimes archived under two keys. Naming one index
    // here would let a collision on the other raise inside the filing tx.
    await tx`
      insert into ops.filing_extract_queue
        (filing_id, venue_code, source_ref, content_sha256, pdf_storage_key, content_type)
      values (${filingId}::bigint, ${venue}, ${p.external_id}, ${r.sha256!}, ${r.storageKey!},
              ${r.contentType ?? null})
      on conflict do nothing
    `;
  });
}

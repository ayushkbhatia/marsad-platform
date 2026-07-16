import type { Sql } from '../db.js';
import type { Handler, HandlerContext } from './index.js';

/**
 * storage_purge (q_maintenance) — the Storage-API consumer for
 * ops.storage_purge_queue (migration 20260715185413, 02 §3/§20).
 *
 * The daily retention job (ops.apply_retention, pg_cron `30 1 * * *`) nulls the
 * blob pointers on aged-out lake.snapshots and enqueues every freed lake-raw
 * Storage path into ops.storage_purge_queue — because Postgres CANNOT delete the
 * backing Storage object itself (a plain SQL delete would orphan the file, per
 * the Supabase "Delete Objects" guidance). Without a consumer the object leaks
 * in the bucket forever once purges start firing (~2026-10-11: oldest snapshot
 * 2026-07-13 + 90 d). This handler drains the queue: claim a bounded batch of
 * un-deleted paths, delete them via the Storage API (service-role), stamp
 * deleted_at, repeat. A `storage_purge` pg_cron enqueues {"task":"storage_purge"}
 * to q_maintenance shortly after retention; the consumer aliases `task`→`handler`.
 *
 * Safeguards (worker-agent playbook):
 *   - Bounded work per message: at most MAX_BATCHES batches of BATCH_LIMIT paths
 *     (default 25 × 200 = 5 000 objects). A larger backlog self-chains one more
 *     storage_purge message (COOLDOWN_S delay) rather than running unbounded
 *     under the 600 s visibility timeout.
 *   - Set-based writes: one bulk Storage DELETE per bucket per batch, one
 *     set-based UPDATE ... where storage_path = any(...) to stamp.
 *   - Idempotent / 404-tolerant: the Storage bulk delete silently omits objects
 *     that are already gone (no error), and the stamping UPDATE is guarded by
 *     `deleted_at is null`, so a re-run or an overlapping message is harmless.
 *     Rows are only stamped AFTER a 2xx delete, so a failed delete leaves them
 *     queued for the next run.
 */

const JOB_NAME = 'storage_purge';
const EXPECTED_INTERVAL_S = 24 * 60 * 60;

/** Paths deleted per Storage API call. Supabase caps `remove` at 1000/call. */
const DEFAULT_BATCH_LIMIT = 200;
const MAX_BATCH_LIMIT = 1000;
/** Batches drained per message before self-chaining a follow-up (bounded work). */
const DEFAULT_MAX_BATCHES = 25;
/** Cooldown before a self-chained follow-up becomes visible. */
const COOLDOWN_S = 5;

interface StoragePurgePayload {
  handler?: 'storage_purge';
  /** Paths per Storage delete call (clamped 1..1000). */
  limit?: number;
  /** Batches drained before self-chaining (bounds work per message). */
  maxBatches?: number;
}

interface QueueRow {
  storage_path: string;
  bucket: string;
}

/**
 * Minimal HTTP seam so the unit tests exercise the drain/stamp/self-chain logic
 * with no live Storage round-trip (mirrors ingestion core/storage.ts).
 */
export interface StorageDeleteTransport {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; text(): Promise<string> }>;
}

const defaultTransport: StorageDeleteTransport = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: () => res.text() };
};

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(n, MAX_BATCH_LIMIT);
}

function clampMaxBatches(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BATCHES;
  return n;
}

export function makeStoragePurge(deps: { transport?: StorageDeleteTransport } = {}): Handler {
  const transport = deps.transport ?? defaultTransport;

  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as StoragePurgePayload;
    const batchLimit = clampLimit(payload.limit);
    const maxBatches = clampMaxBatches(payload.maxBatches);
    const log = ctx.log.child({ handler: JOB_NAME });

    const { supabaseUrl, supabaseServiceRoleKey } = ctx.config;
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      // Misconfiguration, not a per-message fault: a throw here would redeliver
      // (and eventually incident) every visibility timeout. Surface it via the
      // heartbeat instead and leave the rows queued for a correctly-configured run.
      const err = new Error(
        'storage_purge skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured',
      );
      log.error(err.message);
      await heartbeatError(ctx.sql, err);
      return;
    }
    const base = supabaseUrl.replace(/\/+$/, '');

    await heartbeatRun(ctx.sql);
    try {
      let totalDeleted = 0;
      let batches = 0;
      let moreRemain = false;

      for (batches = 0; batches < maxBatches; batches++) {
        const rows = (await ctx.sql`
          select storage_path, bucket
          from ops.storage_purge_queue
          where deleted_at is null
          order by enqueued_at
          limit ${batchLimit}
        `) as unknown as QueueRow[];

        if (rows.length === 0) break;

        // One bulk Storage DELETE per bucket (the endpoint is per-bucket). In
        // practice every row is 'lake-raw', but the column is authoritative.
        const byBucket = new Map<string, string[]>();
        for (const row of rows) {
          const list = byBucket.get(row.bucket) ?? [];
          list.push(row.storage_path);
          byBucket.set(row.bucket, list);
        }

        const stamped: string[] = [];
        for (const [bucket, paths] of byBucket) {
          await deleteObjects(transport, base, supabaseServiceRoleKey, bucket, paths);
          stamped.push(...paths);
        }

        // Set-based stamp of everything the Storage API accepted this batch. The
        // `deleted_at is null` guard keeps an overlapping run idempotent.
        await ctx.sql`
          update ops.storage_purge_queue
             set deleted_at = now()
           where storage_path = any(${ctx.sql.array(stamped)}::text[])
             and deleted_at is null
        `;

        totalDeleted += stamped.length;

        // A short batch means the queue drained; a full batch on the last
        // allowed iteration means more may remain, so self-chain.
        if (rows.length < batchLimit) break;
        if (batches + 1 >= maxBatches) {
          moreRemain = true;
          break;
        }
      }

      if (moreRemain) {
        // Self-chain one follow-up with a cooldown so a large backlog drains
        // across bounded messages instead of one over-long run.
        await ctx.sql`
          select pgmq.send(
            'q_maintenance',
            ${ctx.sql.json({ handler: JOB_NAME })},
            ${COOLDOWN_S}
          )
        `;
      }

      await heartbeatOk(ctx.sql);
      log.info('storage_purge done', { objectsDeleted: totalDeleted, batches, moreRemain });
    } catch (err) {
      await heartbeatError(ctx.sql, err);
      throw err;
    }
  };
}

/**
 * Bulk-delete objects from a private bucket via the Storage API (service-role).
 * Maps to supabase-js `.remove(paths)`:
 *   DELETE {url}/storage/v1/object/{bucket}  body {"prefixes": [...]}
 * Objects already absent are silently omitted from the response (no error), so a
 * 2xx means every listed path is gone — exactly the 404-as-success we want.
 */
async function deleteObjects(
  transport: StorageDeleteTransport,
  base: string,
  serviceRoleKey: string,
  bucket: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const url = `${base}/storage/v1/object/${bucket}`;
  const res = await transport(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  });
  if (res.status >= 300) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `storage_purge delete failed (${res.status}) on ${bucket} for ${paths.length} paths: ${detail.slice(0, 500)}`,
    );
  }
}

// ── heartbeat (single global job, not venue-keyed) ───────────────────────────
// Mirrors ohlcv-accrual.ts: self-registers ops.job_heartbeats on first run so the
// sentinel learns the job without a seed row (which would false-incident before
// first fire). Best-effort — a heartbeat write never masks the actual work.

async function heartbeatRun(sql: Sql): Promise<void> {
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now())
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s, last_run_at = now()
    `;
  } catch {
    /* best effort — never mask the job */
  }
}

async function heartbeatOk(sql: Sql): Promise<void> {
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at, consecutive_failures)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now(), now(), 0)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(), last_ok_at = now(),
            last_error = null, consecutive_failures = 0
    `;
  } catch {
    /* best effort */
  }
}

async function heartbeatError(sql: Sql, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_error, consecutive_failures)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now(), ${message}, 1)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(), last_error = ${message},
            consecutive_failures = ops.job_heartbeats.consecutive_failures + 1
    `;
  } catch {
    /* best effort */
  }
}

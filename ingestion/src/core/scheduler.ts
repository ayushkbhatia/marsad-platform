import type { Sql } from './db.js';
import type { Logger } from './types.js';

/**
 * Scheduler reference (§5). The scheduler IS SQL and already applied (0005):
 * pg_cron ingest-tick calls ingest.enqueue_due_jobs(); the VPS worker claims
 * ingest.job_queue rows with FOR UPDATE SKIP LOCKED. This module is the thin TS
 * surface the worker uses to drive that SQL — NOT a reimplementation.
 *
 *   - triggerEnqueueDueJobs(): manual/testing hook to run enqueue now.
 *   - venueIsOpen(): calendar/session gate wrapper (holiday + trading_days aware).
 *   - claimNextJob() / finishJob(): the poller's claim + completion cycle.
 *   - requeueStuckJobs(): dead 'running' reclaim (queue-reaper).
 */

export interface ClaimedJob {
  id: number;
  sourceId: number;
  priority: number;
  runAfter: string;
}

/** Run ingest.enqueue_due_jobs() and return the number of rows enqueued. */
export async function triggerEnqueueDueJobs(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`select ingest.enqueue_due_jobs() as n`;
  return Number(rows[0]?.n ?? 0);
}

/** ingest.sweep_feed_status() — the single writer of public.venue_feed_status. */
export async function triggerSweepFeedStatus(sql: Sql): Promise<void> {
  await sql`select ingest.sweep_feed_status()`;
}

/**
 * Session/holiday gate wrapper (§5). Grace window defaults to the enqueue
 * window (−10 / +20 min) that catches opening/closing auctions.
 */
export async function venueIsOpen(
  sql: Sql,
  venue: string,
  opts?: { at?: string; graceBefore?: string; graceAfter?: string },
): Promise<boolean> {
  const at = opts?.at ?? new Date().toISOString();
  const graceBefore = opts?.graceBefore ?? '0';
  const graceAfter = opts?.graceAfter ?? '0';
  const rows = await sql<{ open: boolean }[]>`
    select ingest.venue_is_open(
      ${venue}, ${at}::timestamptz,
      ${graceBefore}::interval, ${graceAfter}::interval
    ) as open
  `;
  return rows[0]?.open ?? false;
}

/**
 * Claim the next due job from ingest.job_queue with FOR UPDATE SKIP LOCKED
 * (0005): status queued→running, stamp claimed_by/claimed_at. Only claims rows
 * whose run_after has arrived, highest priority (lowest number) + oldest first.
 */
export async function claimNextJob(
  sql: Sql,
  workerId: string,
): Promise<ClaimedJob | null> {
  const rows = await sql<
    { id: number; source_id: number; priority: number; run_after: string }[]
  >`
    with next as (
      select id
        from ingest.job_queue
       where status = 'queued' and run_after <= now()
       order by priority asc, run_after asc
       for update skip locked
       limit 1
    )
    update ingest.job_queue jq
       set status = 'running', claimed_by = ${workerId}, claimed_at = now()
      from next
     where jq.id = next.id
    returning jq.id, jq.source_id, jq.priority, jq.run_after
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    priority: r.priority,
    runAfter: r.run_after,
  };
}

export type JobOutcome = 'ok' | 'failed' | 'skipped_closed';

/** Mark a claimed job finished (0005 status set). */
export async function finishJob(
  sql: Sql,
  jobId: number,
  outcome: JobOutcome,
): Promise<void> {
  await sql`
    update ingest.job_queue
       set status = ${outcome}, finished_at = now()
     where id = ${jobId}
  `;
}

/** Reclaim dead 'running' rows older than p_age (queue-reaper). Returns count. */
export async function requeueStuckJobs(sql: Sql, age = '15 minutes'): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select ingest.requeue_stuck_jobs(${age}::interval) as n
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * §10 adaptive cadence: after 3 consecutive failed runs, double a source's
 * schedule cadence (cap 4×) until a success. Reads consecutive_failures from
 * ingest.sources. This is a TS helper the worker may call; the base multiplier
 * is 1 (no change) below the threshold.
 */
export function cadenceMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures < 3) return 1;
  const doublings = Math.min(2, consecutiveFailures - 2); // 3→2×, 4→4×, cap 4×
  return Math.min(4, 2 ** doublings);
}

export function logSchedulerTick(logger: Logger, enqueued: number): void {
  logger.info('scheduler tick', { enqueued });
}

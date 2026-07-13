import type { Sql } from '../db.js';
import type { VenueCode } from './ingestion-runtime.js';

/**
 * Per-source / per-venue liveness heartbeats into ops.job_heartbeats
 * (CONTRACT §9; 0005 DDL job_heartbeats).
 *
 * The consumer (consumer.ts) records only a QUEUE-level heartbeat
 * ('worker:q_ingest') around every message. That is too coarse for feed
 * freshness: all six venues' quote_poll runs share the one queue heartbeat, so
 * one venue going dark (e.g. TDWL 403ing indefinitely) is masked by the other
 * five venues' successes and ops.heartbeat_sentinel never fires for it.
 *
 * These handlers therefore own a SPECIFIC per-venue/per-source heartbeat row so
 * a single silent feed is detected: `ops.heartbeat_sentinel` raises an
 * ops.incidents row when a job_name is silent past 2× expected_interval_s.
 *
 * job_name convention (CONTRACT §9 example): 'ingest:<handler>:<venue>', e.g.
 * 'ingest:quote_poll:TDWL'. expected_interval_s comes from the schedule cadence
 * for the data type so the sentinel's 2× window matches the feed's real rhythm.
 *
 * All writes are best-effort: a heartbeat upsert must never mask the real job
 * error or abort the handler — the sentinel catching silence IS the alert path
 * if the DB is unreachable.
 */

/** Nominal schedule cadence (seconds) per handler, from ingest.schedules (0017). */
const EXPECTED_INTERVAL_S = {
  quote_poll: 10 * 60, // quotes cadence 10 min (session-only)
  filings_poll: 5 * 60, // filings_list cadence 5 min
  eod_sweep: 60 * 60, // eod_bulletin coarse cadence 60 min
} as const;

export type IngestJobKind = keyof typeof EXPECTED_INTERVAL_S;

/** The per-venue heartbeat job_name for an ingestion handler run. */
export function ingestJobName(kind: IngestJobKind, venue: VenueCode): string {
  return `ingest:${kind}:${venue}`;
}

/**
 * Upsert a per-venue heartbeat row marking a run just started (or is running).
 * Sets last_run_at only, so a run that later fails still leaves a fresh
 * last_run_at (silence — not failure — is what the sentinel keys on). Call at
 * the top of a handler once the venue is known.
 */
export async function heartbeatRun(
  sql: Sql,
  kind: IngestJobKind,
  venue: VenueCode,
): Promise<void> {
  const jobName = ingestJobName(kind, venue);
  const expected = EXPECTED_INTERVAL_S[kind];
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
      values (${jobName}, ${expected}, now())
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now()
    `;
  } catch {
    /* best effort — never mask the job */
  }
}

/** Upsert a successful run: resets consecutive_failures, clears last_error. */
export async function heartbeatOk(
  sql: Sql,
  kind: IngestJobKind,
  venue: VenueCode,
): Promise<void> {
  const jobName = ingestJobName(kind, venue);
  const expected = EXPECTED_INTERVAL_S[kind];
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at, consecutive_failures)
      values (${jobName}, ${expected}, now(), now(), 0)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(),
            last_ok_at = now(),
            last_error = null,
            consecutive_failures = 0
    `;
  } catch {
    /* best effort */
  }
}

/** Upsert a failed run: records last_error and bumps consecutive_failures. */
export async function heartbeatError(
  sql: Sql,
  kind: IngestJobKind,
  venue: VenueCode,
  error: unknown,
): Promise<void> {
  const jobName = ingestJobName(kind, venue);
  const expected = EXPECTED_INTERVAL_S[kind];
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_error, consecutive_failures)
      values (${jobName}, ${expected}, now(), ${message}, 1)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(),
            last_error = ${message},
            consecutive_failures = ops.job_heartbeats.consecutive_failures + 1
    `;
  } catch {
    /* best effort */
  }
}

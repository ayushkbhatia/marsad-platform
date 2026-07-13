/**
 * Loop A writer — the code that gives ingest.sweep_feed_status() its signal
 * (01 §8). Every fetch outcome (success OR classified failure) lands in
 * ingest.fetch_log, and ingest.sources is advanced so the SQL sweep can compute
 * freshness from last_success_at / consecutive_failures.
 *
 * This COMPLEMENTS the SQL sweep — it never writes public.venue_feed_status.
 * It also does not touch last_content_hash / last_changed_at on a CHANGED
 * snapshot: those are owned by SnapshotStore.put() (CONTRACT §4 step 5), which
 * already advances last_success_at and resets consecutive_failures on a
 * successful change. To avoid double-writing, the FetchLogWriter is the writer
 * of record ONLY for the fetch_log row + the sources failure/success counters,
 * and SnapshotStore delegates its fetch_log + source-counter write here (or
 * calls recordSuccess after the store). See `SqlLike` for the minimal surface.
 *
 * Design so this is unit-testable with zero DB: it takes a tiny `SqlLike`
 * tagged-template executor (the postgres.js `Sql` satisfies it structurally),
 * and all decisions are pure and delegated to taxonomy.ts.
 */

import type { FetchError, FetchOutcome } from './types.js';
import { policyFor } from './taxonomy.js';

/**
 * Minimal structural view of postgres.js `Sql`: a tagged-template function that
 * returns a thenable of rows. Kept local so the freshness module compiles
 * standalone (no worker import) and is trivially mockable in tests.
 */
export interface SqlLike {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<T[]>;
}

export interface FetchLogWriter {
  /**
   * Record ONE completed fetch. On success: fetch_log(changed, duration) +
   * sources(last_success_at=now, consecutive_failures=0). On failure: fetch_log
   * with http_status/error + sources(consecutive_failures += 1). Never throws
   * on a fetch_log write failure — logging must not kill the job; it warns.
   */
  record(outcome: FetchOutcome): Promise<void>;
}

export interface FetchLogDeps {
  sql: SqlLike;
  /** ISO-UTC clock injected for testability (fetch_log.fetched_at defaults now()). */
  now?: () => Date;
  logger?: { warn(msg: string, x?: object): void };
}

/**
 * Format a FetchError into the compact `error` string persisted to
 * ingest.fetch_log.error and used by the Desk error queue. Shape:
 *   "<CLASS>[<status>]: <message>"  (truncated to 2000 chars)
 *
 * Reads the fields off the shared throwable `FetchError` class the transport
 * raises: `errorClass` + `status`.
 */
export function formatFetchError(error: FetchError): string {
  const status = error.status != null ? `[${error.status}]` : '';
  return `${error.errorClass}${status}: ${error.message}`.slice(0, 2000);
}

export function createFetchLogWriter(deps: FetchLogDeps): FetchLogWriter {
  const { sql } = deps;
  const warn = deps.logger?.warn?.bind(deps.logger) ?? (() => {});

  async function record(outcome: FetchOutcome): Promise<void> {
    const success = !outcome.error;
    const errText = outcome.error ? formatFetchError(outcome.error) : null;
    const httpStatus = outcome.httpStatus;

    try {
      // fetch_log is append-only; one row per completed fetch (01 §4.1).
      await sql`
        insert into ingest.fetch_log (source_id, http_status, changed, duration_ms, error)
        values (
          ${outcome.sourceId},
          ${httpStatus},
          ${outcome.changed},
          ${outcome.durationMs},
          ${errText}
        )
      `;
    } catch (err) {
      // Never let telemetry kill the job — the sweep's silence detector is the
      // backstop if fetch_log stops advancing.
      warn('fetch_log insert failed', { sourceId: outcome.sourceId, err });
    }

    try {
      if (success) {
        // Advance the freshness clock the sweep reads. This is idempotent with
        // SnapshotStore.put() on a CHANGED snapshot (both set last_success_at =
        // now, consecutive_failures = 0); on an UNCHANGED (deduped) fetch this
        // is the ONLY writer that advances last_success_at — critical so a venue
        // whose board is quiet off-peak does not drift to 'offline'.
        await sql`
          update ingest.sources
             set last_success_at = now(),
                 consecutive_failures = 0
           where id = ${outcome.sourceId}
        `;
      } else {
        await sql`
          update ingest.sources
             set consecutive_failures = consecutive_failures + 1
           where id = ${outcome.sourceId}
        `;
      }
    } catch (err) {
      warn('sources counter update failed', { sourceId: outcome.sourceId, err });
    }
  }

  return { record };
}

/**
 * Convenience: does this outcome escalate to the Desk/owner? True for quality
 * errors (HTTP_4XX, PARSE_DRIFT) per the class policy. The worker handler uses
 * this to decide whether to raise a Desk item / owner email in addition to the
 * fetch_log row.
 */
export function outcomeEscalates(outcome: FetchOutcome): boolean {
  return outcome.error ? policyFor(outcome.error.errorClass).escalate : false;
}

import type { Sql } from '../db.js';
import type { CrossCheckPayload } from './payloads.js';
import type { StagedKey } from './ingestion-runtime.js';

/**
 * Follow-up enqueue helpers (CONTRACT §9).
 *
 * Two distinct dispatch surfaces, and they are NOT the same thing (CONTRACT §9
 * note):
 *   - pgmq queues (q_pipeline, …) carry the event-driven / cross-cutting stages
 *     — cross_check runs here. Producers push a JSON body with a `handler` key.
 *   - ingest.job_queue is the cadence table the scheduler writes and the poller
 *     claims with FOR UPDATE SKIP LOCKED. filing_detail follow-ups are enqueued
 *     here at priority 1 (event-driven), keyed to the filing_detail source of
 *     the same venue.
 */

/** A JSON-serializable pgmq message body. */
type JsonBody = Record<string, string | number | boolean | null | undefined>;

/** pgmq send: push a job envelope onto a queue. */
export async function pgmqSend(sql: Sql, queue: string, body: JsonBody): Promise<void> {
  // pgmq.send(queue, msg jsonb) — the consumer reads {handler, ...payload}.
  await sql`select pgmq.send(${queue}, ${sql.json(body)})`;
}

/**
 * Enqueue a cross_check job for a staged natural key onto q_pipeline. Called
 * only when ≥2 independent sources stage the same key (the 2-source rule is
 * decided by the caller so a single-source key never spawns a no-op job).
 */
export async function enqueueCrossCheck(
  sql: Sql,
  key: StagedKey,
): Promise<void> {
  const payload: CrossCheckPayload = {
    handler: 'cross_check',
    naturalKey: key.naturalKey,
    objectType: key.objectType,
  };
  await pgmqSend(sql, 'q_pipeline', { ...payload });
}

/**
 * Enqueue event-driven filing_detail fetches for newly-seen announcement ids.
 *
 * Target resolution (CONTRACT §8 filing_detail, review fix): ingest.job_queue
 * (0005 DDL) has NO external_id/payload column, so N per-id rows against the
 * SAME (source_id, priority) are indistinguishable — a claimer could not tell
 * which announcement to fetch. The per-announcement targets therefore live in
 * ingest.seen_items, recorded against the LIST source with detail_state
 * 'pending'; the filing_detail fetcher DRAINS seen_items where
 * detail_state='pending' for the venue and flips each to 'fetched'/'failed'.
 *
 * We record the new ids as pending seen_items (idempotent on the PK
 * (source_id, external_id)), then enqueue ONE priority-1 job_queue row against
 * the venue's filing_detail source as a wake-up so the drain runs promptly
 * rather than waiting for the next scheduled tick. A single row (not N) keeps
 * the queue unambiguous: the job means "drain this venue's pending details",
 * and the ids it must fetch are exactly the pending seen_items.
 *
 * `detailSourceId` is the ingest.sources.id of this venue's filing_detail
 * source (resolved by the caller from the runtime); when the venue has no
 * filing_detail source configured we still record the pending seen_items but
 * skip the wake-up (nothing to fetch). Returns the number of new ids staged as
 * pending (0 when detailSourceId is null and there is nothing to drain later).
 */
export async function enqueueFilingDetails(
  sql: Sql,
  listSourceId: number,
  detailSourceId: number | null,
  externalIds: string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;

  // Record every id as seen (detail_state defaults to 'pending' per 0005 DDL)
  // against the LIST source — the list-diff state and the per-announcement
  // detail targets both live here. ON CONFLICT so re-listed ids are cheap and
  // an already-'fetched' id is not reset back to 'pending'.
  const staged = (await sql`
    insert into ingest.seen_items (source_id, external_id)
    select ${listSourceId}::bigint, x
    from unnest(${sql.array(externalIds)}::text[]) as t(x)
    on conflict (source_id, external_id) do nothing
    returning external_id
  `) as unknown as Array<{ external_id: string }>;

  if (detailSourceId === null) return staged.length;

  // Enqueue ONE wake-up row (priority 1) so the filing_detail fetcher drains the
  // venue's pending seen_items promptly. The unambiguous per-id targets are the
  // pending seen_items, NOT this row. Only enqueue when at least one genuinely
  // new id was staged (an all-duplicate re-list is a no-op).
  if (staged.length > 0) {
    await sql`
      insert into ingest.job_queue (source_id, priority, run_after)
      values (${detailSourceId}::bigint, 1, now())
    `;
  }

  return staged.length;
}

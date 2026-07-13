import type { Sql } from '../db.js';

/**
 * ingest.fetch_log writer (CONTRACT §5, §9).
 *
 * The ingestion runtime's SnapshotStore.put writes a fetch_log row for every
 * fetch it performs (changed true/false, duration_ms). Handlers write a
 * fetch_log row ONLY for failures that abort BEFORE the runtime's own logging
 * runs — e.g. loadSource failed, the agent kill switch tripped, or fetch threw
 * before a snapshot was attempted. This guarantees every job leaves a fetch_log
 * trail even when it never reaches the snapshot store, without double-counting
 * the runtime's own rows.
 */
export async function logFetchFailure(
  sql: Sql,
  sourceId: number,
  error: unknown,
  durationMs: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await sql`
      insert into ingest.fetch_log (source_id, http_status, changed, duration_ms, error)
      values (${sourceId}::bigint, null, false, ${Math.max(0, Math.round(durationMs))}, ${message.slice(0, 2000)})
    `;
  } catch {
    // fetch_log is a best-effort audit trail; never let it mask the real error.
  }
}

/**
 * A skipped_closed / kill-switch run still deserves a heartbeat trail row so the
 * freshness sweep and Desk can see the source was visited and intentionally not
 * fetched. changed=false, no error.
 */
export async function logFetchSkipped(
  sql: Sql,
  sourceId: number,
  reason: string,
): Promise<void> {
  try {
    await sql`
      insert into ingest.fetch_log (source_id, http_status, changed, duration_ms, error)
      values (${sourceId}::bigint, null, false, 0, ${`skipped: ${reason}`.slice(0, 2000)})
    `;
  } catch {
    /* best effort */
  }
}

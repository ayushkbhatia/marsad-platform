import "server-only";
import type { FreshnessBlock, VenueFeedState } from "@/lib/market/freshness";

/**
 * Internal helpers shared by the `src/lib/data/*` reader layer.
 *
 * NUMERIC COERCION: PostgREST can serialize Postgres `numeric` as a JSON string
 * to preserve precision, so quote/price fields may arrive as strings. Coerce
 * every numeric through `toNum` rather than trusting the wire type. (This is the
 * read-side twin of the postgres.js Date/numeric trap — we never string-compare
 * these, and we never do date math in JS; date filtering stays in the query.)
 */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

/** Row shape as read from public.venue_feed_status. */
export interface VenueFeedRow {
  venue_code: string;
  state: string;
  detail: string | null;
  last_sync_at: string | null;
  latency_ms: number | null;
}

/** Map a venue_feed_status row to the pulse `freshness` block. */
export function toFreshnessBlock(row: VenueFeedRow | null | undefined): FreshnessBlock | null {
  if (!row) return null;
  return {
    venue: row.venue_code,
    state: row.state as VenueFeedState,
    detail: row.detail ?? null,
    lastSync: row.last_sync_at ?? null,
    latencyMs: toInt(row.latency_ms),
  };
}

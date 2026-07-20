import type { FreshnessState } from "@/components/ui/FreshnessBadge";

/**
 * The freshness vocabulary the ingestion sweep writes to
 * `public.venue_feed_status.state` (CHECK-constrained). It is a SUPERSET of the
 * 6-state `FreshnessBadge` machine: the scraper also emits `closed` for a venue
 * outside trading hours, which the badge has no face for.
 */
export type VenueFeedState =
  | "live"
  | "reconnecting"
  | "delayed"
  | "offline"
  | "halted"
  | "auction"
  | "closed";

/**
 * The `freshness` block every `/api/pulse/*` payload embeds, sourced from
 * `public.venue_feed_status` (04-reader-app.md §4). `lastSync` is an ISO string
 * (PostgREST returns timestamps as strings, never JS Dates — never string-compare
 * it; treat it as opaque and let the badge's client timer decay against it).
 */
export interface FreshnessBlock {
  venue: string;
  state: VenueFeedState;
  detail: string | null;
  lastSync: string | null;
  /** Optional latency hint from venue_feed_status.latency_ms. */
  latencyMs?: number | null;
}

/**
 * Map a DB feed state onto the badge's 6-state machine.
 *
 * `closed` degrades to `delayed`: under scrape-only delayed data a closed venue
 * still shows its last delayed tier — NEVER `live` (S1 color law: red never
 * marks a feed failure, and we never claim live for a stale venue). Callers
 * should pass a `detail` like "CLOSED · SYNCED 15:10" so the closed reality is
 * still legible even though the dot reads delayed.
 */
export function toBadgeState(state: VenueFeedState | string | null | undefined): FreshnessState {
  switch (state) {
    case "live":
    case "reconnecting":
    case "delayed":
    case "offline":
    case "halted":
    case "auction":
      return state;
    case "closed":
      return "delayed";
    default:
      // Unknown/missing → degrade to delayed, never fabricate "live".
      return "delayed";
  }
}

/** True when a venue is actively trading (its feed is live/auction). */
export function isVenueTrading(state: VenueFeedState | string | null | undefined): boolean {
  return state === "live" || state === "auction" || state === "reconnecting";
}

/**
 * Given the freshness blocks in a pulse payload, is ANY relevant venue still
 * trading? Used by `usePulse` to keep polling only while at least one venue is
 * open — everything `closed`/`offline` means stop.
 */
export function anyVenueTrading(blocks: Array<Pick<FreshnessBlock, "state">>): boolean {
  return blocks.some((b) => isVenueTrading(b.state));
}

/**
 * Watchlist — view-model contract.
 *
 * CONTRACT LAYER (design 1h). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export type ScoreTier = "solid" | "outlined" | "muted";

export interface WatchList {
  name: string;
  count: number;
  selected?: boolean;
}

export interface WatchRow {
  ticker: string;
  name: string;
  /** Arabic company name (Noto Naskh Arabic). */
  nameAr: string;
  /** Formatted price incl. currency prefix, e.g. "SAR 27.15". */
  price: string;
  /** Day change %, signed. */
  chg1d: number;
  /** Week change %, signed. */
  chg1w: number;
  score: number;
  /** Drives the three badge treatments (design bakes the tier per row). */
  scoreTier: ScoreTier;
  /** Price-target upside %, signed. */
  ptUpside: number;
  /** Next scheduled event, e.g. "Q2 · TUE" or "—". */
  nextEvent: string;
  /** Alert armed for this name (filled bell) vs off (outline bell). */
  alertArmed: boolean;
  /** Stock-page venue segment for the row link. */
  venueCode: string;
}

export interface VenueGroup {
  /** Group header label, e.g. "TADAWUL — SAUDI ARABIA". */
  label: string;
  /** Right-side mono summary, e.g. "4 NAMES · +0.9% TODAY". */
  summary: string;
  rows: WatchRow[];
}

export interface StatCell {
  label: string;
  /** Rendered value; may carry a coloured span (see `page`). */
  value: string;
  /** Directional colour for the whole value (equal-weighted return). */
  dir?: "up" | "down";
}

export interface WatchAlert {
  ticker: string;
  /** Condition text, split so the emphasised middle renders bold. */
  conditionPre: string;
  conditionStrong: string;
  conditionPost: string;
  /** Delivery channel chip, e.g. "PUSH + EMAIL". */
  channel: string;
  /** "TRIGGERED 13:58" (solid chip) vs "ARMED" (outline chip). */
  triggeredAt?: string;
}

export interface WatchNote {
  ticker: string;
  date: string;
  note: string;
}

export interface WatchlistData {
  lists: WatchList[];
  alertCount: number;
  stats: StatCell[];
  best: { ticker: string; pct: string };
  worst: { ticker: string; pct: string };
  alertsTriggered: { count: number; names: string };
  groups: VenueGroup[];
  alerts: WatchAlert[];
  notes: WatchNote[];
}

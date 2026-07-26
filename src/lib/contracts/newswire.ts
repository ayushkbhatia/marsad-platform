/**
 * Newswire — view-model contract.
 *
 * CONTRACT LAYER (design 1d). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export type { Direction } from "./common";

export interface WireCategory {
  name: string;
  count: number;
  /** The one solid-ink selected row (design: "All items"). */
  selected?: boolean;
  href: string;
}

export interface WireVenue {
  name: string;
  count: number;
  /** Checkbox state (design: all pre-checked). */
  checked: boolean;
  /**
   * EXTENSION (P2.2). The real venue code (`TDWL`/`DFM`/…) behind the display
   * label, so a caller can key on identity rather than on the label string.
   */
  code?: string;
  /**
   * EXTENSION (P2.2). Toggle target — the same `/wire` URL with this venue
   * added to (or removed from) the filter. Absent → the row renders inert,
   * exactly as it did before this field existed.
   */
  href?: string;
}

export interface WireTicker {
  symbol: string;
  changePct: number;
}

export interface WireFeedItem {
  /** Clock time, e.g. "14:21". */
  time: string;
  /** Source/venue badge, e.g. "TDWL", "CBUAE". */
  venue: string;
  /** Category label, e.g. "DISCLOSURE", "MACRO". */
  category: string;
  headline: string;
  summary: string;
  tickers?: WireTicker[];
  /** The "DEVELOPING" variant: solid left border, tinted bg, bolder headline. */
  isDeveloping?: boolean;
  href: string;
  /**
   * EXTENSION (P2.2). Stable identity for the React key. Real filing titles
   * repeat heavily across the corpus ("Daily Net Asset Value / NAV" appears
   * 8× in one page of live rows), so `time + headline` is NOT unique on real
   * data. Absent → callers fall back to the old composite key.
   */
  id?: string;
  /**
   * EXTENSION (P2.2). Day-divider label to render immediately BEFORE this
   * item, e.g. "Sunday 26 July 2026". Set only on the first item of each day
   * group *after* the first (the first group is already labelled by
   * `NewswireData.dateLabel`). A real feed spans several days — Tadawul's
   * backfill reaches 2016 — so a single top-level date label would mis-date
   * every row below the fold.
   */
  dayLabel?: string;
}

export interface ExchangeFiling {
  time: string;
  venue: string;
  company: string;
  filingType: string;
  href: string;
  /** EXTENSION (P2.2). Stable identity for the React key — see `WireFeedItem.id`. */
  id?: string;
}

export interface CorporateAction {
  /** Short date, e.g. "8 JUL". */
  date: string;
  ticker: string;
  type: string;
}

export interface MostReadItem {
  rank: number;
  headline: string;
  href: string;
}

export interface FeedConnection {
  state: "live" | "reconnecting" | "delayed" | "offline";
  /** Right-aligned mono detail, e.g. "LAST SYNC 14:31:58 · RETRYING…". */
  detail: string;
  /** Banner message; only shown when state !== "live". */
  message?: string;
}

export interface NewswireData {
  categories: WireCategory[];
  venues: WireVenue[];
  todayCount: number;
  dateLabel: string;
  connection: FeedConnection;
  feed: WireFeedItem[];
  filings: ExchangeFiling[];
  corporateActions: CorporateAction[];
  mostRead: MostReadItem[];
  /**
   * EXTENSION (P2.2). Keyset-pagination target for "Load earlier items" —
   * the current URL carrying the next `?cursor=`. `null`/absent = no older
   * page, and the control renders inert (its pre-extension behaviour).
   */
  olderHref?: string | null;
}

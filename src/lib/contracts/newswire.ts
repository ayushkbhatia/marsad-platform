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
}

export interface ExchangeFiling {
  time: string;
  venue: string;
  company: string;
  filingType: string;
  href: string;
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
}

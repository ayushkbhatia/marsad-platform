/**
 * Ledger / Today (home) — view-model contract.
 *
 * CONTRACT LAYER (design 1b). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export type { Direction } from "./common";
import type { Direction } from "./common";

export interface LedgerIndex {
  /** Short index code, e.g. "TASI". */
  code: string;
  /** Full name, e.g. "Tadawul All Share". */
  name: string;
  /** Owning venue code (used for sort + venue label). */
  venueCode: string;
  /** Index level. */
  level: number;
  /** Signed percent change on the day. */
  changePct: number;
}

export interface LedgerLead {
  kicker: string;
  headline: string;
  dek: string;
  /** The editorial "take" pull-quote (rendered with the ink left-rule). */
  take: string;
  byline: string;
  /** Human relative time, e.g. "3h ago". */
  time: string;
  /** Read-length affordance, e.g. "READ — 12 MIN". */
  readLabel: string;
  href: string;
  /** Placeholder plate label for the lead photo. */
  photoLabel: string;
  /** Photo credit line under the plate. */
  photoCaption: string;
}

export interface LedgerStory {
  kicker: string;
  /** Human relative time, e.g. "5h ago" / "Today". */
  time: string;
  headline: string;
  dek: string;
  href: string;
  /** Opinion pieces render the headline in italic. */
  isOpinion?: boolean;
}

export interface AnalystCall {
  /** Rating/action label, e.g. "Overweight", "Hold → Buy". */
  action: string;
  /** Ticker or symbol shown top-right, e.g. "1120", "EMAAR". */
  symbol: string;
  /** Company display name. */
  name: string;
  /** Formatted price target, e.g. "PT SAR 112". */
  priceTarget: string;
  /** Context note, e.g. "from 104", "initiated", "upgraded". */
  note: string;
  analyst: string;
  href: string;
}

export interface MacroTicker {
  label: string;
  value: string;
  /** Change string, e.g. "-0.82%", "-2 bp", "pegged". */
  change: string;
  dir: Direction;
  /** Rendered as a muted (non-directional) note rather than pos/neg colour. */
  muted?: boolean;
  /** Paper-tint fill (the design highlights the pegged USDSAR cell). */
  tinted?: boolean;
}

export interface LiveMarkets {
  code: string;
  name: string;
  level: number;
  changePct: number;
  /** Whether the focus venue is open (drives the OPEN/CLOSED tag + colour). */
  open: boolean;
  dayHigh: string;
  dayLow: string;
  volume: string;
  /** Pre-normalised polyline points for the sparkline, in `spark` viewBox. */
  spark: { width: number; height: number; points: string };
  macro: MacroTicker[];
}

export interface WireItem {
  /** Clock time, e.g. "14:21". */
  time: string;
  /** Source/venue badge, e.g. "TDWL", "CBUAE". */
  source: string;
  summary: string;
  href: string;
}

export interface MoverRow {
  symbol: string;
  changePct: number;
  href: string;
}

export interface LedgerData {
  indices: LedgerIndex[];
  lead: LedgerLead;
  secondary: LedgerStory[];
  calls: AnalystCall[];
  live: LiveMarkets;
  wires: WireItem[];
  gainers: MoverRow[];
  losers: MoverRow[];
}

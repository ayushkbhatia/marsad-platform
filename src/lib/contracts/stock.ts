/**
 * Stock workspace — view-model contract.
 *
 * CONTRACT LAYER (design 3a-3d). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export interface StockHeader {
  breadcrumb: string[]; // ["Today","Tadawul","Energy · Integrated Oil & Gas"]
  ids: string; // "ISIN … · SEDOL … · LAST UPDATED 14:32 GST"
  name: string;
  nameAr: string;
  ticker: string;
  venueLabel: string; // "TADAWUL · SAR"
  score: { value: number; label: string }; // 76 · BUY
  links: string[]; // ["aramco.com ↗","Tadawul listing ↗"]
  price: string; // "27.15"
  currency: string; // "SAR"
  change: { value: string; up: boolean }; // "−0.17 (−0.62%)"
}

// ── Overview (3a) ────────────────────────────────────────────────────────────
export interface KeyRatio { label: string; value: string }
export interface Peer {
  ticker: string;
  company: string;
  price: string;
  pe: string;
  pb: string;
  yield: string;
  roe: string;
  evEbitda: string;
  mktCap: string;
  ytd: string;
  score: number;
  self?: boolean;
}
export interface Overview {
  keyRatios: KeyRatio[]; // 9
  chartTabs: string[]; // PRICE / P/E / SALES & MARGIN / EV/EBITDA / P/B
  chart: { areaPoints: string; linePoints: string; note: string };
  aboutHtml: string; // paragraph with [1]/[2] footnote markers rendered as sup
  keyPoints: string[];
  deskView: { quote: string; byline: string };
  pros: string[];
  cons: string[];
  prosConsNote: string;
  peers: Peer[];
  peersMedian: string;
  /** Real sector label for the peer-table header. Empty when unknown. */
  peersSector?: string;
}

// ── Financials (3b) ──────────────────────────────────────────────────────────
export interface StockFinRow { label: string; strong?: boolean; values: string[]; pdf?: boolean }
export interface CagrBlock { title: string; rows: Array<{ label: string; value: string }> }
export interface KeyValRow { label: string; value: string }
export interface Financials {
  /** Statement currency + scale, e.g. "QAR MN". Per entity — never hardcoded. */
  currencyLabel?: string;
  quarterlyPeriods: string[]; // 8
  quarterlyRows: StockFinRow[];
  quarterlyNote: string;
  annualPeriods: string[]; // 10
  annualRows: StockFinRow[];
  cagr: CagrBlock[]; // 4
  balanceSheet: { rows: KeyValRow[]; note: string };
  cashFlow: { rows: KeyValRow[]; note: string };
}

// ── Filings & Concalls (3c) ──────────────────────────────────────────────────
export interface Announcement {
  /** Stable key + link target. Filing ids repeat far less than titles do. */
  id?: number;
  href?: string;
  date: string;
  regId: string;
  tag: string;
  title: string;
  summary: string;
}
export interface EarningsCall { quarter: string; date: string; aiSummary?: string }
export interface DocRow { title: string; date: string }
export interface NextEvent { date: string; label: string }
export interface RelatedResearch { headline: string; meta: string }
export interface FilingsConcalls {
  /** e.g. "TADAWUL FEED · 1120 ONLY" — per entity, never hardcoded. */
  feedLabel?: string;
  /** Ticker the phrase alerts are scoped to. */
  alertScope?: string;
  announcements: Announcement[];
  earningsCalls: EarningsCall[];
  reports: DocRow[];
  phraseAlerts: { active: string[]; suggestions: string[]; note: string };
  nextEvents: NextEvent[];
  relatedResearch: RelatedResearch[];
}

// ── Ownership & People (3d) ──────────────────────────────────────────────────
export interface ShareholdingRow { label: string; values: string[]; strong?: boolean }
export interface TopHolder { name: string; type: string; pct: string; change: string; changeDir?: "up" | "down" }
export interface BoardMember { name: string; role: string; since: string }
export interface Manager { name: string; role: string; bio: string }
export interface Ownership {
  periods: string[]; // 8
  foreignAtRecord: string;
  rows: ShareholdingRow[];
  shareholderCount: string[];
  topHolders: TopHolder[];
  topHoldersAsOf: string;
  floatWatchHtml: string;
  board: BoardMember[];
  boardMeta: string;
  management: Manager[];
}

export interface StockWorkspace {
  header: StockHeader;
  overview: Overview;
  financials: Financials;
  filings: FilingsConcalls;
  ownership: Ownership;
}

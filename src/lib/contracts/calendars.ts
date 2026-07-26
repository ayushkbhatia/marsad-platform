/**
 * Earnings + Dividend calendars — view-model contract.
 *
 * CONTRACT LAYER (design 8a + 23a). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export interface Kpi {
  label: string;
  value: string;
  dir?: "up" | "down";
}

// ── Earnings (8a) ────────────────────────────────────────────────────────────
export interface EarningsRow {
  ticker: string;
  company: string;
  venue: string;
  venueCode: string;
  session: "PRE" | "POST";
  consensus: string;
  marsad: string;
  prior: string;
  /** Reporting date confirmed by the company (● CONF) vs desk estimate (○ EST). */
  confirmed: boolean;
}
export interface CalendarDay<T> {
  label: string;
  count: string;
  rows: T[];
}
export interface ReportedItem {
  ticker: string;
  company: string;
  surprisePct: number;
  when: string;
  priceReaction: number;
}
export interface EarningsWeek {
  weekLabel: string;
  footnote: string;
  kpis: Kpi[];
  days: CalendarDay<EarningsRow>[];
  reported: ReportedItem[];
  heavyweight: { kicker: string; headline: string; body: string; cta: string };
}


export type DividendType = "FINAL" | "INTERIM" | "SPECIAL";
export interface DividendRow {
  ticker: string;
  company: string;
  venue: string;
  venueCode: string;
  type: DividendType;
  dps: string;
  yield: string;
  payDate: string;
  alertSet: boolean;
}
export interface YieldLeader {
  ticker: string;
  company: string;
  yield: string;
  payout: string;
  payoutRisk?: boolean;
}
export interface DividendWeek {
  weekLabel: string;
  footnote: string;
  kpis: Kpi[];
  days: CalendarDay<DividendRow>[];
  goesExTomorrow: { kicker: string; headline: string; body: string };
  yieldLeaders: YieldLeader[];
  yieldLeadersNote: string;
  reminders: { kicker: string; headline: string; body: string; cta: string };
}

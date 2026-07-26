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
  /**
   * Pre/post-market session. NULLABLE: `earnings_events.session` is 0/9,180
   * populated, so the design's PRE/POST chip has nothing behind it and the row
   * renders without one rather than asserting a session.
   */
  session: "PRE" | "POST" | null;
  /** Street consensus — "—" until an estimates producer lands (DEF-ESTIMATES-AGG). */
  consensus: string;
  /** Marsad desk estimate — "—" until the desk publishes (DEF-ESTIMATES-AGG). */
  marsad: string;
  prior: string;
  /** Reported EPS actual. Real for 8,631 of 9,180 rows. */
  actual?: string;
  /** Fiscal period label, e.g. "Q2 2026". */
  period?: string;
  /** Links the row to its live `/earnings/[eventId]` detail page. */
  eventId?: number;
  /**
   * Whether the reporting DATE is company-confirmed or a desk estimate.
   * NULLABLE because `report_date` is an ingest stamp for a large subset, so
   * "confirmed" cannot be asserted per row (DEF-EARNINGS-REPORTDATE).
   */
  dateState?: "confirmed" | "estimated" | null;
}
export interface CalendarDay<T> {
  label: string;
  count: string;
  rows: T[];
}
export interface ReportedItem {
  ticker: string;
  company: string;
  /** NULL until an estimates producer exists — surprise needs a consensus. */
  surprisePct: number | null;
  when: string;
  /** NULL until `next_session_reaction_pct` is produced (0/9,180 today). */
  priceReaction: number | null;
  period?: string;
  actual?: string;
  eventId?: number;
}
export interface EarningsWeek {
  weekLabel: string;
  footnote: string;
  /**
   * Surface-level honesty note. When a whole column has no producer behind it
   * the reader is told once, plainly, rather than being left to guess what "—"
   * means. Empty string renders nothing.
   */
  dataNote?: string;
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

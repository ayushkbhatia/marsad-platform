/**
 * Earnings (8a) + Dividend (23a) calendars — SAMPLE / PLACEHOLDER content.
 *
 * Same seam contract as the other `sample/*` modules. Real backends exist but
 * don't support the designs' signature columns: `earnings_events` has rows but
 * `eps_consensus`/`eps_marsad` are NULL and `report_date` is a uniform ingest
 * stamp (no week-forward view), and `public.dividends` has 0 `state='live'`
 * rows with NULL ex/pay dates. So both render from sample here; the real reads
 * (`getEarningsCalendar`/`getDividendCalendar` in `lib/data/calendars.ts`) are
 * the adapter basis (DEF-CALENDARS-LIVE-DATA). No `server-only`: pure data.
 */
import type { EarningsWeek, DividendWeek } from "@/lib/contracts/calendars";

// ── Shared ───────────────────────────────────────────────────────────────────
export const SAMPLE_EARNINGS: EarningsWeek = {
  weekLabel: "WEEK OF 6 JUL 2026",
  footnote: "EST = MARSAD DESK ESTIMATE · EPS IN LOCAL CCY",
  kpis: [
    { label: "NAMES REPORTING THIS WEEK", value: "23" },
    { label: "CONSENSUS EPS GROWTH · Q2", value: "+7.4%", dir: "up" },
    { label: "BEATING SO FAR · 19 OF 28 REPORTED", value: "68%", dir: "up" },
    { label: "BIGGEST SURPRISE · +3.7%", value: "ADNOCGAS" },
  ],
  days: [
    {
      label: "MON 6 JUL",
      count: "5 reporting",
      rows: [
        { ticker: "QNBK", company: "QNB Group", venue: "QE", venueCode: "QE", session: "PRE", consensus: "0.49", marsad: "0.51", prior: "0.46", confirmed: true },
        { ticker: "DEWA", company: "DEWA", venue: "DFM", venueCode: "DFM", session: "POST", consensus: "0.07", marsad: "0.07", prior: "0.07", confirmed: true },
        { ticker: "ADNOCGAS", company: "ADNOC Gas", venue: "ADX", venueCode: "ADX", session: "PRE", consensus: "0.10", marsad: "0.11", prior: "0.09", confirmed: true },
      ],
    },
    {
      label: "TUE 7 JUL",
      count: "6 reporting",
      rows: [
        { ticker: "2222", company: "Saudi Aramco", venue: "TADAWUL", venueCode: "TDWL", session: "PRE", consensus: "0.39", marsad: "0.39", prior: "0.38", confirmed: true },
        { ticker: "ALDAR", company: "Aldar Properties", venue: "ADX", venueCode: "ADX", session: "POST", consensus: "0.14", marsad: "0.15", prior: "0.12", confirmed: false },
      ],
    },
    {
      label: "WED 8 JUL",
      count: "7 reporting",
      rows: [
        { ticker: "FAB", company: "First Abu Dhabi Bank", venue: "ADX", venueCode: "ADX", session: "PRE", consensus: "0.42", marsad: "0.44", prior: "0.39", confirmed: true },
        { ticker: "EMIRATESNBD", company: "Emirates NBD", venue: "DFM", venueCode: "DFM", session: "PRE", consensus: "1.02", marsad: "1.05", prior: "0.94", confirmed: true },
        { ticker: "7010", company: "stc", venue: "TADAWUL", venueCode: "TDWL", session: "POST", consensus: "0.84", marsad: "0.86", prior: "0.81", confirmed: false },
      ],
    },
  ],
  reported: [
    { ticker: "1180", company: "Saudi National Bank", surprisePct: 4.2, when: "MON 30 JUN · ACT 0.79 vs 0.76", priceReaction: 2.1 },
    { ticker: "ADNOCGAS", company: "ADNOC Gas", surprisePct: 3.7, when: "SUN 6 JUL · ACT 0.104 vs 0.100", priceReaction: 0.4 },
    { ticker: "1120", company: "Al Rajhi Bank", surprisePct: 2.4, when: "FRI 4 JUL · ACT 1.09 vs 1.06", priceReaction: 1.2 },
    { ticker: "ORDS", company: "Ooredoo", surprisePct: -3.1, when: "THU 3 JUL · ACT 0.44 vs 0.46", priceReaction: -1.4 },
    { ticker: "2010", company: "SABIC", surprisePct: -9.5, when: "WED 2 JUL · ACT 0.38 vs 0.42", priceReaction: -2.1 },
  ],
  heavyweight: {
    kicker: "HEAVYWEIGHT AHEAD",
    headline: "Aramco reports Tuesday pre-market",
    body: "SAR 6.5T cap · watch gas mix & the dividend split.",
    cta: "Preview 2222 →",
  },
};

// ── Dividends (23a) ──────────────────────────────────────────────────────────
export const SAMPLE_DIVIDENDS: DividendWeek = {
  weekLabel: "WEEK OF 12 JUL 2026 · BY EX-DATE",
  footnote: "OWN BEFORE THE EX-DATE OPEN TO RECEIVE · DPS IN LOCAL CCY",
  kpis: [
    { label: "GOING EX THIS WEEK", value: "12" },
    { label: "PAID THIS WEEK", value: "SAR 41.2B" },
    { label: "MEDIAN YIELD · GCC", value: "4.1%" },
    { label: "SPECIALS", value: "2" },
  ],
  days: [
    {
      label: "SUN 12 JUL",
      count: "3 EX-DATES · SAR 33.8B PAYS OUT",
      rows: [
        { ticker: "2222", company: "Saudi Aramco", venue: "TDWL", venueCode: "TDWL", type: "FINAL", dps: "SAR 0.2043", yield: "4.9%", payDate: "25 JUL", alertSet: false },
        { ticker: "SALIK", company: "Salik Company", venue: "DFM", venueCode: "DFM", type: "INTERIM", dps: "AED 0.0827", yield: "5.2%", payDate: "28 JUL", alertSet: true },
        { ticker: "QNBK", company: "QNB Group", venue: "QE", venueCode: "QE", type: "INTERIM", dps: "QAR 0.33", yield: "3.7%", payDate: "26 JUL", alertSet: false },
      ],
    },
    {
      label: "MON 13 JUL",
      count: "2 EX-DATES",
      rows: [
        { ticker: "7010", company: "stc", venue: "TDWL", venueCode: "TDWL", type: "INTERIM", dps: "SAR 0.55", yield: "5.4%", payDate: "30 JUL", alertSet: true },
        { ticker: "FAB", company: "First Abu Dhabi Bank", venue: "ADX", venueCode: "ADX", type: "FINAL", dps: "AED 0.71", yield: "4.2%", payDate: "31 JUL", alertSet: false },
      ],
    },
    {
      label: "TUE 14 JUL",
      count: "4 EX-DATES · 1 SPECIAL",
      rows: [
        { ticker: "1120", company: "Al Rajhi Bank", venue: "TDWL", venueCode: "TDWL", type: "INTERIM", dps: "SAR 1.25", yield: "2.6%", payDate: "28 JUL", alertSet: false },
        { ticker: "2010", company: "SABIC", venue: "TDWL", venueCode: "TDWL", type: "FINAL", dps: "SAR 1.70", yield: "5.1%", payDate: "4 AUG", alertSet: false },
        { ticker: "NAJM", company: "Najm Insurance", venue: "QE", venueCode: "QE", type: "SPECIAL", dps: "QAR 0.90", yield: "8.8%", payDate: "2 AUG", alertSet: false },
      ],
    },
    {
      label: "WED 15 JUL",
      count: "1 EX-DATE",
      rows: [
        { ticker: "MTEL", company: "Muscat Telecom", venue: "MSX", venueCode: "MSX", type: "FINAL", dps: "OMR 0.021", yield: "6.1%", payDate: "29 JUL", alertSet: false },
      ],
    },
  ],
  goesExTomorrow: {
    kicker: "GOES EX TOMORROW",
    headline: "Own Aramco by today's close to collect SAR 0.2043",
    body: "2222, SALIK and QNBK all trade ex on Sunday. On your watchlist: 2 of 3.",
  },
  yieldLeaders: [
    { ticker: "NAJM", company: "Najm Insurance", yield: "8.8%", payout: "PAYOUT 118%", payoutRisk: true },
    { ticker: "MTEL", company: "Muscat Telecom", yield: "6.1%", payout: "PAYOUT 74%" },
    { ticker: "7010", company: "stc", yield: "5.4%", payout: "PAYOUT 81%" },
    { ticker: "SALIK", company: "Salik Company", yield: "5.2%", payout: "PAYOUT 100%" },
  ],
  yieldLeadersNote: "PAYOUT > 100% FLAGGED — DISTRIBUTION EXCEEDS EARNINGS; CUT RISK.",
  reminders: {
    kicker: "EX-DATE REMINDERS",
    headline: "Two days' warning, every time",
    body: "Push + email before any watchlist name goes ex-dividend.",
    cta: "Create dividend alert →",
  },
};

/**
 * Watchlist page (design 1h) — SAMPLE / PLACEHOLDER content.
 *
 * Same seam contract as `sample/ledger.ts` / `sample/newswire.ts`: every
 * figure below is representative sample copy from the 1h handoff
 * (`handoff_1h_watchlist`), standing in for a member's real watchlist so the
 * page renders pixel-perfect today. Watchlist is a MEMBER surface in the real
 * product (per-user lists, alerts, notes) — there is no `(auth)` group yet, so
 * this renders a shared sample list for the fidelity pass. Real per-user data
 * re-wires by mapping onto the view-model types here and swapping
 * `SAMPLE_WATCHLIST` (DEF-WATCHLIST-LIVE-DATA).
 *
 * No `server-only`: pure data.
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

export const SAMPLE_WATCHLIST: WatchlistData = {
  lists: [
    { name: "GCC Core", count: 12, selected: true },
    { name: "Dividend sleeve", count: 8 },
    { name: "IPO tracker", count: 6 },
  ],
  alertCount: 4,

  stats: [
    { label: "NAMES", value: "12 across 5 venues" },
    { label: "TODAY, EQUAL-WEIGHTED", value: "+1.18%", dir: "up" },
  ],
  best: { ticker: "2082", pct: "+4.2%" },
  worst: { ticker: "2222", pct: "−0.6%" },
  alertsTriggered: { count: 2, names: "SALIK, 2082" },

  groups: [
    {
      label: "TADAWUL — SAUDI ARABIA",
      summary: "4 NAMES · +0.9% TODAY",
      rows: [
        { ticker: "2222", name: "Saudi Aramco", nameAr: "أرامكو", price: "SAR 27.15", chg1d: -0.6, chg1w: -1.2, score: 76, scoreTier: "outlined", ptUpside: 14.9, nextEvent: "Q2 · TUE", alertArmed: true, venueCode: "TDWL" },
        { ticker: "1120", name: "Al Rajhi Bank", nameAr: "الراجحي", price: "SAR 98.20", chg1d: 1.2, chg1w: 2.6, score: 82, scoreTier: "solid", ptUpside: 14.1, nextEvent: "—", alertArmed: false, venueCode: "TDWL" },
        { ticker: "2082", name: "ACWA Power", nameAr: "أكوا باور", price: "SAR 268.40", chg1d: 4.2, chg1w: 6.8, score: 71, scoreTier: "outlined", ptUpside: 9.5, nextEvent: "NEOM CLOSE", alertArmed: true, venueCode: "TDWL" },
        { ticker: "1211", name: "Maaden", nameAr: "معادن", price: "SAR 52.30", chg1d: 1.9, chg1w: 3.1, score: 69, scoreTier: "muted", ptUpside: 11.8, nextEvent: "Q2 · THU", alertArmed: false, venueCode: "TDWL" },
      ],
    },
    {
      label: "DFM — DUBAI",
      summary: "2 NAMES · +2.1% TODAY",
      rows: [
        { ticker: "EMAAR", name: "Emaar Properties", nameAr: "إعمار", price: "AED 14.05", chg1d: 1.1, chg1w: 1.9, score: 74, scoreTier: "outlined", ptUpside: 17.4, nextEvent: "—", alertArmed: false, venueCode: "DFM" },
        { ticker: "SALIK", name: "Salik Co.", nameAr: "سالك", price: "AED 5.84", chg1d: 3.1, chg1w: 5.2, score: 68, scoreTier: "muted", ptUpside: 2.7, nextEvent: "TOLLS · 5 AUG", alertArmed: true, venueCode: "DFM" },
      ],
    },
    {
      label: "ADX — ABU DHABI",
      summary: "2 NAMES · +0.6% TODAY",
      rows: [
        { ticker: "EAND", name: "e& Group", nameAr: "اتصالات", price: "AED 28.44", chg1d: 0.8, chg1w: 0.4, score: 79, scoreTier: "outlined", ptUpside: 8.3, nextEvent: "—", alertArmed: false, venueCode: "ADX" },
        { ticker: "ADNOCGAS", name: "ADNOC Gas", nameAr: "أدنوك للغاز", price: "AED 3.44", chg1d: 0.4, chg1w: 1.1, score: 78, scoreTier: "outlined", ptUpside: 12.2, nextEvent: "—", alertArmed: false, venueCode: "ADX" },
      ],
    },
    {
      label: "QSE — QATAR",
      summary: "2 NAMES · +1.7% TODAY",
      rows: [
        { ticker: "QNBK", name: "QNB Group", nameAr: "قطر الوطني", price: "QAR 17.84", chg1d: 0.9, chg1w: 1.5, score: 81, scoreTier: "solid", ptUpside: 17.7, nextEvent: "Q2 · MON", alertArmed: true, venueCode: "QSE" },
        { ticker: "QGTS", name: "Nakilat", nameAr: "ناقلات", price: "QAR 4.92", chg1d: 2.6, chg1w: 4.4, score: 73, scoreTier: "outlined", ptUpside: 6.5, nextEvent: "—", alertArmed: false, venueCode: "QSE" },
      ],
    },
    {
      label: "BOURSA KUWAIT",
      summary: "2 NAMES · +1.1% TODAY",
      rows: [
        { ticker: "NBK", name: "National Bank of Kuwait", nameAr: "الوطني", price: "KWD 0.960", chg1d: 0.4, chg1w: 0.9, score: 76, scoreTier: "outlined", ptUpside: 9.4, nextEvent: "DIV · 4 AUG", alertArmed: false, venueCode: "BK" },
        { ticker: "KFH", name: "Kuwait Finance House", nameAr: "بيتك", price: "KWD 0.782", chg1d: 1.8, chg1w: 2.2, score: 70, scoreTier: "outlined", ptUpside: 5.6, nextEvent: "BONUS · 13 JUL", alertArmed: true, venueCode: "BK" },
      ],
    },
  ],

  alerts: [
    { ticker: "SALIK", conditionPre: "Price crosses ", conditionStrong: "AED 6.00", conditionPost: "", channel: "PUSH + EMAIL", triggeredAt: "TRIGGERED 13:58" },
    { ticker: "2082", conditionPre: "Any ", conditionStrong: "Marsad Score", conditionPost: " change", channel: "PUSH", triggeredAt: "TRIGGERED 12:20" },
    { ticker: "2222", conditionPre: "Ex-dividend reminder · ", conditionStrong: "8 Jul", conditionPost: "", channel: "EMAIL" },
    { ticker: "TASI", conditionPre: "Index falls more than ", conditionStrong: "1%", conditionPost: " intraday", channel: "PUSH" },
  ],

  notes: [
    { ticker: "2222", date: "2 JUL", note: '"Add below 26.50 if Q2 DPS holds at 0.34. Jafurah newsflow is the free option."' },
    { ticker: "KFH", date: "28 JUN", note: '"Watch the bonus-issue adjustment on 13 Jul — screen will look 5% cheaper overnight, it isn\'t."' },
  ],
};

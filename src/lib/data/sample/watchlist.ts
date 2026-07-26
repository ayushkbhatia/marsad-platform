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
import type { WatchlistData } from "@/lib/contracts/watchlist";

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
      label: "QE — QATAR",
      summary: "2 NAMES · +1.7% TODAY",
      rows: [
        { ticker: "QNBK", name: "QNB Group", nameAr: "قطر الوطني", price: "QAR 17.84", chg1d: 0.9, chg1w: 1.5, score: 81, scoreTier: "solid", ptUpside: 17.7, nextEvent: "Q2 · MON", alertArmed: true, venueCode: "QE" },
        { ticker: "QGTS", name: "Nakilat", nameAr: "ناقلات", price: "QAR 4.92", chg1d: 2.6, chg1w: 4.4, score: 73, scoreTier: "outlined", ptUpside: 6.5, nextEvent: "—", alertArmed: false, venueCode: "QE" },
      ],
    },
    {
      label: "BHB — BAHRAIN",
      summary: "2 NAMES · +1.1% TODAY",
      rows: [
        { ticker: "NBB", name: "National Bank of Bahrain", nameAr: "الأهلي", price: "BHD 0.524", chg1d: 0.4, chg1w: 0.9, score: 76, scoreTier: "outlined", ptUpside: 9.4, nextEvent: "DIV · 4 AUG", alertArmed: false, venueCode: "BHB" },
        { ticker: "KFH", name: "Kuwait Finance House", nameAr: "بيتك", price: "USD 2.495", chg1d: 1.8, chg1w: 2.2, score: 70, scoreTier: "outlined", ptUpside: 5.6, nextEvent: "BONUS · 13 JUL", alertArmed: true, venueCode: "BHB" },
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

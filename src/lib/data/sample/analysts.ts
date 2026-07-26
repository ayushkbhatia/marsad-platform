/**
 * Coverage Desk (1i) + Analyst Profile (1j) — SAMPLE / PLACEHOLDER content.
 *
 * Same seam contract as the other `sample/*` modules. 1i is a leaderboard over
 * `COVERAGE_DESK.analysts`; every row links to `/analysts/{slug}` — the 1j
 * template. 1j is ONE reusable profile layout; for the fidelity pass every
 * slug renders the single fully-resolved `SAMPLE_PROFILE` (Noor Al-Suwaidi,
 * #1), the one profile the design bakes end-to-end (chart, coverage table,
 * pinned call, published research). Real per-analyst data re-wires by mapping
 * onto these view-model types and swapping the sample (DEF-ANALYSTS-LIVE-DATA);
 * `editorial.ts` (`getAnalystLeaderboard`/`getCoverageBySector`/
 * `getAnalystProfileBySlug`) + `AnalystLeaderboard` are the adapter basis.
 *
 * No `server-only`: pure data. `ArticleTag`/`TagChip` are reused from the
 * research pair.
 */
import type { CoverageDeskData, AnalystProfile } from "@/lib/contracts/analysts";

// ── Coverage Desk (1i) ───────────────────────────────────────────────────────

export const COVERAGE_DESK: CoverageDeskData = {
  subtitle: "Six analysts · 61 GCC names under coverage · every call tracked and scored in public",
  analysts: [
    { rank: 1, slug: "noor-al-suwaidi", initials: "NS", name: "Noor Al-Suwaidi", focus: "GCC Banks", names: 14, winRate: 71, avgReturn: 9.4, last5: [true, true, false, true, true], followers: "12.4k" },
    { rank: 2, slug: "layla-al-rashid", initials: "LR", name: "Layla Al-Rashid", focus: "Energy & Petrochems", names: 11, winRate: 68, avgReturn: 8.1, last5: [true, false, true, true, true], followers: "10.9k" },
    { rank: 3, slug: "tariq-mansour", initials: "TM", name: "Tariq Mansour", focus: "UAE Real Estate", names: 12, winRate: 66, avgReturn: 7.7, last5: [true, true, true, false, false], followers: "9.3k" },
    { rank: 4, slug: "rania-khalifa", initials: "RK", name: "Rania Khalifa", focus: "Qatar Coverage", names: 9, winRate: 64, avgReturn: 6.9, last5: [false, true, true, false, true], followers: "7.1k" },
    { rank: 5, slug: "yousef-al-mutairi", initials: "YM", name: "Yousef Al-Mutairi", focus: "Kuwait & Bahrain", names: 8, winRate: 61, avgReturn: 6.2, last5: [true, false, false, true, true], followers: "5.8k" },
    { rank: 6, slug: "faisal-rahman", initials: "FR", name: "Faisal Rahman", focus: "Utilities & Infra", names: 7, winRate: 60, avgReturn: 5.4, last5: [false, true, true, true, false], followers: "5.2k" },
  ],
  latest: [
    { slug: "gulf-utilities-h2", tag: "PREMIUM", headline: "Gulf utilities: the case for boring in H2", byline: "Faisal Rahman · Utilities · 18 min read" },
    { slug: "tadawul-banks-nim-trough", tag: "PREMIUM", headline: "Tadawul banks: NIM trough is in — who re-rates first?", byline: "Noor Al-Suwaidi · Banks · 24 min read" },
    { slug: "gcc-ipo-monitor", tag: "FREE", headline: "GCC IPO monitor: 14 priced, 9 in the chute", byline: "Marsad Desk · Weekly · 8 min read" },
  ],
  ratingsChanges: [
    { direction: "up", type: "UPGRADE", ticker: "QNBK", date: "TODAY", note: "Hold → Buy · PT QAR 21.00", analyst: "R. Khalifa" },
    { direction: "up", type: "PT RAISE", ticker: "1120", date: "TODAY", note: "Overweight · PT 104 → 112", analyst: "N. Al-Suwaidi" },
    { direction: "down", type: "DOWNGRADE", ticker: "7030", date: "WED", note: "Buy → Neutral · capex cycle", analyst: "Desk model" },
    { direction: "up", type: "INITIATION", ticker: "EMAAR", date: "WED", note: "Buy · PT AED 16.50", analyst: "T. Mansour" },
    { direction: "down", type: "PT CUT", ticker: "2010", date: "MON", note: "Neutral · PT 78 → 71", analyst: "L. Al-Rashid" },
  ],
  sectors: [
    { sector: "Banks", count: 18, barWidth: 170 },
    { sector: "Energy", count: 12, barWidth: 113 },
    { sector: "Real estate", count: 9, barWidth: 85 },
    { sector: "Telecom", count: 8, barWidth: 75 },
    { sector: "Utilities", count: 7, barWidth: 66 },
    { sector: "Consumer", count: 5, barWidth: 47 },
    { sector: "Other", count: 2, barWidth: 19 },
  ],
  totalNames: 61,
  requestCoverage: { leadName: "Lulu Retail (ADX)", votes: 312 },
};

export const SAMPLE_PROFILE: AnalystProfile = {
  slug: "noor-al-suwaidi",
  initials: "NS",
  name: "Noor Al-Suwaidi",
  rank: 1,
  credential: "Senior Banks Analyst · Marsad Coverage Desk · Riyadh · CFA",
  bio: 'Covers 14 GCC banks. Previously 9 years on the sell side in Riyadh and Dubai. Writes the weekly "Deposit Wars" column.',
  followers: "12.4k",
  stats: [
    { label: "WIN RATE", value: "71%" },
    { label: "AVG CALL RETURN", value: "+9.4%", dir: "up" },
    { label: "CLOSED CALLS", value: "63" },
    { label: "UNDER COVERAGE", value: "14 names" },
    { label: "PUBLISHING SINCE", value: "2023" },
  ],
  chart: {
    width: 800,
    height: 190,
    gridY: [47, 95, 143],
    analystPoints:
      "0.0,169.5 66.7,149.6 133.3,156.2 200.0,134.7 266.7,113.2 333.3,121.5 400.0,100.0 466.7,85.1 533.3,65.2 600.0,73.5 666.7,50.3 733.3,30.5 800.0,13.9",
    venuePoints:
      "0.0,169.5 66.7,161.2 133.3,166.1 200.0,151.3 266.7,139.7 333.3,146.3 400.0,133.1 466.7,126.4 533.3,118.2 600.0,123.1 666.7,111.5 733.3,103.3 800.0,96.7",
    rightLabels: [
      { top: 40, text: "+7.5%" },
      { top: 88, text: "+4.5%" },
      { top: 136, text: "+1.5%" },
    ],
    months: ["JUL '24", "NOV '24", "MAR '25", "JUL '25", "NOV '25", "MAR '26", "JUL '26"],
    legendAnalyst: "N. AL-SUWAIDI +9.4%",
    legendVenue: "TASI +4.4%",
  },
  coverage: [
    { ticker: "1120", company: "Al Rajhi Bank", rating: "Overweight", target: "SAR 112.00", since: "Mar 24", callReturn: 21.4, venueCode: "TDWL" },
    { ticker: "1150", company: "Alinma Bank", rating: "Buy", target: "SAR 31.50", since: "Jun 24", callReturn: 18.2, venueCode: "TDWL" },
    { ticker: "QNBK", company: "QNB Group", rating: "Buy", target: "QAR 21.00", since: "Jan 25", callReturn: 12.9, venueCode: "QE" },
    { ticker: "FAB", company: "First Abu Dhabi Bank", rating: "Hold", target: "AED 16.00", since: "Sep 24", callReturn: 4.1, venueCode: "ADX" },
    { ticker: "1180", company: "Saudi National Bank", rating: "Underweight", target: "SAR 34.00", since: "Feb 25", callReturn: 3.2, venueCode: "TDWL" },
    { ticker: "KFH", company: "Kuwait Finance House", rating: "Buy", target: "USD 2.80", since: "May 26", callReturn: -1.8, venueCode: "BHB" },
  ],
  pinnedCall: {
    date: "PINNED CALL · 28 JUN",
    quote:
      "Al Rajhi at 112: the NIM trough passed in Q1 and nobody repriced the retail book. Overweight, 14% to go.",
    ticker: "1120",
    returnSince: "+21.4% SINCE CALL",
  },
  publishedResearch: [
    { slug: "tadawul-banks-nim-trough", tag: "PREMIUM", headline: "Tadawul banks: NIM trough is in — who re-rates first?", meta: "28 Jun · 24 min · 214 reactions" },
    { slug: "alinma-marsad-score", tag: "PREMIUM", headline: "Alinma at 78: what the Marsad Score is seeing", meta: "19 Jun · 12 min · 96 reactions" },
    { slug: "gcc-deposit-wars-charted", tag: "FREE", headline: "GCC deposit wars, charted: 14 banks in 6 charts", meta: "11 Jun · 9 min · 187 reactions" },
    { slug: "kfh-bonus-issue", tag: "PREMIUM", headline: "KFH after the bonus issue: the fils illusion", meta: "2 Jun · 15 min · town-hall replay" },
  ],
  publishedCount: "84 PIECES",
  disclosure:
    "Marsad analysts may not hold positions in covered names. Every call is timestamped and archived; track records cannot be edited retroactively.",
};

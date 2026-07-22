/**
 * Newswire page (design 1d) — SAMPLE / PLACEHOLDER content.
 *
 * Same seam contract as `sample/ledger.ts`: every figure/headline below is
 * representative sample copy from the 1d handoff (`handoff_1d_newswire`), a
 * point-in-time snapshot standing in for the live wire so the page renders
 * pixel-perfect today. The real connectors (the raw `public.filings` feed,
 * the newsroom WIRE items, venue/type facet counts, corporate actions,
 * a most-read source, and the feed-connection status) plug in by mapping
 * their reads onto the view-model types here and swapping `SAMPLE_NEWSWIRE`
 * in `(reader)/wire/page.tsx` — the existing live-feed infra
 * (`WireStream`/`WireFeedList`/`feed.ts`/`WireLeftRail`/`WireRightRail`) is
 * the adapter basis (DEF-NEWSWIRE-LIVE-DATA).
 *
 * No `server-only`: pure data, importable anywhere.
 */

export type Direction = "up" | "down" | "flat";

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

export const SAMPLE_NEWSWIRE: NewswireData = {
  categories: [
    { name: "All items", count: 214, selected: true, href: "/wire" },
    { name: "Disclosures", count: 58, href: "#" },
    { name: "Earnings", count: 31, href: "#" },
    { name: "Dividends & actions", count: 19, href: "#" },
    { name: "IPOs & listings", count: 12, href: "#" },
    { name: "Ratings changes", count: 24, href: "#" },
    { name: "Macro & policy", count: 17, href: "#" },
    { name: "Marsad datapoints", count: 43, href: "#" },
  ],

  venues: [
    { name: "Tadawul", count: 96, checked: true },
    { name: "DFM", count: 34, checked: true },
    { name: "ADX", count: 29, checked: true },
    { name: "QSE", count: 22, checked: true },
    { name: "Boursa Kuwait", count: 18, checked: true },
    { name: "Bahrain Bourse", count: 7, checked: true },
    { name: "MSX", count: 8, checked: true },
  ],

  todayCount: 214,
  dateLabel: "Sunday 5 July 2026",
  connection: {
    state: "reconnecting",
    detail: "LAST SYNC 14:31:58 · RETRYING…",
    message: "Reconnecting to the exchange feed — items may be delayed a few seconds.",
  },

  feed: [
    {
      time: "14:21",
      venue: "TDWL",
      category: "DISCLOSURE",
      headline: "Maaden completes phosphate debottlenecking ahead of plan",
      summary: "Throughput at Wa'ad Al Shamal rises 8% from Q4; capex guidance unchanged at SAR 4.1bn.",
      tickers: [{ symbol: "1211", changePct: 1.9 }],
      href: "#",
    },
    {
      time: "14:02",
      venue: "UAE",
      category: "MACRO",
      headline: "UAE PMI prints 56.1 — fastest expansion in 14 months",
      summary: "New orders and hiring both accelerate; input costs stay benign despite freight rates.",
      href: "#",
    },
    {
      time: "13:58",
      venue: "DFM",
      category: "DATAPOINT",
      headline: "Salik July toll volumes +9% y/y",
      summary: "Marsad datapoint · tracked series: monthly toll transactions. Fifth consecutive beat vs desk model.",
      tickers: [{ symbol: "SALIK", changePct: 3.1 }],
      href: "#",
    },
    {
      time: "13:40",
      venue: "CBUAE",
      category: "POLICY",
      headline: "Central Bank of the UAE holds base rate at 4.15%",
      summary: 'Decision tracks the Fed. Statement flags "balanced" inflation risks; EIBOR curve barely moves.',
      isDeveloping: true,
      href: "#",
    },
    {
      time: "13:12",
      venue: "QSE",
      category: "CONTRACT",
      headline: "Nakilat signs 10-year charter with QatarEnergy",
      summary: 'Four LNG carriers; management guides to "mid-single-digit" EPS accretion from 2027.',
      tickers: [{ symbol: "QGTS", changePct: 2.6 }],
      href: "#",
    },
    {
      time: "12:47",
      venue: "BK",
      category: "DIVIDEND",
      headline: "NBK board approves interim dividend of 10 fils",
      summary: "Payable 4 August; implies 4.8% annualised yield at last close.",
      tickers: [{ symbol: "NBK", changePct: 0.8 }],
      href: "#",
    },
    {
      time: "12:20",
      venue: "TDWL",
      category: "FINANCING",
      headline: "ACWA Power reaches financial close on NEOM hydrogen tranche",
      summary: '$2.7bn non-recourse package; equity IRR guidance reiterated at "low teens".',
      tickers: [{ symbol: "2082", changePct: 4.2 }],
      href: "#",
    },
    {
      time: "11:54",
      venue: "MSX",
      category: "IPO",
      headline: "OQ Base Industries sets price range; float trimmed to 15%",
      summary: "Books open Tuesday. Cornerstone demand covers a third of the offer, two funds say.",
      href: "#",
    },
    {
      time: "11:31",
      venue: "TDWL",
      category: "EARNINGS",
      headline: "Jarir Q2 pre-announcement: revenue +4%, margins flat",
      summary: "Smartphone mix drags; school-season inventory build in line with prior years.",
      tickers: [{ symbol: "4190", changePct: -0.6 }],
      href: "#",
    },
  ],

  filings: [
    { time: "14:05", venue: "TDWL", company: "Saudi Aramco", filingType: "Board resolution — dividend", href: "#" },
    { time: "13:47", venue: "ADX", company: "IHC", filingType: "Change in major shareholding", href: "#" },
    { time: "13:30", venue: "DFM", company: "Emaar Properties", filingType: "Related-party disclosure", href: "#" },
    { time: "12:58", venue: "QSE", company: "QNB Group", filingType: "Financial statements — Q2", href: "#" },
    { time: "12:31", venue: "BK", company: "Zain Group", filingType: "AGM minutes", href: "#" },
    { time: "12:06", venue: "BHB", company: "GFH Financial", filingType: "Buyback notice", href: "#" },
  ],

  corporateActions: [
    { date: "8 JUL", ticker: "2222", type: "Ex-dividend · SAR 0.34" },
    { date: "9 JUL", ticker: "FAB", type: "Ex-dividend · AED 0.38" },
    { date: "10 JUL", ticker: "QNBK", type: "Record date" },
    { date: "13 JUL", ticker: "KFH", type: "Bonus issue · 5%" },
    { date: "14 JUL", ticker: "7010", type: "Ex-dividend · SAR 1.00" },
  ],

  mostRead: [
    { rank: 1, headline: "Jafurah's second act: Saudi gas becomes the quiet growth engine", href: "#" },
    { rank: 2, headline: "The case for boring: Gulf utilities are the trade of H2", href: "#" },
    { rank: 3, headline: "Kuwait's consolidation question: who follows KFH–AUB?", href: "#" },
    { rank: 4, headline: "GCC IPO monitor: 14 priced, 9 in the chute", href: "#" },
  ],
};

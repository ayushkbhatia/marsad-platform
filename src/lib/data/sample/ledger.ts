/**
 * Ledger front page (design 1b) — SAMPLE / PLACEHOLDER content.
 *
 * This module is the single seam between the pixel-perfect 1b home page and
 * its data. Every figure, headline and ticker below is representative sample
 * copy lifted verbatim from the design handoff (`handoff_1b_ledger`), NOT a
 * live feed — a point-in-time snapshot standing in for production data so the
 * page renders fully today.
 *
 * REPLACE-ME seam: when the real connectors land (newsroom wires, analyst
 * calls, index levels, filings wire, movers), write adapters that map those
 * DB reads onto the view-model types exported here and swap `SAMPLE_LEDGER`
 * for the adapter's output in `(reader)/page.tsx`. The components never see
 * the DB shapes — only these types — so the swap is a one-file change.
 *
 * Kept free of `server-only` on purpose: the nav ticker strip (a client
 * island) imports `SAMPLE_INDICES` as a static fallback.
 */

export type Direction = "up" | "down" | "flat";

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

/** The GCC headline indices — also the nav ticker strip's static fallback. */
export const SAMPLE_INDICES: LedgerIndex[] = [
  { code: "TASI", name: "Tadawul All Share", venueCode: "TDWL", level: 11842.6, changePct: 0.42 },
  { code: "DFMGI", name: "DFM General Index", venueCode: "DFM", level: 5412.88, changePct: 0.65 },
  { code: "FADGI", name: "FTSE ADX General", venueCode: "ADX", level: 9876.14, changePct: -0.18 },
  { code: "QSI", name: "QE Index", venueCode: "QSE", level: 10932.51, changePct: 0.27 },
  { code: "BKP", name: "Boursa Kuwait Premier", venueCode: "BK", level: 9148.33, changePct: 0.51 },
  { code: "BAX", name: "Bahrain All Share", venueCode: "BHB", level: 2094.77, changePct: 0.08 },
  { code: "MSX30", name: "MSX 30", venueCode: "MSX", level: 4921.06, changePct: -0.11 },
];

export const SAMPLE_LEDGER: LedgerData = {
  indices: SAMPLE_INDICES,

  lead: {
    kicker: "Energy Transition",
    headline: "Jafurah's second act: Saudi gas becomes the Kingdom's quiet growth engine",
    dek: "Phase 3 approvals put unconventional gas at the centre of Vision 2030's industrial push — and hand Aramco a hedge against a soft crude tape.",
    take: "The take: gas is now the Kingdom's counter-cyclical earnings engine — and the supply chain trade runs through Maaden, ADNOC Drilling and the Gulf EPC names.",
    byline: "By Layla Al-Rashid",
    time: "3h ago",
    readLabel: "READ — 12 MIN",
    href: "#",
    photoLabel: "PHOTO — JAFURAH GAS PROCESSING TRAINS",
    photoCaption: "Jafurah, Eastern Province. — Aramco media",
  },

  secondary: [
    {
      kicker: "Markets",
      time: "5h ago",
      headline: "Dubai's privatisation pipeline turns to district cooling and car parks",
      dek: "Empower's follow-on and two fresh listings headline DFM's autumn window — bankers say demand books are already forming.",
      href: "#",
    },
    {
      kicker: "Banks",
      time: "6h ago",
      headline: "Kuwait's consolidation question: who follows KFH–AUB?",
      dek: "Three mid-tier lenders trade below 1.1× book. The maths of the next merger is getting hard to ignore.",
      href: "#",
    },
    {
      kicker: "Earnings",
      time: "7h ago",
      headline: "QNB opens Gulf bank earnings with margins in focus",
      dek: "Consensus sees Q2 NIM at 2.61%. Anything above quiets the doves; anything below reprices the sector.",
      href: "#",
    },
    {
      kicker: "Macro",
      time: "8h ago",
      headline: "Brent below $70 tests GCC budget maths",
      dek: "Saudi Arabia's fiscal breakeven creeps toward $96. Bond desks are already sketching the next EMBI supply wave.",
      href: "#",
    },
    {
      kicker: "IPO Watch",
      time: "9h ago",
      headline: "Oman trims OQ float size as MSX liquidity thins",
      dek: "A smaller deal, a cleaner book: Muscat chooses certainty over size for its flagship listing.",
      href: "#",
    },
    {
      kicker: "Opinion",
      time: "Today",
      headline: "The case for boring: Gulf utilities are the trade of H2",
      dek: "Regulated returns, indexed tariffs and 5% yields — while everyone else argues about oil.",
      href: "#",
      isOpinion: true,
    },
  ],

  calls: [
    {
      action: "Overweight",
      symbol: "1120",
      name: "Al Rajhi Bank",
      priceTarget: "PT SAR 112",
      note: "from 104",
      analyst: "Noor Al-Suwaidi",
      href: "#",
    },
    {
      action: "Buy",
      symbol: "EMAAR",
      name: "Emaar Properties",
      priceTarget: "PT AED 16.50",
      note: "initiated",
      analyst: "Tariq Mansour",
      href: "#",
    },
    {
      action: "Hold → Buy",
      symbol: "QNBK",
      name: "QNB Group",
      priceTarget: "PT QAR 21.00",
      note: "upgraded",
      analyst: "Rania Khalifa",
      href: "#",
    },
    {
      action: "Neutral",
      symbol: "7010",
      name: "stc",
      priceTarget: "PT SAR 46.00",
      note: "maintained",
      analyst: "Layla Al-Rashid",
      href: "#",
    },
  ],

  live: {
    code: "TASI",
    name: "Tadawul All Share",
    level: 11842.6,
    changePct: 0.42,
    open: true,
    dayHigh: "11,861.20",
    dayLow: "11,798.44",
    volume: "SAR 6.2BN",
    spark: {
      width: 324,
      height: 56,
      points:
        "0.0,53.0 29.5,38.5 58.9,45.7 88.4,27.4 117.8,33.2 147.3,18.6 176.7,11.4 206.2,21.7 235.6,16.0 265.1,9.5 294.5,13.7 324.0,3.0",
    },
    macro: [
      { label: "BRENT", value: "$68.94", change: "-0.82%", dir: "down" },
      { label: "GOLD", value: "$2,648.20", change: "+0.31%", dir: "up" },
      { label: "UST10Y", value: "4.02%", change: "-2 bp", dir: "down" },
      { label: "USDSAR", value: "3.7500", change: "pegged", dir: "flat", muted: true, tinted: true },
    ],
  },

  wires: [
    { time: "14:21", source: "TDWL", summary: "Maaden completes phosphate debottlenecking ahead of plan", href: "#" },
    { time: "13:58", source: "DFM", summary: "Salik July toll volumes +9% y/y", href: "#" },
    { time: "13:40", source: "CBUAE", summary: "Base rate held at 4.15%, tracking Fed", href: "#" },
    { time: "13:12", source: "QSE", summary: "Nakilat signs 10-year charter with QatarEnergy", href: "#" },
    { time: "12:47", source: "BK", summary: "NBK board approves interim dividend of 10 fils", href: "#" },
    { time: "12:20", source: "TDWL", summary: "ACWA Power reaches financial close on NEOM hydrogen tranche", href: "#" },
  ],

  gainers: [
    { symbol: "2082", changePct: 4.2, href: "#" },
    { symbol: "SALIK", changePct: 3.1, href: "#" },
    { symbol: "AMR", changePct: 2.8, href: "#" },
  ],

  losers: [
    { symbol: "2010", changePct: -2.1, href: "#" },
    { symbol: "EMAARDEV", changePct: -1.8, href: "#" },
    { symbol: "ORDS", changePct: -1.4, href: "#" },
  ],
};

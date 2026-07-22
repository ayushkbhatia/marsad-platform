/**
 * Research index (1l) + Article (1k) — SAMPLE / PLACEHOLDER content.
 *
 * Same seam contract as the other `sample/*` modules. 1l is a list over
 * `RESEARCH_CARDS` (+ a featured slot); every card links to `/articles/{slug}`
 * — the 1k template. 1k is ONE reusable article layout; for the fidelity pass
 * every slug renders the single fully-resolved `SAMPLE_ARTICLE` (the banks NIM
 * piece), the one piece the design bakes end-to-end (body blocks, thesis,
 * rating, sidebar, paywall). Real per-slug content + the premium gate re-wire
 * by mapping onto these view-model types and swapping the sample
 * (DEF-RESEARCH-LIVE-DATA); the existing `editorial.ts` + shared editorial
 * components are the adapter basis.
 *
 * No `server-only`: pure data.
 */

export type ArticleTag = "FREE" | "PREMIUM";

// ── Research index (1l) ──────────────────────────────────────────────────────

export interface ResearchCard {
  slug: string;
  topic: string;
  tag: ArticleTag;
  /** Short date, e.g. "28 Jun". */
  date: string;
  headline: string;
  dek: string;
  author: string;
  readMin: number;
}

export interface FeaturedArticle {
  slug: string;
  /** Kicker, e.g. "Featured · Energy". */
  kicker: string;
  tag: ArticleTag;
  headline: string;
  dek: string;
  author: string;
  authorInitials: string;
  /** Mono meta line, e.g. "4 JUL · 21 MIN · MODEL FILE ATTACHED". */
  meta: string;
  photoLabel: string;
}

export interface SubscribeCard {
  cadence: string;
  title: string;
  blurb: string;
}

export interface ResearchIndexData {
  topics: string[];
  featured: FeaturedArticle;
  cards: ResearchCard[];
  subscribe: SubscribeCard[];
}

// ── Article (1k) ─────────────────────────────────────────────────────────────

export interface RatingAttached {
  ticker: string;
  name: string;
  action: string;
  priceTarget: string;
  impliedUpside: number;
}

export type ArticleBlock =
  | { kind: "dropcap"; text: string }
  | { kind: "p"; text: string }
  | { kind: "pullquote"; text: string }
  | { kind: "exhibit"; label: string; title: string; placeholder: string }
  | { kind: "masked"; text: string };

export interface InThisPieceItem {
  ticker: string;
  name: string;
  chgPct: number;
}

export interface RelatedItem {
  slug: string;
  headline: string;
  tag: ArticleTag;
  date: string;
}

export interface Article {
  slug: string;
  section: string;
  tag: ArticleTag;
  headline: string;
  dek: string;
  authorName: string;
  authorRole: string;
  authorInitials: string;
  /** Mono meta line, e.g. "28 JUN 2026 · 24 MIN READ · RATING ATTACHED". */
  meta: string;
  thesis: string[];
  rating: RatingAttached;
  blocks: ArticleBlock[];
  inThisPiece: InThisPieceItem[];
  analyst: { initials: string; name: string; winRate: string };
  related: RelatedItem[];
  paywall: {
    headline: string;
    benefits: string[];
    ctaText: string;
    ctaNote: string;
  };
}

export const RESEARCH_INDEX: ResearchIndexData = {
  topics: ["All", "Banks", "Energy", "Real estate", "Telecom", "Utilities", "Macro", "IPOs"],

  featured: {
    slug: "aramco-jafurah-phase-3",
    kicker: "Featured · Energy",
    tag: "PREMIUM",
    headline: "Aramco after Jafurah Phase 3: gas optionality repriced",
    dek: "A 2.0 bcf/d expansion sanctioned two quarters early changes the earnings mix into 2028 — and the dividend math at $60 Brent. Full model attached for members.",
    author: "Layla Al-Rashid",
    authorInitials: "LR",
    meta: "4 JUL · 21 MIN · MODEL FILE ATTACHED",
    photoLabel: "PHOTO — JAFURAH FLARE STACKS AT DUSK",
  },

  cards: [
    {
      slug: "tadawul-banks-nim-trough",
      topic: "Banks",
      tag: "PREMIUM",
      date: "28 Jun",
      headline: "Tadawul banks: NIM trough is in — who re-rates first?",
      dek: "Q1 deposit repricing is done. The market is still paying trough multiples for mid-cycle margins.",
      author: "Noor Al-Suwaidi",
      readMin: 24,
    },
    {
      slug: "aramco-jafurah-phase-3",
      topic: "Energy",
      tag: "PREMIUM",
      date: "4 Jul",
      headline: "Aramco after Jafurah Phase 3: gas optionality repriced",
      dek: "A 2.0 bcf/d expansion, sanctioned early, changes the earnings mix story into 2028.",
      author: "Layla Al-Rashid",
      readMin: 21,
    },
    {
      slug: "dubai-off-plan-escrow",
      topic: "Real Estate",
      tag: "FREE",
      date: "1 Jul",
      headline: "Dubai off-plan: the escrow data nobody reads",
      dek: "Monthly escrow drawdowns are the cleanest leading indicator for developer margins. We built the series.",
      author: "Tariq Mansour",
      readMin: 11,
    },
    {
      slug: "gcc-budget-maths-brent",
      topic: "Macro",
      tag: "FREE",
      date: "30 Jun",
      headline: "GCC budget maths at $69 Brent: deficits, DMOs and the bond pipeline",
      dek: "Who issues, who draws reserves, and what it means for local liquidity into 2027.",
      author: "Marsad Desk",
      readMin: 9,
    },
    {
      slug: "gulf-utilities-h2",
      topic: "Utilities",
      tag: "PREMIUM",
      date: "3 Jul",
      headline: "The case for boring: Gulf utilities are the trade of H2",
      dek: "Regulated returns, indexed tariffs and 5% yields — while everyone else argues about oil.",
      author: "Faisal Rahman",
      readMin: 18,
    },
    {
      slug: "qnb-q2-margins",
      topic: "Qatar",
      tag: "PREMIUM",
      date: "27 Jun",
      headline: "QNB into Q2: margin math and the loan-mix shift",
      dek: "Consensus models 2.61% NIM. Our deposit tracker says the risk is to the upside.",
      author: "Rania Khalifa",
      readMin: 14,
    },
  ],

  subscribe: [
    {
      cadence: "WEEKLY · BANKS",
      title: "Deposit Wars",
      blurb: "Noor Al-Suwaidi's Sunday ledger of who's paying up for money — and who isn't.",
    },
    {
      cadence: "DAILY · 07:30 GST",
      title: "The Wire Brief",
      blurb: "Every disclosure that matters across seven venues, annotated by the desk in five minutes.",
    },
    {
      cadence: "MONTHLY · THEMATIC",
      title: "Vision 2030 Monitor",
      blurb: "Giga-project capex, the supplier chain, and which listed names actually get paid.",
    },
  ],
};

/** The single fully-resolved 1k piece every 1l card routes to for the pass. */
export const SAMPLE_ARTICLE: Article = {
  slug: "tadawul-banks-nim-trough",
  section: "Banks",
  tag: "PREMIUM",
  headline: "Tadawul banks: the NIM trough is in — who re-rates first?",
  dek: "Q1 deposit repricing is done, funding costs have crested, and the market is still paying trough multiples for mid-cycle margins. We rank all ten names.",
  authorName: "Noor Al-Suwaidi",
  authorRole: "Senior Banks Analyst",
  authorInitials: "NS",
  meta: "28 JUN 2026 · 24 MIN READ · RATING ATTACHED",

  thesis: [
    "Sector NIM bottomed at 2.84% in Q1; our deposit tracker shows CASA mix improving for the first time in seven quarters.",
    "Al Rajhi and Alinma have the highest retail-repricing beta — 60% of the upside case sits in these two names.",
    "Consensus still models flat margins into 2027 — a 40 bp gap to our base case, worth ~12% to sector earnings.",
  ],

  rating: {
    ticker: "1120",
    name: "Al Rajhi Bank",
    action: "Overweight",
    priceTarget: "PT SAR 112.00",
    impliedUpside: 14.1,
  },

  blocks: [
    {
      kind: "dropcap",
      text: 'The most expensive words in Gulf banking this year have been "higher for longer." Twelve months of them convinced the market that Saudi deposit costs would never normalise, that time deposits would keep cannibalising CASA, and that the sector\'s net interest margin — 2.84% at the Q1 trough, per our tracker — was the new permanent state of affairs.',
    },
    {
      kind: "p",
      text: "The data has stopped cooperating with that story. Across the ten Tadawul banks we cover, the share of non-interest-bearing deposits rose 110 bp quarter-on-quarter in Q2 — the first improvement since 2024 — while SAIBOR's drift below 4.8% has quietly repriced the marginal time deposit. Funding cost relief arrives two quarters before consensus models say it should.",
    },
    {
      kind: "pullquote",
      text: "Consensus is paying trough multiples for mid-cycle margins. That gap is the whole trade.",
    },
    {
      kind: "p",
      text: "Who benefits first is a function of retail-repricing beta, and here the dispersion is wide. Exhibit 1 ranks the sector by the share of the loan book that reprices within 12 months against the stickiness of its deposit franchise —",
    },
    {
      kind: "exhibit",
      label: "Exhibit 1",
      title: "Retail repricing beta vs deposit stickiness, 10 banks",
      placeholder: "SCATTER — BETA × CASA SHARE, BUBBLES = MKT CAP",
    },
    {
      kind: "masked",
      text: "Start with Al Rajhi. The largest retail franchise in the Kingdom carries a 68% CASA share and a mortgage book that reprices faster than any peer's corporate ledger. On our numbers, every 25 bp of funding relief adds roughly 3.1% to earnings — twice the sector median. Alinma runs it close on deposit momentum, with the added kicker of…",
    },
  ],

  inThisPiece: [
    { ticker: "1120", name: "Al Rajhi", chgPct: 1.2 },
    { ticker: "1150", name: "Alinma", chgPct: 2.4 },
    { ticker: "1180", name: "SNB", chgPct: -0.4 },
  ],

  analyst: { initials: "NS", name: "Noor Al-Suwaidi", winRate: "WIN RATE 71% · #1 RANKED" },

  related: [
    { slug: "alinma-marsad-score", headline: "Alinma at 78: what the Marsad Score is seeing", tag: "PREMIUM", date: "19 JUN" },
    { slug: "gcc-deposit-wars-charted", headline: "GCC deposit wars, charted: 14 banks in 6 charts", tag: "FREE", date: "11 JUN" },
    { slug: "qnb-q2-margins", headline: "QNB into Q2: margin math and the loan-mix shift", tag: "PREMIUM", date: "27 JUN" },
  ],

  paywall: {
    headline: "The full ranking, the model file and 7 more exhibits are for members.",
    benefits: [
      "All premium research & models",
      "Marsad Score on 812 stocks",
      "Alerts, screens & datapoint feeds",
    ],
    ctaText: "Start 14-day trial — SAR 89/mo",
    ctaNote: "Billed annually · cancel anytime",
  },
};

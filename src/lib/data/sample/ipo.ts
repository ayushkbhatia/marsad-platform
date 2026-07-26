/**
 * IPO Center (22a pipeline / 22b detail / 22c listing day) — SAMPLE content.
 *
 * Same seam contract as the other `sample/*` modules. `ipo_offers`,
 * `ipo_timeline_events` and `listing_debuts` are all 0 rows (producer-pending),
 * so all three IPO screens render from sample here; the real reads
 * (`getIpoPipeline`/`getIpoOffer`/`getIpoJustListed` in `lib/data/calendars.ts`)
 * are the adapter basis (DEF-CALENDARS-LIVE-DATA). Every `[offerSlug]` renders
 * the OQBI detail / Bina listing for the pass (templates, not one-offs).
 */
import type { IpoPipelineData, IpoOfferDetail, IpoListingData } from "@/lib/contracts/ipo";

// ── Pipeline (22a) ───────────────────────────────────────────────────────────
export const SAMPLE_IPO_PIPELINE: IpoPipelineData = {
  kpis: [
    { label: "IN PIPELINE", value: "14" },
    { label: "SUBSCRIPTION OPEN", value: "3", dir: "up" },
    { label: "LISTING THIS MONTH", value: "4" },
    { label: "RAISED YTD · GCC", value: "$6.8B" },
  ],
  stages: [
    {
      label: "SUBSCRIPTION OPEN",
      meta: "3 OFFERS",
      offers: [
        { ticker: "OQBI", company: "OQ Base Industries", venue: "MSX", priceRange: "OMR 0.106–0.111", raise: "$660M", closes: "2 DAYS LEFT", closesChip: true, covered: "3.1×" },
        { ticker: "9614", company: "Masar Logistics", venue: "TDWL", priceRange: "SAR 24.00–26.00", raise: "$320M", closes: "13 JUL", covered: "1.8×" },
        { ticker: "BAYAN", company: "Bayan Foods", venue: "DFM", priceRange: "AED 2.90–3.15", raise: "$242M", closes: "15 JUL", covered: "0.9×", coveredMuted: true },
      ],
    },
    {
      label: "BOOKBUILDING · INSTITUTIONAL",
      meta: "2 OFFERS",
      offers: [
        { ticker: "KDC", company: "Khaleej District Cooling", venue: "ADX", priceRange: "AED 1.55–1.70", raise: "$381M", closes: "PRICES 21 JUL", covered: "INST ONLY", coveredMuted: true },
        { ticker: "NKLA", company: "Nakhla Hospitality", venue: "TDWL", priceRange: "TBD", raise: "$560M est", closes: "PRICES 28 JUL", covered: "INST ONLY", coveredMuted: true },
      ],
    },
    {
      label: "ANNOUNCED & FILED",
      meta: "INTENTION TO FLOAT · DRAFT PROSPECTUS",
      offers: [
        { ticker: "—", company: "Wadi Grocers Holding", venue: "TDWL", priceRange: "CMA FILING 2 JUL", raise: "$430M est", closes: "Q4 26", covered: "" },
        { ticker: "—", company: "Sila Fintech", venue: "DFM", priceRange: "INTENTION 30 JUN", raise: "$300M est", closes: "Q4 26", covered: "" },
        { ticker: "—", company: "Muharraq Ports Services", venue: "BHB", priceRange: "DRAFT PROSPECTUS", raise: "$180M est", closes: "H1 27", covered: "" },
      ],
    },
  ],
  justListed: [
    { ticker: "9613", company: "Tahakum Security", venue: "TDWL", price: "34.60", changePct: 33.1, listed: "LISTED 24 JUN" },
    { ticker: "AWQF", company: "Awqaf REIT", venue: "DFM", price: "1.02", changePct: 2.0, listed: "LISTED 12 JUN" },
    { ticker: "GHAF", company: "Ghaf Materials", venue: "ADX", price: "2.31", changePct: -8.7, listed: "LISTED 2 JUN" },
  ],
  neverMiss: {
    kicker: "NEVER MISS A WINDOW",
    headline: "Get pinged the minute books open",
    body: "Push + email when any GCC offer opens for retail subscription — or only venues you follow.",
    cta: "Create IPO alert →",
  },
  howItWorks: [
    "Retail vs institutional tranches",
    "Allocation & refunds, explained",
    "Which brokers take applications",
  ],
};

// ── Detail (22b) ─────────────────────────────────────────────────────────────
export const SAMPLE_IPO_DETAIL: IpoOfferDetail = {
  slug: "oq-base-industries",
  ticker: "OQBI",
  company: "OQ Base Industries",
  meta: "MSX · IPO-1 · Energy Processing",
  statusChip: "SUBSCRIPTION OPEN",
  timeline: [
    { label: "ANNOUNCED", value: "12 May ✓", state: "done" },
    { label: "BOOKBUILT · INST", value: "24 Jun ✓ · 4.6×", state: "done" },
    { label: "RETAIL SUBSCRIPTION", value: "28 Jun – 9 Jul · open now", state: "current" },
    { label: "ALLOCATION", value: "14 Jul", state: "future" },
    { label: "LISTING", value: "~22 Jul", state: "future" },
  ],
  facts: [
    { label: "PRICE RANGE", value: "OMR 0.106–0.111" },
    { label: "OFFER SIZE", value: "49% · 2.40bn sh" },
    { label: "RAISE AT TOP", value: "≈ $660M" },
    { label: "IMPLIED MKT CAP", value: "$1.35B" },
    { label: "RETAIL TRANCHE", value: "30%" },
    { label: "MIN LOT", value: "100 sh · OMR 11.10" },
    { label: "DIVIDEND POLICY", value: "90% payout" },
    { label: "REFUNDS BY", value: "16 Jul" },
  ],
  useOfProceeds: [
    { label: "Selling shareholder", pct: "60%", barWidth: 150 },
    { label: "Debt paydown", pct: "25%", barWidth: 62 },
    { label: "Growth capex", pct: "15%", barWidth: 37 },
  ],
  proceedsNote:
    "A 60% secondary component means most proceeds go to the parent, not the balance sheet — standard for GCC privatization floats.",
  financials: {
    periods: ["OMR M", "FY23", "FY24", "FY25E"],
    rows: [
      { label: "Revenue", values: ["742", "781", "804"] },
      { label: "EBITDA", values: ["296", "312", "328"] },
      { label: "Net income", values: ["148", "161", "170"] },
      { label: "Implied P/E (top)", values: ["—", "—", "7.9×"] },
      { label: "Implied yield (top)", values: ["—", "—", "11.4%"] },
    ],
  },
  countdown: {
    kicker: "RETAIL BOOKS CLOSE IN",
    value: "2d 09h",
    sub: "9 JUL 13:00 GST · RETAIL 3.1× COVERED",
    cta: "Subscribe via your broker",
  },
  brokers: ["Ahli Invest", "Gulf Securities", "MSX Direct", "Sohar Capital"],
  marsadTake: {
    headline: "Fair value OMR 0.128 — subscribe at the top of the range",
    body: "The 11% implied yield over-compensates for offtake concentration; we model 15% upside to fair value at listing.",
    cta: "Unlock the take →",
  },
};

// ── Listing day (22c) ────────────────────────────────────────────────────────
export const SAMPLE_IPO_LISTING: IpoListingData = {
  slug: "bina-modular-construction",
  ticker: "9615",
  company: "Bina Modular Construction",
  meta: "Tadawul · Industrials",
  liveLabel: "LIVE · TDWL 14:32 GST",
  kpis: [
    { label: "OFFER PRICE", value: "22.00" },
    { label: "OPENED", value: "26.40", delta: "+20.0%", dir: "up" },
    { label: "LAST", value: "25.15", delta: "+14.3%", dir: "up" },
    { label: "DAY RANGE", value: "24.80 – 27.50" },
    { label: "TURNOVER", value: "SAR 1.9B" },
  ],
  chart: {
    offerY: 196,
    points:
      "0,72 40,60 80,84 120,96 160,78 200,104 240,120 280,110 320,132 360,118 400,140 440,128 480,148 520,136 560,124 600,138 640,120 680,112 720,116",
    offerLabel: "OFFER 22.00",
    openLabel: "OPEN 26.40",
    openTop: 58,
  },
  chartCaptions: ["OPENING AUCTION: 26.40 · 4.2M SH", "VWAP 25.62", "FREE FLOAT TRADED: 31%"],
  wire: {
    kicker: "THE WIRE · 10:04 GST",
    headline: "Bina pops 20% at the open, settles mid-teens as flippers meet index demand",
    cta: "Follow on the Newswire →",
  },
  allocation: [
    { label: "Retail allocation", value: "14% of applied" },
    { label: "Retail coverage", value: "7.1×" },
    { label: "Institutional coverage", value: "9.4×" },
    { label: "Refunds credited", value: "by 16 Jul" },
  ],
  scorePending:
    "Scores need 90 trading days of data. The first Score on 9615 is expected 28 Nov 2026; factor grades will seed from the prospectus financials.",
  scoreExpectedDate: "28 Nov 2026",
  listedPeers: [
    { ticker: "9601", company: "Deema Contracting", venue: "TDWL", price: "41.20", changePct: 0.4, scoreRating: "66 · HOLD" },
    { ticker: "9602", company: "Rakeen Builders", venue: "TDWL", price: "18.75", changePct: -1.2, scoreRating: "58 · HOLD" },
    { ticker: "GHAF", company: "Ghaf Materials", venue: "ADX", price: "2.31", changePct: -8.7, scoreRating: "49 · UW" },
  ],
};

import test from "node:test";
import assert from "node:assert/strict";
import type { IpoKpis, IpoOfferItem } from "@/lib/data/calendars";

/**
 * Fixture test for the IPO adapters (BRIDGE-BUILD-PLAN P2.5).
 *
 * WHY THIS FILE EXISTS: `ipo_offers`, `ipo_timeline_events` and
 * `listing_debuts` are **all 0 rows** (measured 2026-07-26), so all three IPO
 * screens ship an honest `EmptyState awaitingFeed` / `notFound()` and no live
 * read can prove the mapping works. This test is that proof: it feeds the
 * adapters hand-built non-empty reads (FIXTURES, never rendered in production)
 * and asserts the `IpoPipelineData` / `IpoOfferDetail` / `IpoListingData`
 * contracts they produce, so the IPO Center lights up correctly the moment the
 * producer lands (P7.2).
 *
 * RUNNING IT (Node's built-in runner + native type-stripping, no dependency):
 *
 *     node --test "src/lib/data/adapters/__tests__/ipo.test.ts"
 *
 * The adapter is imported through a non-literal specifier so `tsc` (no literal
 * `.ts` extension) and Node (extension required) are both satisfied.
 */

type AdapterModule = typeof import("../ipo");

const SPECIFIER = "../ipo" + ".ts";

async function loadAdapter(): Promise<AdapterModule> {
  return (await import(SPECIFIER)) as AdapterModule;
}

/** Plausible-but-synthetic offers. Fixture only — never rendered. */
function offer(over: Partial<IpoOfferItem> & Pick<IpoOfferItem, "id" | "companyName">): IpoOfferItem {
  return {
    securityId: null,
    ticker: null,
    venueCode: "MSX",
    stage: "retail_subscription",
    localCurrency: "OMR",
    priceRangeLow: 0.106,
    priceRangeHigh: 0.111,
    finalPrice: null,
    offerSizePct: 49,
    sharesOffered: 2_400_000_000,
    raiseAmount: 660_000_000,
    impliedMcap: 1_350_000_000,
    impliedPe: 7.9,
    impliedYield: 11.4,
    retailTranchePct: 30,
    minLot: 100,
    dividendPolicy: "90% payout",
    useOfProceeds: { "Selling shareholder": 60, "Debt paydown": 25, "Growth capex": 15 },
    brokers: ["Ahli Invest", { name: "Gulf Securities" }],
    refundsBy: "2026-07-16",
    retailOpenAt: "2026-06-28",
    retailCloseAt: "2026-07-09",
    expectedListing: "2026-07-22",
    objectState: "VERIFIED",
    prospectusFilingId: null,
    ...over,
  };
}

const OPEN = offer({ id: 1, companyName: "Basalt Industries", ticker: "BSLT" });
const BOOK = offer({
  id: 2,
  companyName: "Khaleej Cooling",
  ticker: "KDC",
  venueCode: "ADX",
  localCurrency: "AED",
  stage: "institutional_bookbuild",
  priceRangeLow: 1.55,
  priceRangeHigh: 1.7,
  retailOpenAt: null,
  retailCloseAt: null,
});
const FILED = offer({
  id: 3,
  companyName: "Wadi Grocers Holding",
  venueCode: "TDWL",
  localCurrency: "SAR",
  stage: "intention_to_float",
  priceRangeLow: null,
  priceRangeHigh: null,
  retailOpenAt: null,
  retailCloseAt: null,
  refundsBy: null,
  expectedListing: null,
  raiseAmount: 430_000_000,
});
const LISTED = offer({
  id: 4,
  companyName: "Tahakum Security",
  ticker: "9613",
  securityId: 501,
  venueCode: "TDWL",
  localCurrency: "SAR",
  stage: "listed",
  finalPrice: 26,
  expectedListing: "2026-06-24",
});

const KPIS: IpoKpis = { inPipeline: 4, subscriptionOpen: 1, listingThisMonth: 2, raisedYtd: 6_800_000_000 };
const NO_KPIS: IpoKpis = { inPipeline: 0, subscriptionOpen: 0, listingThisMonth: 0, raisedYtd: 0 };

// ── 22a pipeline ─────────────────────────────────────────────────────────────

test("no offers → null (the awaitingFeed signal, today's live state)", async () => {
  const { toIpoPipeline } = await loadAdapter();
  assert.equal(toIpoPipeline({ offers: [], justListed: [], kpis: NO_KPIS }), null);
});

test("offers group into ordered stage bands with an offer count", async () => {
  const { toIpoPipeline } = await loadAdapter();
  const p = toIpoPipeline({ offers: [FILED, LISTED, BOOK, OPEN], justListed: [], kpis: KPIS });
  assert.ok(p);
  assert.deepEqual(
    p.stages.map((s) => [s.label, s.meta, s.offers.length]),
    [
      ["SUBSCRIPTION OPEN", "1 OFFER", 1],
      ["BOOKBUILDING · INSTITUTIONAL", "1 OFFER", 1],
      ["ANNOUNCED & FILED", "1 OFFER", 1],
      ["LISTED", "1 OFFER", 1],
    ],
  );
});

test("an open offer prices in local currency, raises in USD and chips its close", async () => {
  const { toIpoPipeline } = await loadAdapter();
  const p = toIpoPipeline({ offers: [OPEN], justListed: [], kpis: KPIS });
  assert.ok(p);
  assert.deepEqual(p.stages[0].offers[0], {
    ticker: "BSLT",
    company: "Basalt Industries",
    venue: "MSX",
    priceRange: "OMR 0.106–0.111",
    raise: "$660M",
    closes: "9 JUL",
    closesChip: true,
    // Coverage lives on `ipo_timeline_events`, which nothing reads — blank,
    // never a fabricated "3.1×".
    covered: "",
  });
});

test("an unpriced filing says TBD and never invents a range or a close", async () => {
  const { toIpoPipeline } = await loadAdapter();
  const p = toIpoPipeline({ offers: [FILED], justListed: [], kpis: KPIS });
  assert.ok(p);
  const row = p.stages[0].offers[0];
  assert.equal(row.ticker, "—");
  assert.equal(row.priceRange, "TBD");
  assert.equal(row.closes, "—");
  assert.equal(row.closesChip, undefined);
});

test("just-listed rows need a real post-listing price — no price map, no rows", async () => {
  const { toIpoPipeline } = await loadAdapter();
  const without = toIpoPipeline({ offers: [OPEN], justListed: [LISTED], kpis: KPIS });
  assert.ok(without);
  assert.deepEqual(without.justListed, []);

  const withPrices = toIpoPipeline({
    offers: [OPEN],
    justListed: [LISTED],
    kpis: KPIS,
    lastPrices: new Map([[501, 34.6]]),
  });
  assert.ok(withPrices);
  assert.equal(withPrices.justListed.length, 1);
  const [debut] = withPrices.justListed;
  assert.equal(debut.ticker, "9613");
  assert.equal(debut.price, "34.60");
  assert.equal(Number(debut.changePct.toFixed(1)), 33.1);
  assert.equal(debut.listed, "LISTED 24 JUN");
});

test("pipeline KPIs are counts + a USD YTD total, dashed when zero", async () => {
  const { toIpoPipeline } = await loadAdapter();
  const p = toIpoPipeline({ offers: [OPEN], justListed: [], kpis: KPIS });
  assert.ok(p);
  assert.deepEqual(p.kpis, [
    { label: "IN PIPELINE", value: "4" },
    { label: "SUBSCRIPTION OPEN", value: "1" },
    { label: "LISTING THIS MONTH", value: "2" },
    { label: "RAISED YTD · GCC", value: "$6.8B" },
  ]);

  const zero = toIpoPipeline({ offers: [OPEN], justListed: [], kpis: NO_KPIS });
  assert.equal(zero?.kpis[3].value, "—");
});

// ── 22b offer detail ─────────────────────────────────────────────────────────

test("the timeline states are relative to the caller's date, not the clock", async () => {
  const { toIpoOfferDetail } = await loadAdapter();
  const mid = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-02" });
  assert.deepEqual(mid.timeline, [
    { label: "RETAIL SUBSCRIPTION", value: "28 JUN – 9 JUL", state: "current" },
    { label: "REFUNDS BY", value: "16 JUL", state: "future" },
    { label: "LISTING", value: "22 JUL", state: "future" },
  ]);

  const after = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-23" });
  assert.deepEqual(
    after.timeline.map((s) => s.state),
    ["done", "done", "done"],
  );
});

test("offer facts format every published column and dash the rest", async () => {
  const { toIpoOfferDetail } = await loadAdapter();
  const d = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-02" });
  const facts = Object.fromEntries(d.facts.map((f) => [f.label, f.value]));
  assert.equal(facts["PRICE RANGE"], "OMR 0.106–0.111");
  assert.equal(facts["OFFER SIZE"], "49% · 2.40bn sh");
  assert.equal(facts["RAISE"], "$660M");
  assert.equal(facts["IMPLIED MKT CAP"], "$1.35B");
  assert.equal(facts["IMPLIED P/E"], "7.9×");
  assert.equal(facts["MIN LOT"], "100 sh · OMR 11.10");
  assert.equal(facts["REFUNDS BY"], "16 JUL");

  const bare = toIpoOfferDetail({ offer: FILED, slug: "wadi-grocers-holding-3", todayISO: "2026-07-02" });
  const bareFacts = Object.fromEntries(bare.facts.map((f) => [f.label, f.value]));
  assert.equal(bareFacts["PRICE RANGE"], "TBD");
  assert.equal(bareFacts["IMPLIED MKT CAP"], "$1.35B");
  assert.equal(bare.timeline.length, 0);
});

test("use of proceeds and brokers parse the jsonb shapes; unknown shapes → empty", async () => {
  const { toIpoOfferDetail } = await loadAdapter();
  const d = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-02" });
  assert.deepEqual(d.useOfProceeds, [
    { label: "Selling shareholder", pct: "60%", barWidth: 150 },
    { label: "Debt paydown", pct: "25%", barWidth: 63 },
    { label: "Growth capex", pct: "15%", barWidth: 38 },
  ]);
  assert.deepEqual(d.brokers, ["Ahli Invest", "Gulf Securities"]);
  assert.match(d.proceedsNote, /prospectus/);

  const junk = toIpoOfferDetail({
    offer: offer({ id: 7, companyName: "No Docs Co", useOfProceeds: "n/a", brokers: 42 }),
    slug: "no-docs-co-7",
    todayISO: "2026-07-02",
  });
  assert.deepEqual(junk.useOfProceeds, []);
  assert.deepEqual(junk.brokers, []);
  assert.match(junk.proceedsNote, /No use-of-proceeds breakdown/);
});

test("the countdown counts calendar days to the close and never fabricates a take", async () => {
  const { toIpoOfferDetail } = await loadAdapter();
  const open = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-02" });
  assert.equal(open.countdown.kicker, "RETAIL BOOKS CLOSE IN");
  assert.equal(open.countdown.value, "7d");
  assert.equal(open.countdown.sub, "9 JUL 2026 · RETAIL TRANCHE 30%");

  const closed = toIpoOfferDetail({ offer: OPEN, slug: "basalt-industries-1", todayISO: "2026-07-23" });
  assert.equal(closed.countdown.value, "CLOSED");

  const none = toIpoOfferDetail({ offer: FILED, slug: "wadi-grocers-holding-3", todayISO: "2026-07-02" });
  assert.equal(none.countdown.value, "—");
  assert.equal(none.countdown.sub, "NO RETAIL WINDOW PUBLISHED");

  // No desk view exists for any offer — the premium card must say so.
  assert.match(open.marsadTake.headline, /No Marsad take/);
  // Pre-IPO financials have no producer.
  assert.deepEqual(open.financials, { periods: [], rows: [] });
});

// ── 22c listing day ──────────────────────────────────────────────────────────

test("no debut record → null (the awaitingFeed signal, today's live state)", async () => {
  const { toIpoListing } = await loadAdapter();
  assert.equal(toIpoListing({ offer: LISTED, debut: null, slug: "tahakum-security-4" }), null);
});

test("a debut maps its session figures, allocation recap and score-pending date", async () => {
  const { toIpoListing } = await loadAdapter();
  const l = toIpoListing({
    offer: LISTED,
    slug: "tahakum-security-4",
    debut: {
      ipoId: 4,
      securityId: 501,
      debutDate: "2026-06-24",
      offerPrice: 22,
      openPrice: 26.4,
      auctionPrice: 26.4,
      auctionVolume: 4_200_000,
      vwap: 25.62,
      freeFloatTradedPct: 31,
      allocationRecap: { "Retail allocation": "14% of applied", "Retail coverage": "7.1×" },
    },
    intradayCloses: [26.4, 25.1, 25.9, 25.15],
  });
  assert.ok(l);
  assert.equal(l.ticker, "9613");
  assert.equal(l.meta, "TDWL · DEBUT 24 JUN");
  assert.deepEqual(l.kpis, [
    { label: "OFFER PRICE · SAR", value: "22.00" },
    { label: "OPENED", value: "26.40", delta: "+20.0%", dir: "up" },
    { label: "VWAP", value: "25.62" },
    { label: "AUCTION VOLUME", value: "4m" },
    { label: "FREE FLOAT TRADED", value: "31%" },
  ]);
  assert.deepEqual(l.allocation, [
    { label: "Retail allocation", value: "14% of applied" },
    { label: "Retail coverage", value: "7.1×" },
  ]);
  assert.deepEqual(l.chartCaptions, [
    "OPENING AUCTION: 26.40 · 4m sh",
    "VWAP 25.62",
    "FREE FLOAT TRADED: 31%",
  ]);
  // 90 trading days ≈ 126 calendar days after the debut.
  assert.equal(l.scoreExpectedDate, "28 OCT 2026");
  assert.match(l.scorePending, /expected 28 OCT 2026/);
  // Neither peers nor a wire story have a producer — stated, not invented.
  assert.deepEqual(l.listedPeers, []);
  assert.match(l.wire.headline, /No wire story/);
});

test("the intraday path is drawn only from real closes", async () => {
  const { toIpoListing } = await loadAdapter();
  const base = {
    ipoId: 4,
    securityId: 501,
    debutDate: "2026-06-24",
    offerPrice: 22,
    openPrice: 26.4,
    auctionPrice: null,
    auctionVolume: null,
    vwap: null,
    freeFloatTradedPct: null,
    allocationRecap: null,
  };

  const withSeries = toIpoListing({
    offer: LISTED,
    slug: "tahakum-security-4",
    debut: base,
    intradayCloses: [26.4, 25.1, 25.9, 25.15],
  });
  assert.ok(withSeries);
  assert.equal(withSeries.chart.points.split(" ").length, 4);
  assert.equal(withSeries.chart.offerLabel, "OFFER 22.00");
  assert.equal(withSeries.chart.openLabel, "OPEN 26.40");

  const noSeries = toIpoListing({ offer: LISTED, slug: "tahakum-security-4", debut: base });
  assert.ok(noSeries);
  assert.equal(noSeries.chart.points, "");
  assert.equal(noSeries.chart.offerY, 0);
  assert.deepEqual(noSeries.chartCaptions, []);
  assert.deepEqual(noSeries.allocation, []);
});

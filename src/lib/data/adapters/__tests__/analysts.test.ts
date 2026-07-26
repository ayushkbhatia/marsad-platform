import test from "node:test";
import assert from "node:assert/strict";
import type { AnalystLeaderboardRow, AnalystProfileDetail, AnalystCallView } from "@/lib/data/editorial";

/**
 * Fixture test for the Coverage Desk / Analyst Profile adapter
 * (BRIDGE-BUILD-PLAN P3.5).
 *
 * WHY THIS FILE EXISTS: `public.analysts` and `public.analyst_calls` are both
 * **0 rows**, and the owner ruled on 2026-07-27 that Marsad will NOT seed
 * fictional analysts — publishing invented people making invented calls on real
 * listed companies is not placeholder copy. So both surfaces ship an honest
 * `EmptyState awaitingFeed` and there is no live read that can prove the
 * mapping works. This test is that proof: it feeds the adapter hand-built,
 * obviously-synthetic FIXTURES (never rendered in production, never inserted
 * anywhere) and asserts the contract they produce. When the roster is
 * onboarded, this is the guarantee that 1i/1j light up correctly instead of
 * silently mis-rendering.
 *
 * RUNNING IT: the Next app has no test runner in `package.json` and adding one
 * is out of scope, so this runs on Node's built-in runner with native
 * TypeScript type-stripping — no dependency, no config:
 *
 *     node --test "src/lib/data/adapters/__tests__/analysts.test.ts"
 *
 * The adapter is imported dynamically through a non-literal specifier so that
 * `tsc` (which forbids a literal `.ts` import extension without
 * `allowImportingTsExtensions`) and Node (which requires the extension) are
 * both satisfied. `typeof import(...)` keeps the module fully typed. Only the
 * PURE half of the adapter is exercised — the loaders reach for Supabase
 * through dynamic imports and are never called here.
 */

type AdapterModule = typeof import("../analysts");

const SPECIFIER = "../analysts" + ".ts";

async function loadAdapter(): Promise<AdapterModule> {
  return (await import(SPECIFIER)) as AdapterModule;
}

/** Reference "now" for every relative-date assertion. 2026-07-27 is a Monday. */
const NOW = "2026-07-27";

// ── fixtures ─────────────────────────────────────────────────────────────────

function roster(): Array<import("../analysts").AnalystIdentity> {
  return [
    {
      slug: "test-analyst-one",
      displayName: "Fixture One",
      title: "Banks",
      credential: "CFA",
      bio: "Fixture bio.",
      joinedAt: "2023-04-01T00:00:00Z",
      principalId: "p-1",
    },
    {
      slug: "test-analyst-two",
      displayName: "Fixture Two",
      title: "Energy",
      credential: null,
      bio: null,
      joinedAt: "2024-01-15T00:00:00Z",
      principalId: "p-2",
    },
    {
      // Onboarded but nothing closed yet — must NOT appear on the leaderboard.
      slug: "test-analyst-three",
      displayName: "Fixture Three",
      title: null,
      credential: null,
      bio: null,
      joinedAt: "2026-07-01T00:00:00Z",
      principalId: "p-3",
    },
  ];
}

function stats(): AnalystLeaderboardRow[] {
  return [
    {
      analystPrincipalId: "p-2",
      title: "Energy",
      isExternal: false,
      namesCovered: 5,
      closedCallCount: 8,
      winRatePct: 62.5,
      avgCallReturnPct: 11.25,
      lastFive: [true, true, false, true, true],
    },
    {
      analystPrincipalId: "p-1",
      title: "Banks",
      isExternal: true,
      namesCovered: 9,
      closedCallCount: 20,
      winRatePct: 55.4,
      avgCallReturnPct: 4.2,
      lastFive: [false, true, true],
    },
    {
      analystPrincipalId: "p-3",
      title: null,
      isExternal: false,
      namesCovered: 2,
      closedCallCount: 0,
      winRatePct: null,
      avgCallReturnPct: null,
      lastFive: [],
    },
  ];
}

function deskCalls(): Array<import("../analysts").DeskCall> {
  return [
    // p-1 on 101: initiation last year, upgraded today → UPGRADE only.
    {
      analystPrincipalId: "p-1",
      securityId: 101,
      ticker: "QNBK",
      rating: "hold",
      priceTarget: 18,
      currency: "QAR",
      publishedAt: "2025-11-02T09:00:00Z",
      closedAt: null,
    },
    {
      analystPrincipalId: "p-1",
      securityId: 101,
      ticker: "QNBK",
      rating: "buy",
      priceTarget: 21,
      currency: "QAR",
      publishedAt: "2026-07-27T06:30:00Z",
      closedAt: null,
    },
    // p-2 on 202: same rating, target cut three days ago → PT CUT.
    {
      analystPrincipalId: "p-2",
      securityId: 202,
      ticker: "2010",
      rating: "neutral",
      priceTarget: 78,
      currency: "SAR",
      publishedAt: "2026-02-10T09:00:00Z",
      closedAt: null,
    },
    {
      analystPrincipalId: "p-2",
      securityId: 202,
      ticker: "2010",
      rating: "neutral",
      priceTarget: 71,
      currency: "SAR",
      publishedAt: "2026-07-24T09:00:00Z",
      closedAt: null,
    },
    // p-2 on 303: brand-new coverage two days ago → INITIATION.
    {
      analystPrincipalId: "p-2",
      securityId: 303,
      ticker: "EMAAR",
      rating: "buy",
      priceTarget: 16.5,
      currency: "AED",
      publishedAt: "2026-07-25T09:00:00Z",
      closedAt: null,
    },
    // p-1 on 404: an old initiation, outside the week → dropped.
    {
      analystPrincipalId: "p-1",
      securityId: 404,
      ticker: "1120",
      rating: "buy",
      priceTarget: 104,
      currency: "SAR",
      publishedAt: "2026-05-02T09:00:00Z",
      closedAt: null,
    },
  ];
}

function deskInput(): import("../analysts").CoverageDeskInput {
  return {
    roster: roster(),
    stats: stats(),
    sectors: [
      { sector: "banks", count: 12 },
      { sector: "real_estate", count: 6 },
      { sector: "utilities", count: 3 },
    ],
    recentCalls: deskCalls(),
    latest: [],
    now: NOW,
  };
}

function call(over: Partial<AnalystCallView> & { id: number; securityId: number }): AnalystCallView {
  return {
    ticker: "QNBK",
    venueCode: "QE",
    name: "QNB Group",
    rating: "buy",
    priceTarget: 21,
    publishedAt: "2026-01-12T09:00:00Z",
    priceAtPublication: 16,
    indexLevelAtPublication: 10000,
    closedAt: null,
    closePrice: null,
    callReturnPct: null,
    vsIndexPct: null,
    contentId: null,
    ...over,
  };
}

function profileDetail(): AnalystProfileDetail {
  const calls: AnalystCallView[] = [
    // Open, marked to market from the live quote (18 vs 16 published) → +12.5%.
    call({ id: 1, securityId: 101 }),
    // Open, DB already carries a return → used verbatim, quote ignored.
    call({
      id: 2,
      securityId: 202,
      ticker: "2010",
      venueCode: "TDWL",
      name: "SABIC",
      rating: "neutral",
      priceTarget: 71,
      publishedAt: "2026-03-02T09:00:00Z",
      priceAtPublication: 70,
      callReturnPct: 3.5,
      contentId: "c-1",
    }),
    // Open, no quote and no DB return → omitted from the coverage table.
    call({
      id: 3,
      securityId: 303,
      ticker: "OMAN",
      venueCode: "MSX",
      name: "Untraded Co",
      rating: "buy",
      priceTarget: null,
      priceAtPublication: 1,
    }),
    // Two closed calls → the chart has a series.
    call({
      id: 4,
      securityId: 404,
      ticker: "1120",
      venueCode: "TDWL",
      name: "Al Rajhi Bank",
      publishedAt: "2025-02-01T09:00:00Z",
      closedAt: "2025-08-31T09:00:00Z",
      closePrice: 100,
      callReturnPct: 10,
      vsIndexPct: 4,
    }),
    call({
      id: 5,
      securityId: 505,
      ticker: "FAB",
      venueCode: "ADX",
      name: "First Abu Dhabi Bank",
      publishedAt: "2025-09-01T09:00:00Z",
      closedAt: "2026-02-28T09:00:00Z",
      closePrice: 12,
      callReturnPct: -2,
      vsIndexPct: -3,
    }),
  ];

  return {
    slug: "test-analyst-one",
    displayName: "Fixture One",
    title: "Banks",
    credential: "CFA",
    bio: "Fixture bio.",
    isExternal: false,
    joinedAt: "2023-04-01T00:00:00Z",
    principalId: "p-1",
    calls,
    namesCovered: 5,
    openCallCount: 3,
    closedCallCount: 2,
    winRatePct: 50,
    avgCallReturnPct: 4,
  };
}

function profileInput(): import("../analysts").AnalystProfileInput {
  return {
    detail: profileDetail(),
    rank: 2,
    securityMeta: {
      101: { currency: "QAR", last: 18 },
      202: { currency: "SAR", last: null },
      404: { currency: "SAR", last: 110 },
      505: { currency: "AED", last: 12 },
    },
    content: [
      {
        id: "c-1",
        slug: "fixture-piece",
        headline: "Fixture piece headline",
        isPremium: true,
        publishedAt: "2026-03-02T09:00:00Z",
        readMinutes: 12,
      },
    ],
  };
}

// ── Coverage Desk (1i) ───────────────────────────────────────────────────────

test("empty roster → null (the awaitingFeed signal, today's live state)", async () => {
  const { toCoverageDesk } = await loadAdapter();
  assert.equal(toCoverageDesk({ ...deskInput(), roster: [], stats: [], recentCalls: [] }), null);
});

test("a roster with no CLOSED calls is still not a leaderboard", async () => {
  const { toCoverageDesk } = await loadAdapter();
  const input = deskInput();
  const noClosed = input.stats.map((s) => ({ ...s, closedCallCount: 0, winRatePct: null, avgCallReturnPct: null }));
  assert.equal(toCoverageDesk({ ...input, stats: noClosed }), null);
});

test("leaderboard ranks by real avg call return and never invents a follower count", async () => {
  const { toCoverageDesk } = await loadAdapter();
  const desk = toCoverageDesk(deskInput());
  assert.ok(desk);
  assert.deepEqual(
    desk.analysts.map((a) => [a.rank, a.slug, a.name, a.initials, a.focus, a.names, a.winRate, a.avgReturn]),
    [
      [1, "test-analyst-two", "Fixture Two", "FT", "Energy", 5, 63, 11.25],
      [2, "test-analyst-one", "Fixture One", "FO", "Banks", 9, 55, 4.2],
    ],
  );
  // p-3 is onboarded but has no closed track record — ranking it would require
  // showing 0% / +0.0%, i.e. a fabricated score.
  assert.equal(
    desk.analysts.some((a) => a.slug === "test-analyst-three"),
    false,
  );
  assert.deepEqual(new Set(desk.analysts.map((a) => a.followers)), new Set(["—"]));
  assert.deepEqual(desk.analysts[0].last5, [true, true, false, true, true]);
});

test("sector bars scale off the real max and totalNames is their sum", async () => {
  const { toCoverageDesk } = await loadAdapter();
  const desk = toCoverageDesk(deskInput());
  assert.ok(desk);
  assert.deepEqual(desk.sectors, [
    { sector: "Banks", count: 12, barWidth: 170 },
    { sector: "Real estate", count: 6, barWidth: 85 },
    { sector: "Utilities", count: 3, barWidth: 43 },
  ]);
  assert.equal(desk.totalNames, 21);
  assert.equal(desk.subtitle, "2 ranked analysts · 21 GCC names under coverage · every call tracked and scored in public");
});

test("the un-produced desk fields degrade honestly instead of being filled in", async () => {
  const { toCoverageDesk } = await loadAdapter();
  const desk = toCoverageDesk(deskInput());
  assert.ok(desk);
  // No content→analyst byline join exists yet, so the caller passes [].
  assert.deepEqual(desk.latest, []);
  // No initiation-vote table exists at all.
  assert.deepEqual(desk.requestCoverage, { leadName: "No nominations yet", votes: 0 });
});

test("ratings changes are derived from consecutive calls, inside a 7-day window", async () => {
  const { deriveRatingChanges } = await loadAdapter();
  const changes = deriveRatingChanges(deskCalls(), roster(), NOW);

  assert.deepEqual(changes, [
    {
      direction: "up",
      type: "UPGRADE",
      ticker: "QNBK",
      date: "TODAY",
      note: "Hold → Buy · PT QAR 21.00",
      analyst: "F. One",
    },
    {
      direction: "up",
      type: "INITIATION",
      ticker: "EMAAR",
      date: "SAT",
      note: "Buy · PT AED 16.50",
      analyst: "F. Two",
    },
    {
      direction: "down",
      type: "PT CUT",
      ticker: "2010",
      date: "FRI",
      note: "Neutral · PT 78.00 → 71.00",
      analyst: "F. Two",
    },
  ]);
});

test("a rating move we cannot classify is dropped, not guessed", async () => {
  const { deriveRatingChanges } = await loadAdapter();
  const calls = [
    {
      analystPrincipalId: "p-1",
      securityId: 909,
      ticker: "XXXX",
      rating: "under review",
      priceTarget: null,
      currency: null,
      publishedAt: "2026-07-26T09:00:00Z",
      closedAt: null,
    },
  ];
  assert.deepEqual(deriveRatingChanges(calls, roster(), NOW), []);
});

// ── Analyst Profile (1j) ─────────────────────────────────────────────────────

test("profile header and stat strip come straight off the roster row", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const p = toAnalystProfile(profileInput());
  assert.equal(p.slug, "test-analyst-one");
  assert.equal(p.name, "Fixture One");
  assert.equal(p.initials, "FO");
  assert.equal(p.rank, 2);
  assert.equal(p.credential, "Banks · CFA");
  assert.equal(p.followers, "—");
  assert.deepEqual(p.stats, [
    { label: "WIN RATE", value: "50%" },
    { label: "AVG CALL RETURN", value: "+4.0%", dir: "up" },
    { label: "CLOSED CALLS", value: "2" },
    { label: "UNDER COVERAGE", value: "5 names" },
    { label: "PUBLISHING SINCE", value: "2023" },
  ]);
});

test("a brand-new analyst shows dashes, not zeros", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const input = profileInput();
  const p = toAnalystProfile({
    ...input,
    detail: {
      ...input.detail,
      calls: [],
      namesCovered: 0,
      openCallCount: 0,
      closedCallCount: 0,
      winRatePct: null,
      avgCallReturnPct: null,
    },
    content: [],
  });
  assert.equal(p.stats[0].value, "—");
  assert.equal(p.stats[1].value, "—");
  assert.equal(p.stats[1].dir, undefined);
  assert.deepEqual(p.coverage, []);
  assert.deepEqual(p.chart.analystPoints, "");
  assert.equal(p.chart.legendAnalyst, "NO CLOSED CALLS YET");
  assert.equal(p.pinnedCall.quote, "No open call to pin yet.");
  assert.equal(p.publishedCount, "—");
});

test("coverage table = open calls, DB return preferred, quote-marked fallback, unpriceable dropped", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const p = toAnalystProfile(profileInput());
  assert.deepEqual(p.coverage, [
    {
      ticker: "QNBK",
      company: "QNB Group",
      rating: "Buy",
      target: "QAR 21.00",
      since: "Jan 26",
      callReturn: 12.5,
      venueCode: "QE",
    },
    {
      ticker: "2010",
      company: "SABIC",
      rating: "Neutral",
      target: "SAR 71.00",
      since: "Mar 26",
      callReturn: 3.5,
      venueCode: "TDWL",
    },
  ]);
});

test("the pinned call is the best live call, quoted from its published piece", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const p = toAnalystProfile(profileInput());
  assert.deepEqual(p.pinnedCall, {
    date: "PINNED CALL · 12 JAN",
    quote: "Buy on QNBK, target QAR 21.00, called 12 JAN.",
    ticker: "QNBK",
    returnSince: "+12.5% SINCE CALL",
  });

  // When the leading call HAS a published piece, its real headline is the quote.
  const input = profileInput();
  const withContent = {
    ...input,
    detail: {
      ...input.detail,
      calls: input.detail.calls.map((c) => (c.id === 1 ? { ...c, contentId: "c-1" } : c)),
    },
  };
  assert.equal(toAnalystProfile(withContent).pinnedCall.quote, "Fixture piece headline");
});

test("published research maps only RLS-visible pieces, newest first", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const p = toAnalystProfile(profileInput());
  assert.deepEqual(p.publishedResearch, [
    { slug: "fixture-piece", tag: "PREMIUM", headline: "Fixture piece headline", meta: "2 Mar · 12 min" },
  ]);
  assert.equal(p.publishedCount, "1 PIECE");
});

test("the chart compounds real closed-call returns against the index leg", async () => {
  const { toAnalystProfile } = await loadAdapter();
  const p = toAnalystProfile(profileInput());
  // Two closed calls: +10 (index +6) then −2 (index +1) → analyst 0,10,8; venue 0,6,7.
  assert.equal(p.chart.width, 800);
  assert.equal(p.chart.analystPoints.split(" ").length, 3);
  assert.equal(p.chart.venuePoints.split(" ").length, 3);
  assert.equal(p.chart.legendAnalyst, "FIXTURE ONE +8.0%");
  assert.equal(p.chart.legendVenue, "VENUE INDEX +7.0%");
  assert.deepEqual(p.chart.months, ["AUG '25", "FEB '26"]);
  // The series must start at the baseline and stay inside the viewBox.
  const ys = p.chart.analystPoints.split(" ").map((pt) => Number(pt.split(",")[1]));
  assert.ok(ys.every((y) => y >= 0 && y <= p.chart.height));
  assert.equal(p.chart.rightLabels.length, 3);
});

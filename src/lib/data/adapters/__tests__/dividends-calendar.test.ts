import test from "node:test";
import assert from "node:assert/strict";
import type { DividendCalendarPage, DividendItem, DividendKpis } from "@/lib/data/calendars";

/**
 * Fixture test for the dividend-calendar adapter (BRIDGE-BUILD-PLAN P2.4).
 *
 * WHY THIS FILE EXISTS: `public.dividends` has 1,229 rows but 0 with an
 * `ex_date`, 0 at `state='live'` and therefore 0 visible to `anon` — the page
 * ships an honest `EmptyState awaitingFeed` and no live read can prove the
 * mapping works. This test is that proof: it feeds the adapter a hand-built
 * non-empty set of reads (a FIXTURE, never rendered in production) and asserts
 * the `DividendWeek` contract it produces. When the confirmation producer lands
 * (P7.1) this is the guarantee the calendar lights up correctly rather than
 * silently mis-rendering — in particular the fraction→percent conversions that
 * would otherwise ship a 100× wrong yield.
 *
 * RUNNING IT: the app has no test runner in `package.json` and adding one is
 * out of scope, so this runs on Node's built-in runner with native TypeScript
 * type-stripping — no dependency, no config:
 *
 *     node --test "src/lib/data/adapters/__tests__/dividends-calendar.test.ts"
 *
 * The adapter is imported dynamically through a non-literal specifier so that
 * `tsc` (which forbids a literal `.ts` import extension without
 * `allowImportingTsExtensions`) and Node (which requires the extension) are
 * both satisfied. `typeof import(...)` keeps the module fully typed.
 */

type AdapterModule = typeof import("../dividends-calendar");

const SPECIFIER = "../dividends-calendar" + ".ts";

async function loadAdapter(): Promise<AdapterModule> {
  return (await import(SPECIFIER)) as AdapterModule;
}

/**
 * Plausible-but-synthetic declarations. Fixture only — never rendered.
 * `yieldAtAnnounce` and `payoutRatio` are FRACTIONS, matching the live column
 * semantics (`supabase/seed.sql` carries 0.0520 for a 5.2% yield).
 */
function dividend(over: Partial<DividendItem> & Pick<DividendItem, "id" | "ticker">): DividendItem {
  return {
    securityId: over.id,
    name: `${over.ticker} Holding Co`,
    venueCode: "TDWL",
    currency: "SAR",
    divType: "FINAL",
    fiscalRef: "2026-FY",
    dps: 1.25,
    exDate: "2026-07-12",
    recordDate: "2026-07-13",
    payDate: "2026-07-25",
    yieldAtAnnounce: 0.049,
    payoutRatio: 0.74,
    amountTotal: null,
    periodEnd: null,
    ...over,
  };
}

const A = dividend({ id: 1, ticker: "2222", name: "Arabian Refining", dps: 0.2043, yieldAtAnnounce: 0.049 });
const B = dividend({
  id: 2,
  ticker: "SALIK",
  name: "Salik Company",
  venueCode: "DFM",
  currency: "AED",
  divType: "INTERIM",
  dps: 0.0827,
  yieldAtAnnounce: 0.052,
  payoutRatio: 1.0,
  payDate: "2026-07-28",
});
const C = dividend({
  id: 3,
  ticker: "MTEL",
  name: "Muscat Telecom",
  venueCode: "MSX",
  currency: "OMR",
  divType: "SPECIAL",
  dps: 0.021,
  exDate: "2026-07-11",
  payDate: "2026-07-29",
  yieldAtAnnounce: 0.061,
  payoutRatio: 1.18,
});

function calendar(): DividendCalendarPage {
  return {
    days: [
      { date: "2026-07-12", count: 2, rows: [A, B] },
      { date: "2026-07-11", count: 1, rows: [C] },
    ],
    nextCursor: null,
  };
}

const KPIS: DividendKpis = {
  goingExThisWeek: 12,
  payoutsThisWeek: 9,
  specials: 2,
  medianYieldPct: 0.041,
};

const EMPTY_KPIS: DividendKpis = {
  goingExThisWeek: 0,
  payoutsThisWeek: 0,
  specials: 0,
  medianYieldPct: null,
};

function input(over: Partial<Parameters<AdapterModule["toDividendWeek"]>[0]> = {}) {
  return {
    calendar: calendar(),
    ahead: [B, A],
    yieldLeaders: [C, B],
    kpis: KPIS,
    ...over,
  };
}

test("empty reads → null (the awaitingFeed signal, today's live state)", async () => {
  const { toDividendWeek } = await loadAdapter();
  assert.equal(
    toDividendWeek({
      calendar: { days: [], nextCursor: null },
      ahead: [],
      yieldLeaders: [],
      kpis: EMPTY_KPIS,
    }),
    null,
  );
});

test("a ledger of ex-dated rows groups by day with weekday labels", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input());
  assert.ok(w);
  assert.deepEqual(
    w.days.map((d) => [d.label, d.count]),
    [
      ["SUN 12 JUL", "2 EX-DATES"],
      ["SAT 11 JUL", "1 EX-DATE · 1 SPECIAL"],
    ],
  );
  assert.equal(w.weekLabel, "EX-DATES 11 JUL 2026 – 12 JUL 2026 · NEWEST FIRST");
});

test("rows carry local-currency DPS, a percent yield and a real pay date", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input());
  assert.ok(w);
  assert.deepEqual(w.days[0].rows[0], {
    ticker: "2222",
    company: "Arabian Refining",
    venue: "TDWL",
    venueCode: "TDWL",
    type: "FINAL",
    dps: "SAR 0.2043",
    // 0.049 is a FRACTION in the column — 4.9%, not 0.0%.
    yield: "4.9%",
    payDate: "25 JUL",
    alertSet: false,
  });
  assert.equal(w.days[0].rows[1].dps, "AED 0.0827");
  assert.equal(w.days[1].rows[0].type, "SPECIAL");
  assert.equal(w.days[1].rows[0].dps, "OMR 0.021");
});

test("a row with no yield / no pay date degrades to — instead of 0", async () => {
  const { toDividendWeek } = await loadAdapter();
  const bare = dividend({ id: 9, ticker: "9999", yieldAtAnnounce: null, payDate: null, dps: null });
  const w = toDividendWeek(
    input({ calendar: { days: [{ date: "2026-07-12", count: 1, rows: [bare] }], nextCursor: null } }),
  );
  assert.ok(w);
  assert.deepEqual(
    [w.days[0].rows[0].yield, w.days[0].rows[0].payDate, w.days[0].rows[0].dps],
    ["—", "—", "—"],
  );
});

test("payout ratio is a fraction: >100% is flagged as cut risk, ≤100% is not", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input());
  assert.ok(w);
  assert.deepEqual(w.yieldLeaders, [
    { ticker: "MTEL", company: "Muscat Telecom", yield: "6.1%", payout: "PAYOUT 118%", payoutRisk: true },
    { ticker: "SALIK", company: "Salik Company", yield: "5.2%", payout: "PAYOUT 100%" },
  ]);
  assert.match(w.yieldLeadersNote, /PAYOUT > 100%/);
});

test("KPIs convert the median yield fraction and never sum across currencies", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input());
  assert.ok(w);
  assert.deepEqual(w.kpis, [
    { label: "GOING EX THIS WEEK", value: "12" },
    { label: "PAYOUTS SETTLING THIS WEEK", value: "9" },
    { label: "MEDIAN YIELD · GCC", value: "4.1%" },
    { label: "SPECIALS", value: "2" },
  ]);
  // No KPI may be a cross-currency money total — there is no FX table here.
  assert.equal(w.kpis.some((k) => /SAR|AED|OMR|\$/.test(k.value)), false);

  const none = toDividendWeek(input({ kpis: EMPTY_KPIS }));
  assert.equal(none?.kpis[2].value, "—");
});

test("the next-ex-date card names the real next payer, or says there is none", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input());
  assert.ok(w);
  assert.equal(w.goesExTomorrow.kicker, "NEXT EX-DATE · 12 JUL");
  assert.equal(w.goesExTomorrow.headline, "Own Salik Company before the 12 JUL open to collect AED 0.0827");
  assert.equal(w.goesExTomorrow.body, "SALIK, 2222 all trade ex on 12 JUL.");

  const noneAhead = toDividendWeek(input({ ahead: [] }));
  assert.ok(noneAhead);
  assert.equal(noneAhead.goesExTomorrow.headline, "No confirmed ex-date ahead");
  assert.doesNotMatch(noneAhead.goesExTomorrow.body, /\d/);
});

test("yield leaders alone still render (partial degrade, not null)", async () => {
  const { toDividendWeek } = await loadAdapter();
  const w = toDividendWeek(input({ calendar: { days: [], nextCursor: null }, ahead: [] }));
  assert.ok(w);
  assert.equal(w.days.length, 0);
  assert.equal(w.yieldLeaders.length, 2);
  assert.equal(w.weekLabel, "BY EX-DATE");
});

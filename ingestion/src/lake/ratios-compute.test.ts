import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKeyRatios, fitToColumnBudget, hasAnyRatio, type RatioInputs } from './ratios-compute.js';

const base: RatioInputs = { securityId: 1, last: null, sharesOutstanding: null };

test('market cap = last * shares', () => {
  const r = computeKeyRatios({ ...base, last: 50, sharesOutstanding: 1_000_000 });
  assert.equal(r.marketCap, 50_000_000);
});

test('pe from explicit eps; payout from dps/eps; yield from dps/last', () => {
  const r = computeKeyRatios({ ...base, last: 100, sharesOutstanding: 10, epsTtm: 5, trailingDps: 2 });
  assert.equal(r.pe, 20);
  assert.equal(r.payoutRatio, 2 / 5);
  assert.equal(r.dividendYield, 2 / 100);
  assert.equal(r.epsTtm, 5);
});

test('eps derived from net income / shares when no explicit eps', () => {
  const r = computeKeyRatios({ ...base, last: 100, sharesOutstanding: 100, netIncomeTtm: 500 });
  assert.equal(r.epsTtm, 5);
  assert.equal(r.pe, 20);
});

test('book value per share and pb', () => {
  const r = computeKeyRatios({ ...base, last: 20, sharesOutstanding: 100, totalEquity: 1000 });
  assert.equal(r.bookValuePs, 10);
  assert.equal(r.pb, 2);
});

test('roe, roce, ev/ebitda, net_debt/ebitda', () => {
  const r = computeKeyRatios({
    ...base,
    last: 10,
    sharesOutstanding: 100, // marketCap 1000
    netIncomeTtm: 200,
    totalEquity: 1000, // roe 0.2
    ebitTtm: 300,
    totalAssets: 2000,
    currentLiabilities: 500, // capital employed 1500 → roce 0.2
    ebitdaTtm: 400,
    netDebt: 200, // ev = 1200 → ev/ebitda 3; nd/ebitda 0.5
  });
  assert.equal(r.roe, 0.2);
  assert.equal(r.roce, 0.2);
  assert.equal(r.evEbitda, 3);
  assert.equal(r.netDebtEbitda, 0.5);
});

test('bank nim from nii / avg earning assets', () => {
  const r = computeKeyRatios({ ...base, netInterestIncomeTtm: 30, avgEarningAssets: 1000 });
  assert.equal(r.nim, 0.03);
});

test('missing drivers ⇒ null, never a guess; divide-by-zero ⇒ null', () => {
  const r = computeKeyRatios({ ...base, last: 100, sharesOutstanding: 10, epsTtm: 0 });
  assert.equal(r.pe, null); // eps 0
  assert.equal(r.pb, null); // no equity
  assert.equal(r.roe, null);
  assert.equal(hasAnyRatio(r), true); // marketCap present
});

test('all-null inputs ⇒ hasAnyRatio false (row skipped upstream)', () => {
  const r = computeKeyRatios(base);
  assert.equal(hasAnyRatio(r), false);
});

test('currencyComputed passes through and does NOT count as a ratio', () => {
  const r = computeKeyRatios({ ...base, currency: 'SAR' });
  assert.equal(r.currencyComputed, 'SAR');
  assert.equal(hasAnyRatio(r), false); // currency alone is metadata, not a ratio
});

// ── margins, growth, cagr, ebitda ────────────────────────────────────────────

test('net & gross margin from ttm income', () => {
  const r = computeKeyRatios({ ...base, revenueTtm: 1000, netIncomeTtm: 150, grossProfitTtm: 400 });
  assert.equal(r.netMargin, 0.15);
  assert.equal(r.grossMargin, 0.4);
});

test('ebitda_ttm = ebit + dep_amort when no explicit ebitda; explicit wins', () => {
  const derived = computeKeyRatios({ ...base, ebitTtm: 300, depAmortTtm: 100 });
  assert.equal(derived.ebitdaTtm, 400);
  const explicit = computeKeyRatios({ ...base, ebitTtm: 300, depAmortTtm: 100, ebitdaTtm: 999 });
  assert.equal(explicit.ebitdaTtm, 999);
});

test('net_debt derived from total_debt − cash feeds ev/ebitda & net_debt/ebitda', () => {
  const r = computeKeyRatios({
    ...base,
    last: 10, sharesOutstanding: 100, // marketCap 1000
    ebitTtm: 300, depAmortTtm: 100,   // ebitda 400
    totalDebt: 500, cash: 100,        // netDebt 400 → ev 1400 → ev/ebitda 3.5
  });
  assert.equal(r.netDebtEbitda, 1); // 400 / 400
  assert.equal(r.evEbitda, (1000 + 400) / 400);
});

test('explicit netDebt still preferred over total_debt − cash (back-compat)', () => {
  const r = computeKeyRatios({
    ...base,
    last: 10, sharesOutstanding: 100, ebitdaTtm: 400,
    totalDebt: 500, cash: 100, netDebt: 200, // explicit 200 wins over derived 400
  });
  assert.equal(r.netDebtEbitda, 0.5);
});

test('yoy growth from ttm vs prior-year ttm', () => {
  const r = computeKeyRatios({
    ...base,
    revenueTtm: 1200, revenueTtmPrior: 1000,
    sharesOutstanding: 100, netIncomeTtm: 220, // eps 2.2
    epsTtmPrior: 2.0,
  });
  assert.ok(Math.abs(r.revGrowthYoy! - 0.2) < 1e-9);
  assert.ok(Math.abs(r.epsGrowthYoy! - 0.1) < 1e-9);
});

test('3y cagr only when both endpoints > 0', () => {
  const r = computeKeyRatios({ ...base, revenueTtm: 8000, revenue3yAgo: 1000, epsTtm: 8, eps3yAgo: 1 });
  assert.ok(Math.abs(r.revCagr3y! - 1) < 1e-9); // (8000/1000)^(1/3)-1 = 1
  assert.ok(Math.abs(r.epsCagr3y! - 1) < 1e-9);
  const neg = computeKeyRatios({ ...base, revenueTtm: 8000, revenue3yAgo: -1000 });
  assert.equal(neg.revCagr3y, null);
});

test('momentum returns pass through from inputs', () => {
  const r = computeKeyRatios({ ...base, ret3m: 0.05, ret6m: 0.1, ret121: -0.02 });
  assert.equal(r.ret3m, 0.05);
  assert.equal(r.ret6m, 0.1);
  assert.equal(r.ret121, -0.02);
});

// ── sector-conditional validity (07 §3.3, owner D-1) ─────────────────────────

const richBank: RatioInputs = {
  securityId: 1, last: 10, sharesOutstanding: 100, // marketCap 1000
  netIncomeTtm: 200, revenueTtm: 1000, grossProfitTtm: 800,
  ebitTtm: 300, depAmortTtm: 100, totalDebt: 500, cash: 100,
  netInterestIncomeTtm: 30, avgEarningAssets: 1000, totalEquity: 1000,
};

test('bank sector nulls gross_margin, ev/ebitda, net_debt/ebitda but keeps pe/pb/roe/nim', () => {
  const r = computeKeyRatios({ ...richBank, sector: 'Banks' });
  assert.equal(r.grossMargin, null);
  assert.equal(r.evEbitda, null);
  assert.equal(r.netDebtEbitda, null);
  // kept:
  assert.equal(r.pe, 5); // 10 / eps(200/100=2)
  assert.equal(r.pb, 1); // 10 / bvps(1000/100=10)
  assert.equal(r.roe, 0.2);
  assert.equal(r.nim, 0.03);
  assert.equal(r.netMargin, 0.2); // net margin stays valid for banks
});

test('insurer sector nulls gross_margin, ev/ebitda, net_debt/ebitda but keeps pb/roe', () => {
  const r = computeKeyRatios({ ...richBank, sector: 'Insurance' });
  assert.equal(r.grossMargin, null);
  assert.equal(r.evEbitda, null);
  assert.equal(r.netDebtEbitda, null);
  assert.equal(r.pb, 1);
  assert.equal(r.roe, 0.2);
});

test("'unknown'/null sector keeps the FULL ratio set (prod default)", () => {
  for (const sector of ['unknown', null, 'Energy'] as const) {
    const r = computeKeyRatios({ ...richBank, sector });
    assert.notEqual(r.grossMargin, null, `gross margin for ${sector}`);
    assert.notEqual(r.evEbitda, null, `ev/ebitda for ${sector}`);
    assert.notEqual(r.netDebtEbitda, null, `net_debt/ebitda for ${sector}`);
  }
});

// --- fitToColumnBudget: the key_ratios numeric(p,s) budget ------------------
// Regression for the 2026-07-17 nightly outage: safeDiv only rejects a ZERO
// denominator, so a merely near-zero one yields a huge FINITE ratio that passes
// every isFinite guard and then raises `numeric field overflow` on insert —
// killing the whole recompute.

test('fitToColumnBudget: the live ALFIRDOUS case — near-zero revenue overflows net_margin', () => {
  // DFM ALFIRDOUS, a dormant holding company: AED 647 of trailing revenue against
  // ~3.66M of investment income ⇒ net_margin 5,663.4 vs a numeric(7,4) cap of 1000.
  const raw = computeKeyRatios({ ...base, last: 0.286, sharesOutstanding: 600_000_000,
    netIncomeTtm: 3_664_226, revenueTtm: 647 });
  assert.ok(raw.netMargin !== null && raw.netMargin > 5000, 'precondition: the raw ratio overflows');

  const { ratios, dropped } = fitToColumnBudget(raw);
  assert.equal(ratios.netMargin, null, 'must be nulled, not clamped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].field, 'netMargin');
  assert.equal(dropped[0].limit, 1000);
  assert.ok(dropped[0].value > 5000, 'the offending value is reported for logging');
});

test('fitToColumnBudget: the live EAST PIPES case — a bad eps extraction overflows eps_ttm', () => {
  // TDWL 1321: the XBRL extractor wrote net_income into eps_diluted, so eps_ttm came
  // out at ~521M vs a numeric(12,4) cap of 1e8. Nulling keeps a nonsense EPS (and the
  // PE derived from it) out of the screener.
  const { ratios, dropped } = fitToColumnBudget(
    computeKeyRatios({ ...base, last: 50, epsTtm: 521_292_763 }),
  );
  assert.equal(ratios.epsTtm, null);
  assert.ok(dropped.some((d) => d.field === 'epsTtm' && d.limit === 1e8));
});

test('fitToColumnBudget: in-range ratios pass through untouched', () => {
  const raw = computeKeyRatios({ ...base, last: 100, sharesOutstanding: 1_000_000,
    epsTtm: 5, trailingDps: 2, netIncomeTtm: 5_000_000, revenueTtm: 20_000_000,
    totalEquity: 50_000_000 });
  const { ratios, dropped } = fitToColumnBudget(raw);
  assert.deepEqual(dropped, [], 'nothing dropped for a normal company');
  assert.deepEqual(ratios, raw, 'the object is unchanged');
});

test('fitToColumnBudget: nulls and boundaries', () => {
  // null stays null (not treated as 0), and the bound is EXCLUSIVE: a numeric(7,4)
  // column holds up to 999.9999, so exactly 1000 must drop but 999.9 must not.
  const { ratios: atCap, dropped: dropAt } = fitToColumnBudget({
    ...computeKeyRatios(base), roe: 1000, roce: 999.9,
  });
  assert.equal(atCap.roe, null, '1000 >= 10^(7-4) must drop');
  assert.equal(atCap.roce, 999.9, '999.9 fits');
  assert.equal(dropAt.length, 1);

  const { dropped: noneForNulls } = fitToColumnBudget(computeKeyRatios(base));
  assert.deepEqual(noneForNulls, [], 'an all-null ratio set drops nothing');
});

test('fitToColumnBudget: a negative overflow drops too', () => {
  // The bound is on ABSOLUTE value — a huge negative margin overflows identically.
  const { ratios, dropped } = fitToColumnBudget({ ...computeKeyRatios(base), netMargin: -5663.4 });
  assert.equal(ratios.netMargin, null);
  assert.equal(dropped[0].value, -5663.4);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKeyRatios, hasAnyRatio, type RatioInputs } from './ratios-compute.js';

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

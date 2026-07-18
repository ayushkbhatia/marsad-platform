// Golden + unit tests for the statement normalizer (plan §2). ZERO network.
//
// The task brief names `npx vitest run` but this package has no vitest — the
// whole suite runs on node:test + tsx (see package.json "test": node --import
// tsx --test). We match the surrounding style (CONTRACT hard-rule) and the repo's
// real runner. Run:
//   node --import tsx --test src/lake/statement-normalizer.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  normalizeMubasherStatements,
  normalizeMubasherRatios,
  normalizeYahooTimeseries,
  deriveTtm,
  flattenStatements,
  validateNormalizedPeriod,
  normalizeViaLlm,
  toNumberOrNull,
  type NormalizedPeriod,
} from './statement-normalizer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../fixtures');

function readFixture(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtures, rel), 'utf8'));
}

// ─── numeric coercion ────────────────────────────────────────────────────────

test('toNumberOrNull: comma-thousands, blanks, dashes, parens, genuine zero', () => {
  assert.equal(toNumberOrNull('2,516,431,000'), 2516431000);
  assert.equal(toNumberOrNull('-121,300,000'), -121300000);
  assert.equal(toNumberOrNull('(1,234)'), -1234);
  assert.equal(toNumberOrNull(1.99), 1.99);
  assert.equal(toNumberOrNull('0'), 0);
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull('-'), null);
  assert.equal(toNumberOrNull('N/A'), null);
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);
  assert.equal(toNumberOrNull(NaN), null);
});

// ─── Mubasher /financial-statements golden ───────────────────────────────────

test('Mubasher statements: maps rows → primitive keys with correct values', () => {
  const norm = normalizeMubasherStatements(readFixture('mubasher/financial-statements-2222.json'));
  assert.equal(norm.venue, 'TDWL');
  assert.equal(norm.ticker, '2222');
  assert.equal(norm.periods.length, 5); // 2021..2025

  const y2025 = norm.periods.find((p) => p.fiscalPeriod === 'FY2025');
  assert.ok(y2025);
  assert.equal(y2025!.periodKind, 'annual');
  assert.equal(y2025!.periodEnd, '2025-12-31');
  assert.equal(y2025!.currency, 'SAR');
  // "Total Assets" 2,516,431,000 → total_assets (the spec's exemplar comma value).
  assert.equal(y2025!.lineItems.total_assets, 2516431000);
  assert.equal(y2025!.lineItems.equity, 1506000000); // Total Owners' Equity
  assert.equal(y2025!.lineItems.net_income, 398200000); // Net Income or Loss
  assert.equal(y2025!.lineItems.gross_profit, 665900000); // Gross Profit
});

test('Mubasher statements: capital_employed null (no current liabilities line)', () => {
  const norm = normalizeMubasherStatements(readFixture('mubasher/financial-statements-2222.json'));
  const y2023 = norm.periods.find((p) => p.fiscalPeriod === 'FY2023')!;
  assert.equal(y2023.lineItems.capital_employed, undefined); // null-pruned
  // Unmapped Mubasher rows (liabilities, cashflow lines) never become a primitive.
  assert.equal(y2023.lineItems.total_debt, undefined);
});

test('Mubasher statements: malformed input ⇒ no periods, never throws', () => {
  assert.deepEqual(normalizeMubasherStatements(null).periods, []);
  assert.deepEqual(normalizeMubasherStatements({ exchange: 'TDWL', columns: [], rows: [] }).periods, []);
});

// ─── flattenStatements → per-period staging rows (07 §P1.7b persist path) ─────

test('flattenStatements: enriches each non-empty period with venue/ticker/basis identity', () => {
  const norm = normalizeMubasherStatements(readFixture('mubasher/financial-statements-2222.json'));
  const rows = flattenStatements(norm); // default basis 'consolidated'
  assert.equal(rows.length, 5); // 2021..2025, all non-empty
  const r2025 = rows.find((r) => r.fiscalPeriod === 'FY2025')!;
  assert.ok(r2025);
  assert.equal(r2025.venue, 'TDWL');
  assert.equal(r2025.ticker, '2222');
  assert.equal(r2025.basis, 'consolidated');
  assert.equal(r2025.statementType, 'income'); // Mubasher collapses to the income period
  assert.equal(r2025.periodKind, 'annual');
  assert.equal(r2025.periodEnd, '2025-12-31');
  assert.equal(r2025.currency, 'SAR');
  // line_items carry through verbatim (the §3.1 primitives the projection lands as jsonb).
  assert.equal(r2025.lineItems.total_assets, 2516431000);
  assert.equal(r2025.lineItems.net_income, 398200000);
});

test('flattenStatements: standalone basis passes through; TTM period included', () => {
  const norm = normalizeMubasherStatements(readFixture('mubasher/financial-statements-2222.json'));
  const rows = flattenStatements(norm, 'standalone');
  assert.ok(rows.every((r) => r.basis === 'standalone'));
});

test('flattenStatements: drops empty-line_items periods + blank identity ⇒ []', () => {
  // A period with no mapped primitives must not stage (nothing to persist).
  const empties = flattenStatements({
    venue: 'TDWL',
    ticker: '2222',
    periods: [
      { periodKind: 'annual', fiscalPeriod: 'FY2020', periodEnd: '2020-12-31', currency: 'SAR', statementType: 'income', lineItems: {} },
    ],
  });
  assert.deepEqual(empties, []);
  // Blank venue/ticker cannot be keyed downstream.
  assert.deepEqual(
    flattenStatements({ venue: '', ticker: '', periods: [] }),
    [],
  );
});

// ─── Mubasher /ratios golden ─────────────────────────────────────────────────

test('Mubasher ratios: label → snake_case, percents as-reported', () => {
  const r = normalizeMubasherRatios(readFixture('mubasher/ratios-2222.json'));
  assert.equal(r.roe, 31.37);
  assert.equal(r.roa, 18.05);
  assert.equal(r.eps, 1.99);
  assert.equal(r.net_profit_growth, 25.56);
  assert.equal(r.eps_growth, 24.1);
  assert.equal(r.cash_from_operations_growth, -5.47);
});

test('Mubasher ratios: accepts a bare object and drops unknown labels', () => {
  const r = normalizeMubasherRatios({ 'ROE %': 12.5, 'Made Up Ratio': 99 });
  assert.equal(r.roe, 12.5);
  assert.equal(r.made_up_ratio, undefined);
});

// ─── Yahoo fundamentals-timeseries golden ────────────────────────────────────

test('Yahoo timeseries: envelope → primitives, identity from meta.symbol', () => {
  const norm = normalizeYahooTimeseries(readFixture('yahoo/fundamentals-timeseries-2222-sr.json'));
  assert.equal(norm.venue, 'TDWL'); // .SR suffix stripped
  assert.equal(norm.ticker, '2222');
  assert.equal(norm.periods.length, 3); // FY2021..FY2023

  // newest first (period_end desc)
  assert.equal(norm.periods[0]!.fiscalPeriod, 'FY2023');
  const fy2023 = norm.periods[0]!;
  assert.equal(fy2023.periodKind, 'annual');
  assert.equal(fy2023.currency, 'SAR');
  assert.equal(fy2023.lineItems.revenue, 1949800000); // annualTotalRevenue
  assert.equal(fy2023.lineItems.net_income, 454760000); // annualNetIncome
  assert.equal(fy2023.lineItems.gross_profit, 742100000);
  assert.equal(fy2023.lineItems.eps_diluted, 1.99); // annualDilutedEPS
  assert.equal(fy2023.lineItems.total_assets, 2309712000);
  assert.equal(fy2023.lineItems.equity, 1404412000); // annualStockholdersEquity
  assert.equal(fy2023.lineItems.current_liabilities, 372400000);
  // capital_employed = total_assets − current_liabilities (derived).
  assert.equal(fy2023.lineItems.capital_employed, 2309712000 - 372400000);
});

test('Yahoo timeseries: accepts a raw JSON string too; malformed ⇒ empty', () => {
  const s = readFileSync(resolve(fixtures, 'yahoo/fundamentals-timeseries-2222-sr.json'), 'utf8');
  assert.equal(normalizeYahooTimeseries(s).periods.length, 3);
  assert.deepEqual(normalizeYahooTimeseries('{not json').periods, []);
  assert.deepEqual(normalizeYahooTimeseries({ timeseries: { result: [] } }).periods, []);
});

// ─── validation harness ──────────────────────────────────────────────────────

test('validate: income period missing revenue is flagged not-ok', () => {
  const p: NormalizedPeriod = {
    periodKind: 'annual',
    fiscalPeriod: 'FY2023',
    periodEnd: '2023-12-31',
    currency: 'SAR',
    statementType: 'income',
    lineItems: { net_income: 100 }, // revenue absent
  };
  const v = validateNormalizedPeriod(p);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingRequired, ['revenue']);
});

test('validate: a complete income period passes; balance requires assets+equity', () => {
  const income = normalizeYahooTimeseries(readFixture('yahoo/fundamentals-timeseries-2222-sr.json')).periods[0]!;
  assert.equal(validateNormalizedPeriod(income).ok, true);

  const balMissing: NormalizedPeriod = {
    periodKind: 'annual',
    fiscalPeriod: 'FY2023',
    periodEnd: '2023-12-31',
    currency: 'SAR',
    statementType: 'balance',
    lineItems: { total_assets: 100 }, // equity absent
  };
  const v = validateNormalizedPeriod(balMissing);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingRequired, ['equity']);

  // cashflow has no hard floor → ok even with empty items (warning only).
  const cf: NormalizedPeriod = { ...balMissing, statementType: 'cashflow', lineItems: {} };
  assert.equal(validateNormalizedPeriod(cf).ok, true);
});

// ─── TTM derivation ──────────────────────────────────────────────────────────

function quarter(periodEnd: string, items: Record<string, number | null>): NormalizedPeriod {
  return {
    periodKind: 'quarter',
    fiscalPeriod: periodEnd,
    periodEnd,
    currency: 'SAR',
    statementType: 'income',
    lineItems: items,
  };
}

test('deriveTtm: sums 4 trailing quarters for flows, latest for balance', () => {
  const periods: NormalizedPeriod[] = [
    quarter('2024-03-31', { revenue: 100, net_income: 10, total_assets: 900, current_liabilities: 100 }),
    quarter('2024-06-30', { revenue: 110, net_income: 12, total_assets: 950, current_liabilities: 120 }),
    quarter('2024-09-30', { revenue: 120, net_income: 14, total_assets: 980, current_liabilities: 130 }),
    quarter('2024-12-31', { revenue: 130, net_income: 16, total_assets: 1000, current_liabilities: 150 }),
  ];
  const ttm = deriveTtm(periods);
  assert.equal(ttm.length, 1);
  const t = ttm[0]!;
  assert.equal(t.periodKind, 'ttm');
  assert.equal(t.periodEnd, '2024-12-31'); // latest quarter
  assert.equal(t.fiscalPeriod, 'TTM-2024-12-31');
  assert.equal(t.lineItems.revenue, 100 + 110 + 120 + 130); // flow: summed
  assert.equal(t.lineItems.net_income, 10 + 12 + 14 + 16);
  assert.equal(t.lineItems.total_assets, 1000); // stock: latest
  assert.equal(t.lineItems.current_liabilities, 150);
  assert.equal(t.lineItems.capital_employed, 1000 - 150); // re-derived from TTM balance
});

test('deriveTtm: fewer than 4 quarters ⇒ no ttm row', () => {
  const periods = [quarter('2024-09-30', { revenue: 1 }), quarter('2024-12-31', { revenue: 2 })];
  assert.deepEqual(deriveTtm(periods), []);
});

test('deriveTtm: a flow missing in any quarter ⇒ null (no partial-year sum)', () => {
  const periods: NormalizedPeriod[] = [
    quarter('2024-03-31', { revenue: 100 }), // net_income absent here
    quarter('2024-06-30', { revenue: 110, net_income: 12 }),
    quarter('2024-09-30', { revenue: 120, net_income: 14 }),
    quarter('2024-12-31', { revenue: 130, net_income: 16 }),
  ];
  const t = deriveTtm(periods)[0]!;
  assert.equal(t.lineItems.revenue, 460); // present in all 4
  assert.equal(t.lineItems.net_income, undefined); // missing in one ⇒ null-pruned
});

test('deriveTtm: picks the 4 MOST-RECENT quarters when more than 4 exist', () => {
  const periods: NormalizedPeriod[] = [
    quarter('2023-12-31', { revenue: 1 }),
    quarter('2024-03-31', { revenue: 100 }),
    quarter('2024-06-30', { revenue: 110 }),
    quarter('2024-09-30', { revenue: 120 }),
    quarter('2024-12-31', { revenue: 130 }),
  ];
  const t = deriveTtm(periods)[0]!;
  assert.equal(t.periodEnd, '2024-12-31');
  assert.equal(t.lineItems.revenue, 100 + 110 + 120 + 130); // 2023-12-31 excluded
});

// ─── LLM/PDF seam ────────────────────────────────────────────────────────────

test('normalizeViaLlm: throws until the P1.7d PDF pipeline lands', () => {
  assert.throws(
    () => normalizeViaLlm({ kind: 'pdf_text', body: 'x' }),
    /not implemented \(P1\.7d PDF pipeline\)/,
  );
});

// ─── Phase A: widened statement types + open-bag vocabulary + TTM eligibility ─

test('validate: oci/equity_change have no required floor and pass', () => {
  const oci: NormalizedPeriod = {
    periodKind: 'quarter',
    fiscalPeriod: 'Q1 2026',
    periodEnd: '2026-03-31',
    currency: 'SAR',
    statementType: 'oci',
    lineItems: { total_comprehensive_income: 6_250_067 },
  };
  assert.equal(validateNormalizedPeriod(oci).ok, true);
  assert.equal(validateNormalizedPeriod({ ...oci, statementType: 'equity_change' }).ok, true);
});

test('validate: non-primitive keys are first-class (open bag) — no warning', () => {
  const p: NormalizedPeriod = {
    periodKind: 'annual',
    fiscalPeriod: 'FY2023',
    periodEnd: '2023-12-31',
    currency: 'SAR',
    statementType: 'income',
    lineItems: { revenue: 100, net_income: 10, statutory_reserve: 5, zakat_provision: 2 },
  };
  const v = validateNormalizedPeriod(p);
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings, []); // the retired "non-primitive key" warning must NOT return
});

test('deriveTtm: oci/equity_change quarters are excluded from the TTM window', () => {
  const periods: NormalizedPeriod[] = [
    quarter('2024-03-31', { revenue: 100 }),
    quarter('2024-06-30', { revenue: 110 }),
    quarter('2024-09-30', { revenue: 120 }),
    { ...quarter('2024-12-31', { revenue: 999 }), statementType: 'oci' }, // must not enter the window
    quarter('2024-12-31', { revenue: 130 }),
  ];
  const t = deriveTtm(periods)[0]!;
  assert.equal(t.statementType, 'income'); // inherited from a CORE quarter, never 'oci'
  assert.equal(t.lineItems.revenue, 100 + 110 + 120 + 130);
});

test('flattenStatements: presentation rides through to the staging row', () => {
  const rows = flattenStatements({
    venue: 'TDWL',
    ticker: '2010',
    periods: [
      {
        periodKind: 'quarter',
        fiscalPeriod: 'Q1 2026',
        periodEnd: '2026-03-31',
        currency: 'SAR',
        statementType: 'income',
        lineItems: { revenue: 100 },
        presentation: [{ key: 'revenue', label: 'Revenue', depth: 0, is_subtotal: false }],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.presentation, [{ key: 'revenue', label: 'Revenue', depth: 0, is_subtotal: false }]);
});

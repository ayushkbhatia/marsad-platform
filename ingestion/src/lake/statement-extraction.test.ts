import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleFromExtraction,
  validateExtraction,
  extractToStatements,
  type ExtractedFinancials,
} from './statement-extraction.js';

// Real SABIC Q1-2026 numbers (thousands SAR), captured from the golden fixture
// ingestion/fixtures/argaam/sabic-en-2026Q1.pdf. Balance-sheet identity holds exactly:
// total_assets 237,906,104 == total_liabilities 88,826,392 + equity 149,079,712.
const SABIC: ExtractedFinancials = {
  currency: 'SAR',
  scale: 'thousands',
  periods: [
    {
      period_kind: 'quarter', fiscal_period: 'Q1 2026', period_end: '2026-03-31', is_comparative: false,
      revenue: 26_151_935, gross_profit: 5_128_239, net_income: 284_091, eps_diluted: 0.27,
      total_assets: 237_906_104, total_liabilities: 88_826_392, equity: 149_079_712, cash: 24_553_896,
    },
    {
      period_kind: 'quarter', fiscal_period: 'Q1 2025', period_end: '2025-03-31', is_comparative: true,
      revenue: 29_266_658, gross_profit: 5_043_682, net_income: -1_163_659, eps_diluted: -0.40,
      total_assets: 244_292_189, total_liabilities: 89_472_648, equity: 154_819_541, cash: 27_746_328,
    },
  ],
};

test('validation: clean SABIC statements pass every hard check', () => {
  const r = validateExtraction(SABIC);
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.issues.filter((i) => i.severity === 'reject').length, 0);
});

test('assembly: SABIC scaled to actual units, split per statement_type, eps unscaled', () => {
  const s = assembleFromExtraction(SABIC, 'TDWL', '2010');
  assert.equal(s.venue, 'TDWL');
  assert.equal(s.ticker, '2010');
  const q1 = s.periods.filter((p) => p.fiscalPeriod === 'Q1 2026');
  const income = q1.find((p) => p.statementType === 'income');
  const balance = q1.find((p) => p.statementType === 'balance');
  assert.ok(income && balance);
  // thousands → actual: revenue 26,151,935 × 1000
  assert.equal(income!.lineItems.revenue, 26_151_935_000);
  assert.equal(balance!.lineItems.total_assets, 237_906_104_000);
  // eps is per-share → NEVER scaled
  assert.equal(income!.lineItems.eps_diluted, 0.27);
  // capital_employed derived only when current_liabilities present (absent here → not set)
  assert.equal(balance!.lineItems.capital_employed, undefined);
});

test('assembly: capital_employed derived when current_liabilities present', () => {
  const s = assembleFromExtraction(
    { currency: 'SAR', scale: 'units', periods: [{
      period_kind: 'annual', fiscal_period: 'FY2025', period_end: '2025-12-31', is_comparative: false,
      total_assets: 1000, current_liabilities: 300,
    }] },
    'TDWL', '1',
  );
  const bal = s.periods.find((p) => p.statementType === 'balance')!;
  assert.equal(bal.lineItems.capital_employed, 700);
});

test('GATE rejects the Mubasher 1000× scale inconsistency (both periods dropped)', () => {
  // The exact live Mubasher signature: same company, total_assets 2.5B vs 2.44T.
  const bad: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    periods: [
      { period_kind: 'quarter', fiscal_period: 'Q3 2025', period_end: '2025-09-30', is_comparative: false, total_assets: 2_516_431_000, equity: 1_691_628_000, total_liabilities: 824_803_000 },
      { period_kind: 'quarter', fiscal_period: 'Q1 2025', period_end: '2025-03-31', is_comparative: true, total_assets: 2_444_802_000_000, equity: 1_667_128_000_000, total_liabilities: 777_674_000_000 },
    ],
  };
  const r = validateExtraction(bad);
  assert.equal(r.ok, false);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.issues.some((i) => i.check === 'scale_consistency' && i.severity === 'reject'));
});

test('GATE rejects garbage: negative gross profit at trillions (gross > revenue)', () => {
  const bad: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    periods: [{ period_kind: 'annual', fiscal_period: 'FY2023', period_end: '2023-12-31', is_comparative: false,
      revenue: 100, gross_profit: -14_627_421_000_000, total_assets: 2_400_000_000_000, equity: 1_700_000_000_000, total_liabilities: 700_000_000_000 }],
  };
  const r = validateExtraction(bad);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.check === 'gross_le_revenue' && i.severity === 'reject'));
});

test('GATE rejects a budget/forecast period (not actuals)', () => {
  const bad: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    periods: [{ period_kind: 'annual', fiscal_period: 'annual budget', period_end: '2025-12-31', is_comparative: false,
      total_assets: 2_551_964_000, equity: 1_721_744_000, total_liabilities: 830_220_000 }],
  };
  const r = validateExtraction(bad);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.check === 'not_actual' && i.severity === 'reject'));
});

test('GATE rejects a broken accounting identity (assets ≠ liabilities + equity)', () => {
  const bad: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    periods: [{ period_kind: 'annual', fiscal_period: 'FY2025', period_end: '2025-12-31', is_comparative: false,
      total_assets: 1000, total_liabilities: 400, equity: 100 }], // 400+100=500 ≠ 1000
  };
  const r = validateExtraction(bad);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.check === 'accounting_identity' && i.severity === 'reject'));
});

test('GATE rejects impossible magnitude (scale/parse blowup)', () => {
  const bad: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    periods: [{ period_kind: 'annual', fiscal_period: 'FY2025', period_end: '2025-12-31', is_comparative: false,
      total_assets: 2e15 }],
  };
  assert.equal(validateExtraction(bad).ok, false);
});

test('extractToStatements: gate + assembly composed — only accepted periods survive', () => {
  const mixed: ExtractedFinancials = {
    currency: 'SAR', scale: 'thousands',
    periods: [
      SABIC.periods[0]!, // clean → kept
      { period_kind: 'annual', fiscal_period: 'annual budget', period_end: '2025-12-31', is_comparative: false, total_assets: 1, equity: 1, total_liabilities: 0 }, // dropped
    ],
  };
  const { statements, validation } = extractToStatements(mixed, 'TDWL', '2010');
  assert.equal(validation.rejected.length, 1);
  // only the clean Q1 2026 period made it through → its income+balance rows
  assert.ok(statements.periods.every((p) => p.fiscalPeriod === 'Q1 2026'));
  assert.ok(statements.periods.length >= 2);
});

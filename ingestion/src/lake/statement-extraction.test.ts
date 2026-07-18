// statement-extraction — the extraction contract + hard validation GATE (recovered from the live VPS
// build to close DEF-REPO-DRIFT-STMT-EXTRACTION). Unit tests for scale-normalization, canonical aliasing,
// capital_employed derivation, fiscal-period canonicalization, and every gate reject/warn path — plus a
// GOLDEN round-trip against a real SABIC (2010) XBRL filing whose expected output was captured from the
// live dist/lake/statement-extraction.js. The golden guarantees the reconstruction is byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  assembleFromExtraction,
  buildExtractionUserMessage,
  canonicalFiscalPeriod,
  extractToStatements,
  validateExtraction,
  type ExtractedFinancials,
  type ExtractedStatement,
} from './statement-extraction.js';

const here = dirname(fileURLToPath(import.meta.url));

function stmt(over: Partial<ExtractedStatement> = {}): ExtractedStatement {
  return {
    statement_type: 'balance',
    period_kind: 'annual',
    fiscal_period: '2021',
    period_end: '2021-12-31',
    is_comparative: false,
    line_items: {},
    ...over,
  };
}
function fin(scale: ExtractedFinancials['scale'], statements: ExtractedStatement[], currency = 'SAR'): ExtractedFinancials {
  return { currency, scale, statements };
}

// ── scale normalization ──────────────────────────────────────────────────────
test('scale=thousands multiplies every line by 1000; per-share keys pass through unscaled', () => {
  const out = assembleFromExtraction(
    fin('thousands', [stmt({ statement_type: 'income', line_items: { revenue: 100, eps_diluted: 2.5 } })]),
    'TDWL', '9999',
  );
  assert.equal(out.periods.length, 1);
  assert.equal(out.periods[0]!.lineItems.revenue, 100_000);
  assert.equal(out.periods[0]!.lineItems.eps_diluted, 2.5);
});

test('scale=millions and billions apply the right factor', () => {
  const m = assembleFromExtraction(fin('millions', [stmt({ line_items: { total_assets: 3 } })]), 'TDWL', '1');
  assert.equal(m.periods[0]!.lineItems.total_assets, 3_000_000);
  const b = assembleFromExtraction(fin('billions', [stmt({ line_items: { total_assets: 3 } })]), 'TDWL', '1');
  assert.equal(b.periods[0]!.lineItems.total_assets, 3_000_000_000);
});

test('comma-thousands / parenthesised strings coerce; blanks & dashes drop (toNumberOrNull)', () => {
  const out = assembleFromExtraction(
    fin('units', [stmt({ line_items: { total_assets: '1,234' as unknown as number, net: '(50)' as unknown as number, blank: '' as unknown as number, dash: '-' as unknown as number } })]),
    'TDWL', '1',
  );
  const li = out.periods[0]!.lineItems;
  assert.equal(li.total_assets, 1234);
  assert.equal(li.net, -50);
  assert.equal(li.blank, undefined);
  assert.equal(li.dash, undefined);
});

// ── canonical aliasing ───────────────────────────────────────────────────────
test('alias folds onto the canonical key only when it is absent', () => {
  const folded = assembleFromExtraction(fin('units', [stmt({ line_items: { total_equity: 500 } })]), 'TDWL', '1');
  assert.equal(folded.periods[0]!.lineItems.equity, 500);

  const kept = assembleFromExtraction(fin('units', [stmt({ line_items: { total_equity: 500, equity: 999 } })]), 'TDWL', '1');
  assert.equal(kept.periods[0]!.lineItems.equity, 999); // explicit canonical wins over the alias
});

// ── capital_employed derivation ──────────────────────────────────────────────
test('capital_employed = total_assets − current_liabilities when both present', () => {
  const out = assembleFromExtraction(
    fin('units', [stmt({ line_items: { total_assets: 1000, current_liabilities: 300 } })]),
    'TDWL', '1',
  );
  assert.equal(out.periods[0]!.lineItems.capital_employed, 700);
});

test('capital_employed not derived when current_liabilities is absent', () => {
  const out = assembleFromExtraction(fin('units', [stmt({ line_items: { total_assets: 1000 } })]), 'TDWL', '1');
  assert.equal(out.periods[0]!.lineItems.capital_employed, undefined);
});

test('empty line_items period is dropped from the assembled output', () => {
  const out = assembleFromExtraction(fin('units', [stmt({ line_items: {} })]), 'TDWL', '1');
  assert.equal(out.periods.length, 0);
});

// ── fiscal-period canonicalization ───────────────────────────────────────────
test('canonicalFiscalPeriod: annual/ttm → year, quarter → Qn year, bad date → fallback', () => {
  assert.equal(canonicalFiscalPeriod('annual', '2020-12-31', 'FY2020'), '2020');
  assert.equal(canonicalFiscalPeriod('ttm', '2020-12-31', 'x'), '2020');
  assert.equal(canonicalFiscalPeriod('quarter', '2021-03-31', 'x'), 'Q1 2021');
  assert.equal(canonicalFiscalPeriod('quarter', '2021-09-30', 'x'), 'Q3 2021');
  assert.equal(canonicalFiscalPeriod('quarter', 'not-a-date', 'FALLBACK'), 'FALLBACK');
});

// ── the hard gate ────────────────────────────────────────────────────────────
test('clean statements pass the gate (ok, nothing rejected)', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'balance', line_items: { total_assets: 1000, total_liabilities: 600, equity: 400 } }),
    stmt({ statement_type: 'income', fiscal_period: '2021', line_items: { revenue: 500, gross_profit: 200, net_income: 80 } }),
  ]));
  assert.equal(v.ok, true);
  assert.equal(v.rejected.length, 0);
  assert.equal(v.accepted.length, 2);
});

test('budget/forecast fiscal_period is rejected (not an actual)', () => {
  const v = validateExtraction(fin('units', [stmt({ fiscal_period: 'Budget 2026', line_items: { total_assets: 100 } })]));
  assert.equal(v.ok, false);
  assert.equal(v.rejected[0]!.reasons[0]!.check, 'not_actual');
});

test('broken accounting identity (assets ≠ liabilities + equity, >2%) is rejected', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'balance', line_items: { total_assets: 100, total_liabilities: 60, equity: 30 } }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(v.rejected[0]!.reasons.some((r) => r.check === 'accounting_identity'), true);
});

test('accounting identity within ±2% is accepted', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'balance', line_items: { total_assets: 100, total_liabilities: 60, equity: 41 } }),
  ]));
  assert.equal(v.ok, true);
});

test('impossible magnitude (> 1e15 after scaling) is rejected', () => {
  const v = validateExtraction(fin('billions', [stmt({ statement_type: 'income', line_items: { revenue: 2_000_000 } })]));
  assert.equal(v.ok, false);
  assert.equal(v.rejected[0]!.reasons.some((r) => r.check === 'magnitude'), true);
});

test('cross-period 1000× scale swing rejects BOTH balances (the Mubasher signature)', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'balance', fiscal_period: '2021', line_items: { total_assets: 100 } }),
    stmt({ statement_type: 'balance', fiscal_period: '2020', line_items: { total_assets: 100_000 } }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(v.rejected.length, 2);
  assert.equal(v.rejected.every((r) => r.reasons.some((x) => x.check === 'scale_consistency')), true);
});

test('gross_profit implausible vs revenue is rejected', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'income', line_items: { revenue: 100, gross_profit: 250 } }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(v.rejected[0]!.reasons.some((r) => r.check === 'gross_le_revenue'), true);
});

test('|net_income| > 5× revenue is a WARN, not a reject (still accepted, gate ok)', () => {
  const v = validateExtraction(fin('units', [
    stmt({ statement_type: 'income', line_items: { revenue: 100, net_income: 600 } }),
  ]));
  assert.equal(v.ok, true);
  assert.equal(v.rejected.length, 0);
  assert.equal(v.issues.some((i) => i.check === 'income_bound' && i.severity === 'warn'), true);
});

test('extractToStatements assembles only the accepted statements', () => {
  const { statements, validation } = extractToStatements(fin('units', [
    stmt({ statement_type: 'income', fiscal_period: 'Forecast 2027', line_items: { revenue: 100 } }),
    stmt({ statement_type: 'income', fiscal_period: '2021', period_end: '2021-12-31', line_items: { revenue: 200 } }),
  ]), 'TDWL', '1');
  assert.equal(validation.rejected.length, 1);
  assert.equal(statements.periods.length, 1);
  assert.equal(statements.periods[0]!.fiscalPeriod, '2021');
  assert.equal(statements.periods[0]!.lineItems.revenue, 200);
});

// ── user-message builder ─────────────────────────────────────────────────────
test('buildExtractionUserMessage truncates to maxChars and prefixes the filing text', () => {
  const msg = buildExtractionUserMessage('x'.repeat(50), 10);
  assert.equal(msg.startsWith('Financial-statement filing text:\n\n'), true);
  assert.equal(msg.endsWith('x'.repeat(10)), true);
  assert.equal(msg.includes('x'.repeat(11)), false);
});

// ── GOLDEN: real SABIC (2010) XBRL filing, captured from the live VPS build ────
test('GOLDEN: SABIC 2010 XBRL → byte-identical to the live VPS output', () => {
  const input = JSON.parse(readFileSync(resolve(here, '../../fixtures/tdwl/sabic-2010-xbrl.extracted.json'), 'utf8')) as ExtractedFinancials;
  const expected = JSON.parse(readFileSync(resolve(here, '../../fixtures/tdwl/sabic-2010-xbrl.statements.json'), 'utf8'));
  const got = extractToStatements(input, 'TDWL', '2010');
  assert.deepEqual(got, expected);
});

// ─── Phase A: runtime membership gate + widened types + presentation ──────────

test('gate: an unknown statement_type is REJECTED loudly (never ships unvalidated)', () => {
  const raw: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    statements: [stmt({ statement_type: 'garbage' as never, line_items: { x: 1 } })],
  };
  const v = validateExtraction(raw);
  assert.equal(v.ok, false);
  assert.equal(v.rejected.length, 1);
  assert.equal(v.rejected[0]!.reasons[0]!.check, 'unknown_statement_type');
});

test('gate: an unknown period_kind is REJECTED', () => {
  const raw: ExtractedFinancials = {
    currency: 'SAR', scale: 'units',
    statements: [stmt({ period_kind: 'fortnight' as never, line_items: { total_assets: 1 } })],
  };
  const v = validateExtraction(raw);
  assert.equal(v.rejected.length, 1);
  assert.equal(v.rejected[0]!.reasons[0]!.check, 'unknown_period_kind');
});

test('gate: oci and equity_change pass the gate and assemble', () => {
  const raw: ExtractedFinancials = {
    currency: 'SAR', scale: 'thousands',
    statements: [
      stmt({ statement_type: 'oci', line_items: { total_comprehensive_income: 6_250 } }),
      stmt({ statement_type: 'equity_change', line_items: { dividends_and_others: -540 } }),
    ],
  };
  const { statements, validation } = extractToStatements(raw, 'TDWL', '2010');
  assert.equal(validation.ok, true);
  assert.equal(statements.periods.length, 2);
  assert.equal(statements.periods[0]!.statementType, 'oci');
  assert.equal(statements.periods[0]!.lineItems.total_comprehensive_income, 6_250_000); // scaled
  assert.equal(statements.periods[1]!.statementType, 'equity_change');
});

test('assemble: presentation rides through untouched (never scaled)', () => {
  const raw: ExtractedFinancials = {
    currency: 'SAR', scale: 'thousands',
    statements: [stmt({
      line_items: { total_assets: 100, equity: 60, total_liabilities: 40 },
      presentation: [
        { key: 'total_assets', label: 'Total assets', depth: 0, is_subtotal: true },
        { key: 'equity', label: 'Total equity', depth: 0, is_subtotal: true },
      ],
    })],
  };
  const ns = assembleFromExtraction(raw, 'TDWL', '2010');
  assert.deepEqual(ns.periods[0]!.presentation, [
    { key: 'total_assets', label: 'Total assets', depth: 0, is_subtotal: true },
    { key: 'equity', label: 'Total equity', depth: 0, is_subtotal: true },
  ]);
});

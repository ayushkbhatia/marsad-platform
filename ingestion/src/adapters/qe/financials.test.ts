// Golden tests for the QE XBRL-native financials parser. Zero network: every assertion runs against
// fixtures captured verbatim from the live API on 2026-07-17 (see fixtures/qe/README.md).
//
// The load-bearing tests are the two taxonomy ones (Islamic bank, Takaful insurer): both fail the
// validateExtraction() accounting-identity gate under a naive tag mapping, and a regression there is
// silent — the rows simply stop being projected. Each asserts the real reported totals.
//
// Run: npm test   (from ingestion/)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeQeFacts,
  parseQeFilingDetail,
  parseQeFinancials,
  snakeFromTag,
  type QeSection,
  type QeSectionPayload,
} from './financials.js';
import { extractToStatements, validateExtraction } from '../../lake/statement-extraction.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, '../../../fixtures/qe', name), 'utf8'));

const payload = (section: QeSection, file: string): QeSectionPayload => ({
  section,
  rows: fx(file),
});

const find = (
  stmts: ReturnType<typeof parseQeFinancials>['statements'],
  type: string,
  end: string,
) => stmts.find((s) => s.statement_type === type && s.period_end === end);

// ─────────────────────────────────────────────────────────────────────────────
// Islamic bank (qse-crc_) — the EquityOfInvestmentAccountHolders landmine
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: Islamic-bank balance sheet reconciles via EquityOfInvestmentAccountHolders', () => {
  const raw = parseQeFinancials([payload('Balancesheet', 'fs-QIBK-2024-12-31-Balancesheet.json')]);

  assert.equal(raw.currency, 'QAR');
  assert.equal(raw.scale, 'units', 'QE values are absolute units — never rescale them');

  const bs = find(raw.statements, 'balance', '2024-12-31');
  assert.ok(bs, 'expected a 2024-12-31 balance sheet');
  assert.equal(bs.period_kind, 'annual', 'a 12-31 instant IS the annual balance sheet');

  // Verbatim QIBK FY2024 (QAR). total_liabilities is NOT the reported ifrs-full_Liabilities
  // (60,443,294,000) — it folds in IAH, which is what makes the identity hold.
  assert.equal(bs.line_items.total_assets, 200_779_776_000);
  assert.equal(bs.line_items.equity, 31_770_844_000);
  assert.equal(bs.line_items.equity_of_investment_account_holders, 108_565_638_000);
  assert.equal(bs.line_items.total_liabilities, 60_443_294_000 + 108_565_638_000);

  // The identity the gate enforces, exactly.
  const { total_assets: a, total_liabilities: l, equity: e } = bs.line_items as Record<string, number>;
  assert.equal(a - (l + e), 0, 'assets must equal liabilities + equity exactly');

  // And the gate itself must accept it. Naive mapping leaves a 54% gap -> reject.
  const v = validateExtraction(raw);
  assert.equal(v.rejected.length, 0, `gate rejected: ${JSON.stringify(v.rejected.map((r) => r.reasons))}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Takaful insurer (qse-ins-is_) — no ifrs-full_Assets at all
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: Takaful insurer balance sheet reconciles across shareholder/policyholder funds', () => {
  const raw = parseQeFinancials([payload('Balancesheet', 'fs-AKHI-2024-12-31-Balancesheet.json')]);
  const bs = find(raw.statements, 'balance', '2024-12-31');
  assert.ok(bs, 'expected a 2024-12-31 balance sheet');

  // Verbatim AKHI FY2024 (QAR): both funds summed on each side.
  assert.equal(bs.line_items.total_assets, 1_102_968_731);
  assert.equal(bs.line_items.equity, 627_761_746 + 33_881_817);
  assert.equal(bs.line_items.total_liabilities, 43_150_102 + 398_175_066);
  assert.equal(bs.line_items.shareholders_equity, 627_761_746);
  assert.equal(bs.line_items.policyholders_equity, 33_881_817);

  const { total_assets: a, total_liabilities: l, equity: e } = bs.line_items as Record<string, number>;
  assert.equal(a - (l + e), 0, 'assets must equal liabilities + equity exactly');

  const v = validateExtraction(raw);
  assert.equal(v.rejected.length, 0, `gate rejected: ${JSON.stringify(v.rejected.map((r) => r.reasons))}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Period-span semantics (quirk 3)
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: Q2 keeps the standalone quarter and drops the cumulative YTD column', () => {
  const raw = parseQeFinancials([
    payload('Incomestatement', 'fs-QIBK-2024-06-30-Incomestatement.json'),
  ]);

  const q2 = find(raw.statements, 'income', '2024-06-30');
  assert.ok(q2, 'expected a 2024-06-30 income statement');
  assert.equal(q2.period_kind, 'quarter');

  // The fixture carries BOTH 04-01->06-30 (1,108,136,000) and 01-01->06-30 (2,057,969,000).
  // "Q2 2024" must mean the quarter, so the standalone value wins and the YTD is dropped.
  assert.equal(q2.line_items.net_income, 1_108_136_000);

  // Exactly one income statement per period end — a YTD leak would collide on fiscal_period.
  const ends = raw.statements.filter((s) => s.statement_type === 'income').map((s) => s.period_end);
  assert.deepEqual([...new Set(ends)].sort(), ends.sort(), 'duplicate period_end in income statements');

  // Comparative is free (quirk 2): the prior-year standalone Q2.
  const q2Prior = find(raw.statements, 'income', '2023-06-30');
  assert.ok(q2Prior, 'expected the prior-year comparative');
  assert.equal(q2Prior.line_items.net_income, 1_052_875_000);
  assert.equal(q2Prior.period_kind, 'quarter');
});

test('QE financials: a 12-31 filing yields an annual period, never a standalone Q4', () => {
  const raw = parseQeFinancials([
    payload('Incomestatement', 'fs-QIBK-2024-12-31-Incomestatement.json'),
  ]);
  const income = raw.statements.filter((s) => s.statement_type === 'income');
  assert.ok(income.length >= 1);
  for (const s of income) {
    assert.equal(s.period_kind, 'annual', `${s.period_end} should be annual — QE emits no standalone Q4`);
  }
  assert.deepEqual(income.map((s) => s.period_end), ['2023-12-31', '2024-12-31']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical keys / revenue fallback
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: an industrial filer maps revenue and gross_profit from the standard tags', () => {
  const raw = parseQeFinancials([
    payload('Incomestatement', 'fs-IQCD-2024-12-31-Incomestatement.json'),
  ]);
  const is = find(raw.statements, 'income', '2024-12-31');
  assert.ok(is);
  assert.equal(typeof is.line_items.revenue, 'number');
  assert.equal(typeof is.line_items.gross_profit, 'number');
  assert.equal(typeof is.line_items.net_income, 'number');
  // The gate rejects gross_profit > revenue.
  assert.ok(
    (is.line_items.gross_profit as number) <= (is.line_items.revenue as number),
    'gross_profit must not exceed revenue',
  );
  assert.equal(validateExtraction(raw).rejected.length, 0);
});

test('QE financials: a bank with no ifrs-full_Revenue falls back to RevenueAndOperatingIncome', () => {
  const raw = parseQeFinancials([
    payload('Incomestatement', 'fs-QIBK-2024-12-31-Incomestatement.json'),
  ]);
  const is = find(raw.statements, 'income', '2024-12-31');
  assert.ok(is);
  assert.equal(typeof is.line_items.revenue, 'number', 'banks must still get a revenue primitive');
  assert.equal(is.line_items.revenue, is.line_items.revenue_and_operating_income);
});

test('QE financials: cashflow maps cfo/cfi/cff', () => {
  const raw = parseQeFinancials([payload('Cashflow', 'fs-QIBK-2024-12-31-Cashflow.json')]);
  const cf = find(raw.statements, 'cashflow', '2024-12-31');
  assert.ok(cf);
  for (const k of ['cfo', 'cfi', 'cff']) {
    assert.equal(typeof cf.line_items[k], 'number', `expected ${k}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end through the shared pipeline
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: all three sections flow through extractToStatements with zero rejections', () => {
  const raw = parseQeFinancials([
    payload('Balancesheet', 'fs-QIBK-2024-12-31-Balancesheet.json'),
    payload('Incomestatement', 'fs-QIBK-2024-12-31-Incomestatement.json'),
    payload('Cashflow', 'fs-QIBK-2024-12-31-Cashflow.json'),
  ]);

  const { statements, validation } = extractToStatements(raw, 'QE', 'QIBK');
  assert.equal(validation.rejected.length, 0, JSON.stringify(validation.rejected.map((r) => r.reasons)));
  assert.equal(statements.venue, 'QE');
  assert.equal(statements.ticker, 'QIBK');

  // Three statement types × (reported + comparative) = 6 periods.
  assert.equal(statements.periods.length, 6);
  for (const p of statements.periods) assert.equal(p.currency, 'QAR');

  // fiscal_period is re-derived canonically from period_end by assemble.
  const fy = statements.periods.find((p) => p.statementType === 'balance' && p.periodEnd === '2024-12-31');
  assert.ok(fy);
  assert.equal(fy.fiscalPeriod, '2024');
  assert.equal(fy.periodKind, 'annual');
  // scale='units' => values pass through unscaled.
  assert.equal(fy.lineItems.total_assets, 200_779_776_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Quirk 1: the unordered API
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: canonicalizeQeFacts is order-invariant', () => {
  const rows = fx('fs-QIBK-2024-12-31-Balancesheet.json') as unknown[];
  const shuffled = [...rows].reverse();
  assert.notDeepEqual(rows, shuffled, 'fixture too small to be a meaningful shuffle');
  assert.equal(
    canonicalizeQeFacts(rows),
    canonicalizeQeFacts(shuffled),
    'row order must not change the canonical form — QE returns a different order every call',
  );
});

test('QE financials: parse output is order-invariant', () => {
  const rows = fx('fs-QIBK-2024-12-31-Balancesheet.json') as unknown[];
  const a = parseQeFinancials([{ section: 'Balancesheet', rows }]);
  const b = parseQeFinancials([{ section: 'Balancesheet', rows: [...rows].reverse() }]);
  assert.deepEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc units
// ─────────────────────────────────────────────────────────────────────────────

test('QE financials: filedAt comes from approvedDate, read as Asia/Qatar (UTC+3)', () => {
  // Fixture: {"approvedDate":"2025-01-30T17:43:47.293", ...} — naive local wall-clock.
  assert.equal(
    parseQeFilingDetail(fx('filing-details-QIBK-2024-12-31.json')),
    '2025-01-30T14:43:47.000Z',
  );
  assert.equal(parseQeFilingDetail([]), null);
  assert.equal(parseQeFilingDetail(null), null);
});

test('QE financials: snakeFromTag strips the taxonomy prefix', () => {
  assert.equal(snakeFromTag('ifrs-full_PropertyPlantAndEquipment'), 'property_plant_and_equipment');
  assert.equal(snakeFromTag('qse-crc_EquityOfInvestmentAccountHolders'), 'equity_of_investment_account_holders');
  assert.equal(snakeFromTag('qse-ins-is_ShareholdersAndPolicyholdersAssets'), 'shareholders_and_policyholders_assets');
  // Acronym boundary.
  assert.equal(snakeFromTag('ifrs-full_NetIncomeFromIFRS9Assets'), 'net_income_from_ifrs9_assets');
});

test('QE financials: malformed payloads degrade to zero rows, never throw', () => {
  assert.deepEqual(parseQeFinancials([{ section: 'Balancesheet', rows: null }]).statements, []);
  assert.deepEqual(parseQeFinancials([{ section: 'Balancesheet', rows: 'nope' }]).statements, []);
  assert.deepEqual(parseQeFinancials([]).statements, []);
  assert.deepEqual(canonicalizeQeFacts('nope'), '[]');
});

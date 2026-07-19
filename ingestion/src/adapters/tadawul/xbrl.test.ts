// Tadawul XBRL adapter — parseTadawulXbrl (recovered from the live VPS build, byte-behaviour-identical)
// + parseTadawulProfile (the [100010] entity-identity extractor that fills DEF-SECTOR-DATA's TDWL half).
//
// The parseTadawulXbrl golden deep-equals a real SABIC (2010) filing's parse output captured from the
// live producer — it guarantees the reconstruction did not change the 6,964 live financial_statements
// rows. The profile tests lock the two things that matter: (a) the SABIC industrial case, and (b) the
// Al Rajhi BANK case, where mapping the sector cell alone ('Financials') would mis-file the bank under
// 'financials'; feeding the combined 'Financials | Banks' resolves to 'banks' (the ratio/Score cohort key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseTadawulXbrl, parseTadawulProfile } from './xbrl.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(resolve(here, '../../../fixtures/tdwl/', p), 'utf8');

// ── parseTadawulXbrl: byte-identical to the live producer (the 6,964-row guarantee) ──
test('GOLDEN: parseTadawulXbrl(SABIC 2010) === the live producer output', () => {
  const html = fx('sabic-2010-xbrl.source.html');
  const expected = JSON.parse(fx('sabic-2010-xbrl.extracted.json'));
  assert.deepEqual(parseTadawulXbrl(html), expected);
});

// ── parseTadawulProfile: the enrichment producer ──
test('SABIC (2010) industrial → sector materials, ISIN, industry Chemicals', () => {
  const p = parseTadawulProfile(fx('sabic-2010-xbrl.source.html'), '2010');
  assert.deepEqual(p, {
    venue: 'TDWL', ticker: '2010', sector: 'materials',
    rawSector: 'Materials | Chemicals', isin: 'SA0007879121',
    sharesOutstanding: null, industry: 'Chemicals',
  });
});

test('Al Rajhi (1120) BANK → sector banks (NOT financials), ISIN, industry Banks', () => {
  const p = parseTadawulProfile(fx('alrajhi-1120-filing-info.html'), '1120');
  assert.equal(p?.sector, 'banks'); // the inversion landmine: 'Financials' alone → 'financials'
  assert.equal(p?.isin, 'SA0007879113');
  assert.equal(p?.industry, 'Banks');
  assert.equal(p?.rawSector, 'Financials | Banks');
  assert.equal(p?.sharesOutstanding, null); // shares genuinely absent from XBRL
});

// ── unit: detection, guards, edge cases ──
const tbl = (rows: string) => `<table>${rows}</table>`;
const row2 = (label: string, value: string) => `<tr><td><span>${label}</span></td><td>${value}</td></tr>`;

test('feeds the combined string so the specific industry token wins the ordered sector rules', () => {
  // 'Insurance' industry under 'Financials' sector must resolve to 'insurance', not 'financials'.
  const html = tbl(row2('Company symbol code| ISIN code', '8010 | SA0007870010') + row2('Sector| Industry group', 'Financials | Insurance'));
  assert.equal(parseTadawulProfile(html, '8010')?.sector, 'insurance');
});

test('tolerates whitespace variation around the pipe in the label', () => {
  const html = tbl(row2('Company symbol code | ISIN code', '2222 | SA0007879122') + row2('Sector | Industry group', 'Energy | Oil & Gas'));
  const p = parseTadawulProfile(html, '2222');
  assert.equal(p?.isin, 'SA0007879122');
  assert.equal(p?.sector, 'energy');
});

test('rejects a malformed ISIN (wrong length/shape) → isin null but sector still lands', () => {
  const html = tbl(row2('Company symbol code| ISIN code', '1010 | NOT-AN-ISIN') + row2('Sector| Industry group', 'Materials | Cement'));
  const p = parseTadawulProfile(html, '1010');
  assert.equal(p?.isin, null);
  assert.equal(p?.sector, 'materials');
});

test('skips a value cell polluted with injected boomerang/mPulse JS', () => {
  // A bank filing injects JS into some value cells; the identity value must not be a script blob.
  const jsCell = '<td>window.BOOMR=function(){/* go-mpulse */}</td>';
  const html = tbl(`<tr><td><span>Company symbol code| ISIN code</span></td>${jsCell}</tr>` + row2('Sector| Industry group', 'Financials | Banks'));
  const p = parseTadawulProfile(html, '1120');
  assert.equal(p?.isin, null);     // the JS cell was skipped, no false ISIN
  assert.equal(p?.sector, 'banks');
});

test('a filing with no [100010] identity block → null (never stage an empty object)', () => {
  const html = tbl(row2('Total assets', '1,000,000') + row2('Total equity', '400,000'));
  assert.equal(parseTadawulProfile(html, '2010'), null);
});

test('unmappable sector degrades to unknown but keeps rawSector + ISIN', () => {
  const html = tbl(row2('Company symbol code| ISIN code', '7010 | SA0007879999') + row2('Sector| Industry group', 'Zorble | Widgets'));
  const p = parseTadawulProfile(html, '7010');
  assert.equal(p?.sector, 'unknown'); // no taxonomy rule matches → LOGGED unknown fallback
  assert.equal(p?.rawSector, 'Zorble | Widgets');
  assert.equal(p?.isin, 'SA0007879999');
});

test('IT sector maps to the technology key (migration 20260716190059)', () => {
  const html = tbl(row2('Company symbol code| ISIN code', '7200 | SA0007879998') + row2('Sector| Industry group', 'Information Technology | IT Services'));
  const p = parseTadawulProfile(html, '7200');
  assert.equal(p?.sector, 'technology');
  assert.equal(p?.rawSector, 'Information Technology | IT Services');
  assert.equal(p?.isin, 'SA0007879998');
});

// ─── Phase A: presentation capture (label + document order; depth 0 — no indent in XBRL HTML) ─

test('parseTadawulXbrl: emits presentation rows in document order with subtotal flags', () => {
  const fs = parseTadawulXbrl(readFileSync(resolve(here, '../../../fixtures/tdwl/sabic-2010-xbrl.source.html'), 'utf8'));
  const bal = fs.statements.find((s) => s.statement_type === 'balance' && !s.is_comparative)!;
  assert.ok(bal.presentation && bal.presentation.length > 10, 'balance presentation missing/too small');
  // Every presentation key maps onto a landed line_items key; order is de-duplicated document order.
  const keys = bal.presentation!.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'presentation keys must be unique');
  for (const r of bal.presentation!) {
    assert.ok(bal.line_items[r.key] !== undefined, `presentation key ${r.key} has no line_items value`);
    assert.equal(r.depth, 0); // XBRL_DOCS HTML carries no indent markup
    assert.equal(r.is_subtotal, /^total\b/i.test(r.label));
  }
  // 'Total assets' printed AFTER its components — document order preserved.
  const ta = keys.indexOf('total_assets');
  assert.ok(ta > 0, 'total_assets must not be first');
});

// ─── Phase B: oci + equity_change capture ─────────────────────────────────────

test('Phase B: SABIC filing yields oci + equity_change statements (11 total, was 7)', () => {
  const fs = parseTadawulXbrl(fx('sabic-2010-xbrl.source.html'));
  const types = fs.statements.map((s) => s.statement_type);
  assert.equal(fs.statements.length, 11);
  assert.equal(types.filter((t) => t === 'oci').length, 2);
  assert.equal(types.filter((t) => t === 'equity_change').length, 2);
});

test('Phase B oci: doc-predicted values land and the statement FOOTS (net_income + total_oci = TCI)', () => {
  const fs = parseTadawulXbrl(fx('sabic-2010-xbrl.source.html'));
  const oci = fs.statements.find((s) => s.statement_type === 'oci' && !s.is_comparative)!;
  const li = oci.line_items as Record<string, number>;
  assert.equal(li.net_income, 6_114_744);
  assert.equal(li.remeasurement_gains_losses_on_defined_benefit_plans, 1_852_815);
  // snake-160: the two associate rows ("will" / "will not" be reclassified) keep DISTINCT keys.
  assert.equal(li.share_of_other_comprehensive_income_of_associates_and_joint_ventures_accounted_for_using_equity_method_that_will_not_be_reclassified_to_profit_or_loss, 130_530);
  assert.equal(li.share_of_other_comprehensive_income_of_associates_and_joint_ventures_accounted_for_using_equity_method_that_will_be_reclassified_to_profit_or_loss, -977_698);
  // foots exactly: 6,114,744 + 135,323 = 6,250,067, parent + NCI split intact (doc §1.3)
  const totalOci = li.total_other_comprehensive_income_loss;
  const tci = li.total_comprehensive_income_loss_for_period;
  assert.equal(totalOci, 135_323);
  assert.equal(tci, 6_250_067);
  assert.equal(li.net_income + totalOci, tci);
  assert.equal(li.total_comprehensive_income_loss_attributable_to_equity_holders_of_parent, 4_771_679);
  assert.equal(li.total_comprehensive_income_loss_attributable_to_non_controlling_interests, 1_478_388);
});

test('Phase B equity_change: dimensional parse — member-qualified + bare Total-equity keys', () => {
  const fs = parseTadawulXbrl(fx('sabic-2010-xbrl.source.html'));
  const eq = fs.statements.find((s) => s.statement_type === 'equity_change' && !s.is_comparative)!;
  const li = eq.line_items as Record<string, number>;
  assert.equal(eq.fiscal_period, 'Q1 2021');
  assert.equal(li.dividends_and_others, -540_138); // Total-equity member → bare key (doc §1.3)
  assert.equal(li.dividends_and_others__non_controlling_interests, -540_138);
  assert.equal(li.equity_balance_at_end_of_period, 199_947_053);
  assert.equal(li.equity_balance_at_end_of_period__share_capital, 30_000_000);
  // presentation carries ONLY bare keys, each resolvable in line_items, in document order.
  assert.ok(eq.presentation!.length >= 8);
  for (const r of eq.presentation!) assert.ok(li[r.key] !== undefined, `presentation key ${r.key} unresolvable`);
  // comparative column got its own statement
  const comp = fs.statements.find((s) => s.statement_type === 'equity_change' && s.is_comparative)!;
  assert.equal(comp.fiscal_period, 'Q1 2020');
});

test('Phase B classify: combined P&L+OCI single statement now lands as income (was dropped)', () => {
  const mk = (title: string) =>
    `<table><tr><td>Start Date</td><td>2025-01-01</td></tr><tr><td>End Date</td><td>2025-03-31</td></tr>` +
    `<tr><td>${title} [abstract]</td><td></td></tr><tr><td>Revenue</td><td>1,000</td></tr></table>`;
  const combined = parseTadawulXbrl(mk('Statement of profit or loss and other comprehensive income'));
  assert.equal(combined.statements.length, 1);
  assert.equal(combined.statements[0]!.statement_type, 'income');
  const pureOci = parseTadawulXbrl(mk('Statement of other comprehensive income, before tax'));
  assert.equal(pureOci.statements[0]!.statement_type, 'oci');
  // bare "comprehensive income" (no "other", no tax qualifier) stays unclassified — ambiguous
  const bare = parseTadawulXbrl(mk('Statement of comprehensive income'));
  assert.equal(bare.statements.length, 0);
});

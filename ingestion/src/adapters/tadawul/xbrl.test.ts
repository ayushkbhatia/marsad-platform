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

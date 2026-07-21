/**
 * Unit tests for the DIVIDEND.EXDATE dated-declaration normalizer (lake/dividend-declared.ts).
 *
 * Deterministic, zero network / DB (mirrors staging-map.test.ts). Covers the properties the
 * producer + cross-check + reader depend on:
 *   - DPS coercion + strict ISO date parsing (garbage → null, never fabricated);
 *   - div_type mapping from the filing title (SPECIAL > INTERIM > FINAL);
 *   - fiscal_ref + natural_key determinism (idempotent re-runs collapse onto one object);
 *   - single-source → 1 root vs double-source → 2 roots, primary-wins source_rank;
 *   - the public.dividends upsert row shape (state pending_confirm, currency NOT-NULL fallback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDividend,
  normalizeDivType,
  parseIsoDate,
  toDps,
  deriveFiscalRef,
  dividendNaturalKey,
  disclosureRoot,
  buildLineageRoots,
  dividendObjectPayload,
  dividendUpsertRow,
  normalizeCurrency,
  venueCurrency,
  EXCHANGE_RANK,
  REGISTRAR_RANK,
  AGGREGATOR_RANK,
  type DividendFilingRow,
} from './dividend-declared.js';

function filing(over: Partial<DividendFilingRow> = {}): DividendFilingRow {
  return {
    id: 555,
    venue: 'TDWL',
    ticker: '7010',
    title: 'Board recommends interim cash dividend',
    filedAt: '2026-07-13T10:30:00.000Z',
    aiDividend: { dps: 1.25, currency: 'SAR', ex_date: '2026-08-01', record_date: '2026-08-03', pay_date: '2026-08-15' },
    ...over,
  };
}

// ── DPS coercion ────────────────────────────────────────────────────────────
test('toDps: number, numeric string, comma-grouped → number; junk/zero/negative → null', () => {
  assert.equal(toDps(1.25), 1.25);
  assert.equal(toDps('0.60'), 0.6);
  assert.equal(toDps('1,250.5'), 1250.5);
  assert.equal(toDps(0), null); // a zero DPS is not a declaration
  assert.equal(toDps(-1), null);
  assert.equal(toDps('n/a'), null);
  assert.equal(toDps(null), null);
  assert.equal(toDps(undefined), null);
});

// ── ISO date parsing ────────────────────────────────────────────────────────
test('parseIsoDate: strict YYYY-MM-DD, rejects impossible + malformed', () => {
  assert.equal(parseIsoDate('2026-08-01'), '2026-08-01');
  assert.equal(parseIsoDate('2026-02-30'), null); // no such day
  assert.equal(parseIsoDate('2026-13-01'), null); // no such month
  assert.equal(parseIsoDate('01/08/2026'), null); // wrong format
  assert.equal(parseIsoDate(''), null);
  assert.equal(parseIsoDate(null), null);
  assert.equal(parseIsoDate('2026-08-01T00:00:00Z'), null); // datetime, not a bare date
});

// ── div_type mapping ────────────────────────────────────────────────────────
test('normalizeDivType: SPECIAL > INTERIM > FINAL default', () => {
  assert.equal(normalizeDivType('Special one-off distribution'), 'SPECIAL');
  assert.equal(normalizeDivType('Board recommends interim cash dividend'), 'INTERIM');
  assert.equal(normalizeDivType('Q3 dividend'), 'INTERIM');
  assert.equal(normalizeDivType('First half dividend'), 'INTERIM');
  assert.equal(normalizeDivType('Proposal for cash dividends'), 'FINAL'); // default
  assert.equal(normalizeDivType(null), 'FINAL');
});

// ── currency fallback (dividends.currency is char(3) NOT NULL) ───────────────
test('normalizeCurrency: valid code kept; blank/garbage → venue default', () => {
  assert.equal(normalizeCurrency('omr', 'MSX'), 'OMR');
  assert.equal(normalizeCurrency(null, 'TDWL'), 'SAR');
  assert.equal(normalizeCurrency('', 'DFM'), 'AED');
  assert.equal(normalizeCurrency('Riyal', 'QE'), 'QAR'); // not a 3-letter code → default
  assert.equal(venueCurrency('BHB'), 'BHD');
});

// ── fiscal_ref + natural_key determinism ────────────────────────────────────
test('deriveFiscalRef: FINAL=FYyyyy, INTERIM=yyyy-INT, SPECIAL=yyyy-SPL; year from ex_date then filedAt', () => {
  assert.equal(deriveFiscalRef('FINAL', '2025-04-10', '2026-01-01T00:00:00Z'), 'FY2025'); // ex_date wins
  assert.equal(deriveFiscalRef('INTERIM', null, '2026-07-13T10:30:00Z'), '2026-INT'); // fall back to filedAt
  assert.equal(deriveFiscalRef('SPECIAL', null, '2026-07-13T10:30:00Z'), '2026-SPL');
});

test('dividendNaturalKey: DIVIDEND.EXDATE:venue:ticker:type:fiscal — stable across re-extract (idempotency)', () => {
  const a = extractDividend(filing())!;
  const b = extractDividend(filing())!;
  const key = dividendNaturalKey(a);
  assert.equal(key, 'DIVIDEND.EXDATE:TDWL:7010:INTERIM:2026-INT');
  assert.equal(dividendNaturalKey(b), key); // deterministic
});

// ── extraction ──────────────────────────────────────────────────────────────
test('extractDividend: builds a NormalizedDividend with parsed dates + disclosure verification', () => {
  const d = extractDividend(filing())!;
  assert.equal(d.venue, 'TDWL');
  assert.equal(d.ticker, '7010');
  assert.equal(d.divType, 'INTERIM');
  assert.equal(d.dps, 1.25);
  assert.equal(d.currency, 'SAR');
  assert.equal(d.exDate, '2026-08-01');
  assert.equal(d.recordDate, '2026-08-03');
  assert.equal(d.payDate, '2026-08-15');
  assert.equal(d.verification, 'disclosure');
  assert.equal(d.fiscalRef, '2026-INT');
});

test('extractDividend: no dps → null (a DIVIDEND filing with no per-share figure is not a declaration)', () => {
  assert.equal(extractDividend(filing({ aiDividend: { dps: null, currency: 'SAR' } })), null);
  assert.equal(extractDividend(filing({ aiDividend: null })), null);
});

test('extractDividend: missing/garbled dates degrade to null, DPS still lands; fiscal year falls back to filedAt', () => {
  const d = extractDividend(
    filing({ title: 'Proposal for cash dividends', aiDividend: { dps: 0.5, currency: null, ex_date: 'soon', record_date: null } }),
  )!;
  assert.equal(d.dps, 0.5);
  assert.equal(d.currency, 'SAR'); // venue fallback (currency was null)
  assert.equal(d.exDate, null); // 'soon' is not a valid date
  assert.equal(d.recordDate, null);
  assert.equal(d.divType, 'FINAL'); // title carries no interim/special marker
  assert.equal(d.fiscalRef, 'FY2026'); // no ex_date → year taken from filedAt (2026)
});

// ── lineage roots: single-source vs double-source ───────────────────────────
test('buildLineageRoots: single disclosure → 1 root at exchange rank', () => {
  const l = buildLineageRoots(disclosureRoot(555, 'CG-1-2026-4471'));
  assert.equal(l.count, 1);
  assert.equal(l.sourceRank, EXCHANGE_RANK);
  assert.equal(l.roots[0]!.root, 'disclosure');
  assert.equal(l.roots[0]!.filingId, 555);
});

test('buildLineageRoots: disclosure + corroborating → 2 roots, primary-wins (lowest) source_rank', () => {
  // A registrar corroboration outranks the exchange filing (10 < 20).
  const reg = buildLineageRoots(disclosureRoot(555, 'CG-1-2026-4471'), {
    root: 'registrar',
    rank: REGISTRAR_RANK,
    objectId: 'obj-reg',
  });
  assert.equal(reg.count, 2);
  assert.equal(reg.sourceRank, REGISTRAR_RANK);

  // An aggregator/equity-projection corroboration is ranked below the exchange (90), so the
  // exchange filing stays primary.
  const agg = buildLineageRoots(disclosureRoot(555, null), {
    root: 'equity_projection',
    rank: AGGREGATOR_RANK,
    objectId: 'obj-equity',
  });
  assert.equal(agg.count, 2);
  assert.equal(agg.sourceRank, EXCHANGE_RANK);
});

// ── object payload + dividends upsert row ────────────────────────────────────
test('dividendObjectPayload: snake_case, carries lineage_root_count for the ≥2-root precondition', () => {
  const d = extractDividend(filing())!;
  const lineage = buildLineageRoots(disclosureRoot(555, 'CG-1-2026-4471'), { root: 'equity_projection', rank: AGGREGATOR_RANK, objectId: 'obj-equity' });
  const p = dividendObjectPayload(d, 555, lineage);
  assert.equal(p.div_type, 'INTERIM');
  assert.equal(p.dps, 1.25);
  assert.equal(p.ex_date, '2026-08-01');
  assert.equal(p.source_filing_id, 555);
  assert.equal(p.lineage_root_count, 2);
  assert.equal(p.lineage_roots.length, 2);
  // Two builds of the same declaration → identical payload (stable content hash → cross-check dedupe).
  assert.deepEqual(dividendObjectPayload(extractDividend(filing())!, 555, lineage), p);
});

test('dividendUpsertRow: state pending_confirm, references the source lake object, currency present', () => {
  const d = extractDividend(filing())!;
  const row = dividendUpsertRow(d, 42, 'lake-obj-uuid');
  assert.equal(row.security_id, 42);
  assert.equal(row.state, 'pending_confirm');
  assert.equal(row.verification, 'disclosure');
  assert.equal(row.source_object_id, 'lake-obj-uuid');
  assert.equal(row.currency, 'SAR');
  assert.equal(row.div_type, 'INTERIM');
  assert.equal(row.fiscal_ref, '2026-INT');
  assert.equal(row.ex_date, '2026-08-01');
});

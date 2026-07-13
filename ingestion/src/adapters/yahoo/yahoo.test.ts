// Golden tests for the Yahoo adapter: symbol mapping + quotes parser + OHLCV parser, against the real
// VPS-captured fixtures. Zero network. Run: node --import tsx --test (from ingestion/).
//
// The parsers' correctness is load-bearing for the 2-source cross-check: the venue+ticker they emit
// (Yahoo suffix STRIPPED) must produce the SAME natural_key as the primary source (CONTRACT §6.5), so
// these tests assert the stripped ticker explicitly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toYahooSymbol, fromYahooSymbol, isYahooVenue } from './symbols.js';
import { yahooQuotes } from './quotes.js';
import { yahooOhlcv } from './ohlcv.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixDir = resolve(here, '../../../fixtures/yahoo');

function snapshot(file: string, dataType: string): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'TDWL',
    dataType: dataType as StoredSnapshot['dataType'],
    contentType: 'application/json',
    externalId: null,
    body: readFileSync(resolve(fixDir, file)),
    fetchedAt: '2026-07-13T13:00:00.000Z',
    meta: { lang: 'en', source: 'yahoo' },
  };
}

// ── symbols ─────────────────────────────────────────────────────────────────────────────────────

test('toYahooSymbol: maps the three covered venues with the right suffix', () => {
  assert.equal(toYahooSymbol('TDWL', '2222'), '2222.SR');
  assert.equal(toYahooSymbol('DFM', 'EMAAR'), 'EMAAR.AE'); // .AE, not .DU
  assert.equal(toYahooSymbol('QE', 'QNBK'), 'QNBK.QA');
});

test('toYahooSymbol: returns null for uncovered venues and blank tickers', () => {
  assert.equal(toYahooSymbol('ADX', 'FAB'), null);
  assert.equal(toYahooSymbol('MSX', 'OQGN'), null);
  assert.equal(toYahooSymbol('BHB', 'AUB'), null);
  assert.equal(toYahooSymbol('TDWL', ''), null);
  assert.equal(toYahooSymbol('TDWL', '   '), null);
});

test('isYahooVenue: only TDWL/DFM/QE', () => {
  for (const v of ['TDWL', 'DFM', 'QE'] as const) assert.equal(isYahooVenue(v), true);
  for (const v of ['ADX', 'MSX', 'BHB'] as const) assert.equal(isYahooVenue(v), false);
});

test('fromYahooSymbol: strips the suffix and recovers (venue, raw ticker)', () => {
  assert.deepEqual(fromYahooSymbol('2222.SR'), { venue: 'TDWL', ticker: '2222' });
  assert.deepEqual(fromYahooSymbol('EMAAR.AE'), { venue: 'DFM', ticker: 'EMAAR' });
  assert.deepEqual(fromYahooSymbol('QNBK.QA'), { venue: 'QE', ticker: 'QNBK' });
  assert.deepEqual(fromYahooSymbol('qnbk.qa'), { venue: 'QE', ticker: 'qnbk' }); // suffix case-insensitive
});

test('fromYahooSymbol: rejects non-GCC / malformed symbols (never mis-attribute)', () => {
  assert.equal(fromYahooSymbol('AAPL'), null);
  assert.equal(fromYahooSymbol('AAPL.US'), null);
  assert.equal(fromYahooSymbol('.SR'), null);
  assert.equal(fromYahooSymbol('2222.'), null);
  assert.equal(fromYahooSymbol(''), null);
});

test('round-trip: toYahooSymbol → fromYahooSymbol preserves (venue, ticker)', () => {
  for (const [venue, ticker] of [['TDWL', '2222'], ['DFM', 'EMAAR'], ['QE', 'QNBK']] as const) {
    const sym = toYahooSymbol(venue, ticker)!;
    assert.deepEqual(fromYahooSymbol(sym), { venue, ticker });
  }
});

// ── quotes parser (per-symbol v8/chart) ──────────────────────────────────────────────────────────

test('yahoo quotes: 2222.SR → TDWL/2222, last=26.5, change from chartPreviousClose', () => {
  const { rows, parserVersion } = yahooQuotes.parse(snapshot('quote-2222-sr.json', 'quotes'));
  assert.equal(parserVersion, yahooQuotes.parserVersion);
  assert.equal(rows.length, 1);
  const q = rows[0]!;
  assert.equal(q.venue, 'TDWL');
  assert.equal(q.ticker, '2222'); // suffix stripped → cross-check key collision w/ Mubasher
  assert.equal(q.last, 26.5);
  // change = 26.5 - 26.78 (chartPreviousClose; meta has NO previousClose)
  assert.equal(q.change, -0.28);
  // changePct is rounded to 4dp (numeric(9,4)); computed from (last-prevClose)/prevClose*100.
  assert.equal(q.changePct, Number((((26.5 - 26.78) / 26.78) * 100).toFixed(4)));
  assert.equal(q.high, 26.78);
  assert.equal(q.low, 26.5);
  assert.equal(q.volume, 6549051);
  assert.equal(q.week52High, 27.96);
  assert.equal(q.week52Low, 23.04);
  // asOf from regularMarketTime epoch seconds 1783945149 → 2026-07-13T12:19:09Z
  assert.equal(q.asOf, '2026-07-13T12:19:09.000Z');
});

test('yahoo quotes: EMAAR.AE → DFM/EMAAR, last=11.6', () => {
  const { rows } = yahooQuotes.parse(snapshot('quote-emaar-ae.json', 'quotes'));
  assert.equal(rows.length, 1);
  const q = rows[0]!;
  assert.equal(q.venue, 'DFM');
  assert.equal(q.ticker, 'EMAAR');
  assert.equal(q.last, 11.6);
  assert.equal(q.change, Number((11.6 - 11.86).toFixed(6)));
});

test('yahoo quotes: QNBK.QA → QE/QNBK, last=17.22 (exchangeName DOH is ignored)', () => {
  const { rows } = yahooQuotes.parse(snapshot('quote-qnbk-qa.json', 'quotes'));
  assert.equal(rows.length, 1);
  const q = rows[0]!;
  assert.equal(q.venue, 'QE'); // keyed off .QA suffix, NOT meta.exchangeName ('DOH')
  assert.equal(q.ticker, 'QNBK');
  assert.equal(q.last, 17.22);
});

test('yahoo quotes: null regularMarketPrice (halted security) → dropped, no null-price candidate', () => {
  // A valid envelope+meta but no price: Yahoo has no confirmable fact, so it must NOT emit a
  // last=null cross-check candidate (which could falsely "agree" with another null in agreement.ts).
  const body = JSON.stringify({
    chart: { result: [{ meta: { symbol: '2222.SR', regularMarketPrice: null, chartPreviousClose: 26.78, regularMarketTime: 1783945149 } }] },
  });
  const snap: StoredSnapshot = { ...snapshot('quote-2222-sr.json', 'quotes'), body: Buffer.from(body) };
  const { rows } = yahooQuotes.parse(snap);
  assert.equal(rows.length, 0);
});

test('yahoo quotes: malformed body → zero rows (PARSE_DRIFT upstream), no throw', () => {
  const bad: StoredSnapshot = { ...snapshot('quote-2222-sr.json', 'quotes'), body: Buffer.from('<html>error</html>') };
  const { rows } = yahooQuotes.parse(bad);
  assert.equal(rows.length, 0);
});

// ── OHLCV parser (range=2y backfill) ─────────────────────────────────────────────────────────────

test('yahoo ohlcv: 2222.SR range=2y → ~505 bars, TDWL/2222, close NOT NULL', () => {
  const { rows, parserVersion } = yahooOhlcv.parse(snapshot('ohlcv-2222-sr.json', 'ohlcv_backfill'));
  assert.equal(parserVersion, yahooOhlcv.parserVersion);
  assert.ok(rows.length >= 500, `expected ~505 daily bars, got ${rows.length}`);
  assert.ok(rows.length <= 510);

  for (const r of rows) {
    assert.equal(r.venue, 'TDWL');
    assert.equal(r.ticker, '2222'); // suffix stripped → OHLCV.CLOSE key collision
    assert.equal(typeof r.close, 'number'); // NOT NULL guaranteed
    assert.match(r.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  }

  // First bar: ts 1720940400 (+gmtoffset 10800 AST) → 2024-07-14 local.
  const first = rows[0]!;
  assert.equal(first.tradeDate, '2024-07-14');
  assert.equal(first.open, 28.149999618530273); // raw OHLC, index-aligned (NOT adjclose)
  assert.equal(first.high, 28.25);
  assert.equal(first.low, 28.100000381469727);
  assert.equal(first.close, 28.100000381469727);
  assert.equal(first.volume, 11825264);

  // ≥2-year span: last bar 2026-07-13.
  const last = rows[rows.length - 1]!;
  assert.equal(last.tradeDate, '2026-07-13');
  const spanDays = (Date.parse(last.tradeDate) - Date.parse(first.tradeDate)) / 86_400_000;
  assert.ok(spanDays >= 720, `expected ≥2y span, got ${spanDays} days`);
});

test('yahoo ohlcv: tradeDates are strictly increasing and unique', () => {
  const { rows } = yahooOhlcv.parse(snapshot('ohlcv-2222-sr.json', 'ohlcv_backfill'));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.tradeDate > rows[i - 1]!.tradeDate, `non-increasing at ${i}: ${rows[i - 1]!.tradeDate} → ${rows[i]!.tradeDate}`);
  }
});

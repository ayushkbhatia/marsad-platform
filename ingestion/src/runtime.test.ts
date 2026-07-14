// runtime.test.ts — provider-aware task resolution + Yahoo symbol-list wiring.
//
// These are the load-bearing invariants of the provider-routing module (P1.5):
//   1. A source with endpoint_config.provider='yahoo' + data_type 'quotes' resolves to the Yahoo
//      quotes TaskSpec — NOT the primary (venue,data_type) adapter task.
//   2. data_type 'ohlcv_backfill' on a Yahoo source resolves to the Yahoo OHLCV backfill task.
//   3. A primary source (no provider) resolves to the existing venue adapter task, UNCHANGED — so
//      DFM/MSX/QE/etc. are not broken by the provider branch.
//   4. The Yahoo per-symbol fetch list is built from public.securities (via toYahooSymbol), unless
//      the row already carries an explicit Desk-set symbols list (config-over-code override).
//
// All PURE / DB-faked — no pool, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTasksForSource, yahooSymbolsForVenue, withYahooSymbols } from './runtime.js';
import { yahooTasks } from './adapters/yahoo/index.js';
import { ADAPTERS } from './adapters/index.js';
import type { Sql } from './core/db.js';
import type { SourceRecord, DataType, VenueCode } from './core/types.js';

/** Minimal SourceRecord factory. endpoint_config is deliberately loosely typed so a test can add
 *  provider/symbols (the alt-provider fields the runtime reads via a local cast). */
function makeSource(
  over: Partial<SourceRecord> & { endpointConfig?: Record<string, unknown> } = {},
): SourceRecord {
  return {
    id: 1,
    venue: 'TDWL',
    dataType: 'quotes' as DataType,
    entryUrl: 'https://example.test/board',
    endpointConfig: { responseKind: 'json' } as SourceRecord['endpointConfig'],
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    lastContentHash: null,
    ...over,
  } as SourceRecord;
}

// ── 1. provider='yahoo' quotes → the Yahoo quotes task ──────────────────────────────────────────
test('provider=yahoo + quotes resolves to the Yahoo quotes TaskSpec', () => {
  const src = makeSource({
    venue: 'TDWL',
    dataType: 'quotes',
    endpointConfig: { responseKind: 'json', provider: 'yahoo', suffix: '.SR' },
  });
  const tasks = resolveTasksForSource(src);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], yahooTasks.quotes, 'must be the Yahoo quotes task, not the primary adapter');
  // And explicitly NOT the primary TDWL quotes task.
  assert.notEqual(tasks[0], ADAPTERS.TDWL.quotes);
});

// ── 2. ohlcv_backfill → the Yahoo OHLCV backfill task ───────────────────────────────────────────
test('provider=yahoo + ohlcv_backfill resolves to the Yahoo OHLCV backfill TaskSpec', () => {
  const src = makeSource({
    venue: 'DFM',
    dataType: 'ohlcv_backfill' as DataType,
    endpointConfig: { responseKind: 'json', provider: 'yahoo', suffix: '.AE' },
  });
  const tasks = resolveTasksForSource(src);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], yahooTasks.ohlcvBackfill);
});

// ── 3. primary sources (no provider) are UNCHANGED ──────────────────────────────────────────────
test('primary quotes source (no provider) resolves to the venue adapter quotes task', () => {
  for (const venue of ['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB'] as VenueCode[]) {
    const src = makeSource({ venue, dataType: 'quotes', endpointConfig: { responseKind: 'json' } });
    const tasks = resolveTasksForSource(src);
    const adapter = ADAPTERS[venue];
    if (adapter.quotes) {
      assert.ok(tasks.includes(adapter.quotes as never), `${venue} quotes must resolve to its own adapter task`);
      assert.ok(!tasks.includes(yahooTasks.quotes as never), `${venue} primary must NOT be the Yahoo task`);
    }
  }
});

test('primary filings_list source resolves to the venue adapter filingsList task', () => {
  const src = makeSource({ venue: 'DFM', dataType: 'filings_list', endpointConfig: { responseKind: 'json' } });
  const tasks = resolveTasksForSource(src);
  const fl = ADAPTERS.DFM.filingsList;
  if (fl) assert.ok(tasks.includes(fl as never));
  assert.ok(!tasks.includes(yahooTasks.quotes as never));
  assert.ok(!tasks.includes(yahooTasks.ohlcvBackfill as never));
});

// ── 4. provider=yahoo with an unsupported data_type yields no task (never mis-dispatch) ──────────
test('provider=yahoo with an unsupported data_type resolves to no task', () => {
  const src = makeSource({
    venue: 'TDWL',
    dataType: 'filings_list',
    endpointConfig: { responseKind: 'json', provider: 'yahoo' },
  });
  assert.deepEqual(resolveTasksForSource(src), []);
});

// ── 5. non-yahoo provider value is ignored (falls through to primary) ────────────────────────────
test('a non-yahoo provider value falls through to the primary adapter', () => {
  const src = makeSource({
    venue: 'QE',
    dataType: 'quotes',
    endpointConfig: { responseKind: 'json', provider: 'mubasher' },
  });
  const tasks = resolveTasksForSource(src);
  const qeQuotes = ADAPTERS.QE.quotes;
  if (qeQuotes) assert.ok(tasks.includes(qeQuotes as never));
  assert.ok(!tasks.includes(yahooTasks.quotes as never));
});

// ── 6. Yahoo symbol list built from public.securities via toYahooSymbol ─────────────────────────

/** A fake postgres.js tagged-template that returns a fixed rowset for the securities query. */
function fakeSql(rows: Array<{ ticker: string }>): Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as Sql;
  return fn;
}

test('yahooSymbolsForVenue projects securities tickers to Yahoo symbols (suffix appended)', async () => {
  const sql = fakeSql([{ ticker: '2222' }, { ticker: '1120' }]);
  const symbols = await yahooSymbolsForVenue(sql, 'TDWL');
  assert.deepEqual(symbols, ['2222.SR', '1120.SR']);
});

test('yahooSymbolsForVenue drops tickers with no Yahoo mapping (non-covered venue)', async () => {
  // ADX is not a Yahoo-covered venue ⇒ toYahooSymbol returns null ⇒ dropped.
  const sql = fakeSql([{ ticker: 'ALPHADHABI' }]);
  const symbols = await yahooSymbolsForVenue(sql, 'ADX');
  assert.deepEqual(symbols, []);
});

test('withYahooSymbols injects the securities-derived list into endpoint_config.symbols', async () => {
  const sql = fakeSql([{ ticker: 'EMAAR' }, { ticker: 'DIB' }]);
  const src = makeSource({
    venue: 'DFM',
    dataType: 'quotes',
    endpointConfig: { responseKind: 'json', provider: 'yahoo', suffix: '.AE' },
  });
  const resolved = await withYahooSymbols(sql, src);
  const cfg = resolved.endpointConfig as unknown as { symbols?: unknown };
  assert.deepEqual(cfg.symbols, ['EMAAR.AE', 'DIB.AE']);
  // The original source is not mutated.
  const orig = src.endpointConfig as unknown as { symbols?: unknown };
  assert.equal(orig.symbols, undefined);
});

test('withYahooSymbols keeps an explicit Desk-set symbols list (config-over-code override)', async () => {
  let queried = false;
  const sql = ((..._a: unknown[]) => {
    queried = true;
    return Promise.resolve([{ ticker: 'SHOULD_NOT_APPEAR' }]);
  }) as unknown as Sql;
  const src = makeSource({
    venue: 'TDWL',
    dataType: 'quotes',
    endpointConfig: { responseKind: 'json', provider: 'yahoo', suffix: '.SR', symbols: ['2222.SR'] },
  });
  const resolved = await withYahooSymbols(sql, src);
  const cfg = resolved.endpointConfig as unknown as { symbols?: unknown };
  assert.deepEqual(cfg.symbols, ['2222.SR']);
  assert.equal(queried, false, 'must not query securities when an explicit list is present');
  assert.equal(resolved, src, 'returns the same object unchanged');
});

test('withYahooSymbols is a no-op for a non-yahoo (primary) source', async () => {
  let queried = false;
  const sql = ((..._a: unknown[]) => {
    queried = true;
    return Promise.resolve([]);
  }) as unknown as Sql;
  const src = makeSource({ venue: 'QE', dataType: 'quotes', endpointConfig: { responseKind: 'json' } });
  const resolved = await withYahooSymbols(sql, src);
  assert.equal(resolved, src);
  assert.equal(queried, false, 'primary sources never trigger the securities query');
});

// ── coverage guard: a fully-backfilled ohlcv_backfill source emits an EXPLICIT empty symbols list ──
// (the "coverage complete" signal runTask skips on — graceful backfill stop). An empty list must be
// SET, not omitted, so it is distinguishable from a never-injected source.
test('withYahooSymbols sets symbols:[] for a fully-backfilled ohlcv_backfill source (graceful stop)', async () => {
  const sql = fakeSql([]); // listedTickersForVenue coverage-filtered everything out
  const src = makeSource({
    venue: 'TDWL',
    dataType: 'ohlcv_backfill' as DataType,
    endpointConfig: { responseKind: 'json', provider: 'yahoo', suffix: '.SR' },
  });
  const resolved = await withYahooSymbols(sql, src);
  const cfg = resolved.endpointConfig as unknown as { symbols?: unknown };
  assert.deepEqual(cfg.symbols, [], 'empty symbols must be set explicitly (coverage-complete signal)');
});

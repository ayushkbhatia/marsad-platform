// Golden + fetch + routing tests for the MSX ≥2y daily-close company-chart-data.aspx backfill adapter.
// Zero network. Run: node --import tsx --test (from ingestion/).
//
// The parser's correctness is load-bearing for the 2-source cross-check: the venue+ticker it emits
// (recovered from snapshot.meta, NOT the JSON bytes) must produce the SAME natural_key as any future
// MSX EOD-bulletin bar (OHLCV.CLOSE:MSX:BKMB:{tradeDate}, CONTRACT §6.5), so these assert the
// meta-carried venue/ticker explicitly. The daily/intraday split (space-timestamped current-day ticks
// filtered out) and the close-only null-OHLC contract are the other correctness deliverables.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  msxHistory,
  parseMsxHistory,
  MSX_HISTORY_PARSER_VERSION,
} from './history.js';
import { resolveTasksForSource } from '../../runtime.js';
import type {
  FetchContext,
  FetchOptions,
  FetchResult,
  HttpClient,
  RawResponse,
  SourceRecord,
  StoredSnapshot,
} from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixDir = resolve(here, '../../../fixtures/msx');

// Real captured company-chart-data.aspx?s=BKMB sample (2026-07-14): 6 daily rows (first 3 real
// IPO-era 2003, last 3 real recent) + 2 real current-day intraday ticks (space-timestamped).
const BKMB = readFileSync(resolve(fixDir, 'company-chart-BKMB.json'));

function snapshot(body: Buffer, meta: Record<string, unknown>): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'MSX',
    dataType: 'ohlcv_backfill',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-14T14:00:00.000Z',
    meta,
  };
}

// ── PARSE golden (against the real captured BKMB JSON) ────────────────────────────────────────────

test('msx history: BKMB JSON → daily bars only, MSX/BKMB, close-only (open/high/low null)', () => {
  const { rows, parserVersion } = parseMsxHistory(snapshot(BKMB, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(parserVersion, MSX_HISTORY_PARSER_VERSION);
  assert.equal(parserVersion, msxHistory.parserVersion);

  // The fixture has 6 daily rows + 2 space-timestamped intraday ticks → exactly 6 daily bars survive.
  assert.equal(rows.length, 6, 'the two intraday ticks (space-delimited Date) are filtered out');

  for (const r of rows) {
    assert.equal(r.venue, 'MSX');
    assert.equal(r.ticker, 'BKMB');
    assert.equal(typeof r.close, 'number'); // NOT NULL guaranteed
    assert.match(r.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.tradeDate.includes(' '), false, 'no intraday timestamp leaked through');
    // Close-only venue: open/high/low are NEVER fabricated.
    assert.equal(r.open, null);
    assert.equal(r.high, null);
    assert.equal(r.low, null);
  }

  // First daily bar = the real 2003 IPO-era row (LTP==Value==close).
  const first = rows[0]!;
  assert.equal(first.tradeDate, '2003-01-01');
  assert.equal(first.close, 3.8);
  assert.equal(first.volume, 1300);
  assert.equal(first.valueTraded, 4950);

  // Last daily bar = the most recent completed session (2026-07-13, NOT today's intraday).
  const last = rows[rows.length - 1]!;
  assert.equal(last.tradeDate, '2026-07-13');
  assert.equal(last.close, 0.395);
  assert.equal(last.volume, 8431620);
  assert.equal(last.valueTraded, 3343045.326);
});

test('msx history: emits daily rows in source file order (faithful 1:1 projection, no reorder)', () => {
  const { rows } = parseMsxHistory(snapshot(BKMB, { venue: 'MSX', ticker: 'BKMB' }));
  const daily = (JSON.parse(BKMB.toString('utf8')) as Array<{ Date: string }>)
    .filter((r) => !r.Date.includes(' '));
  assert.equal(rows.length, daily.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i]!.tradeDate, daily[i]!.Date, `row ${i} preserves source order`);
  }
});

// ── PARSE edge cases ──────────────────────────────────────────────────────────────────────────────

test('msx history: missing meta.ticker → zero rows (no mis-attribution)', () => {
  const { rows } = parseMsxHistory(snapshot(BKMB, { venue: 'MSX' }));
  assert.equal(rows.length, 0);
});

test('msx history: unknown venue → zero rows', () => {
  const { rows } = parseMsxHistory(snapshot(BKMB, { venue: 'NASDAQ', ticker: 'BKMB' }));
  assert.equal(rows.length, 0);
});

test('msx history: non-JSON garbage body → zero rows, no throw', () => {
  const body = Buffer.from('<html><body>403 Forbidden</body></html>');
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(rows.length, 0);
});

test('msx history: non-array JSON → zero rows', () => {
  const body = Buffer.from('{"error":"no data"}');
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(rows.length, 0);
});

test('msx history: space-timestamped intraday ticks are always dropped', () => {
  const body = Buffer.from(
    JSON.stringify([
      { Date: '2026-07-13', Value: '0.395', LTP: '0.395', Volume: '100', Turnover: '39.5', open: null, high: null, low: null },
      { Date: '2026-07-14 10:00:06', Year: 2026, Month: 7, Day: 14, Hour: 10, Minute: 0, LTP: 0.398, Value: 0.398, Volume: 468, Turnover: 398 },
      { Date: '2026-07-14 14:44:36', Year: 2026, Month: 7, Day: 14, Hour: 14, Minute: 44, LTP: 0.392, Value: 0.392, Volume: 1000, Turnover: 392 },
    ]),
  );
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(rows.length, 1, 'only the space-free daily row survives');
  assert.equal(rows[0]!.tradeDate, '2026-07-13');
});

test('msx history: a row with a null/blank close (LTP and Value) is skipped (close NOT NULL)', () => {
  const body = Buffer.from(
    JSON.stringify([
      { Date: '2026-07-01', Value: '1.00', LTP: '1.00', Volume: '10', Turnover: '10', open: null, high: null, low: null },
      { Date: '2026-07-02', Value: null, LTP: null, Volume: '20', Turnover: '20', open: null, high: null, low: null },
      { Date: '2026-07-03', Value: '', LTP: '', Volume: '30', Turnover: '30', open: null, high: null, low: null },
      { Date: '2026-07-06', Value: '1.05', LTP: '1.05', Volume: '40', Turnover: '42', open: null, high: null, low: null },
    ]),
  );
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.deepEqual(rows.map((r) => r.tradeDate), ['2026-07-01', '2026-07-06'], 'null/blank close bars dropped');
});

test('msx history: a genuine 0 close is kept (close 0 is a real value, not null)', () => {
  const body = Buffer.from(
    JSON.stringify([{ Date: '2026-07-01', Value: '0', LTP: '0', Volume: '0', Turnover: '0', open: null, high: null, low: null }]),
  );
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.close, 0);
  assert.equal(rows[0]!.volume, 0);
});

test('msx history: close falls back to Value when LTP is absent', () => {
  const body = Buffer.from(
    JSON.stringify([{ Date: '2026-07-01', Value: '2.50', Volume: '10', Turnover: '25', open: null, high: null, low: null }]),
  );
  const { rows } = parseMsxHistory(snapshot(body, { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.close, 2.5);
});

// ── FETCH: single-GET mock, streaming sink, isolation, bounded pool, array path ───────────────────

const browserBoom = () => {
  throw new Error('msx history backfill is plain http — must not touch ctx.browser');
};

/**
 * Single-GET HttpClient double. Any URL for a ticker in `notFound` returns HTTP 404 (skipped); every
 * other returns a valid one-row daily JSON array. Records URLs and tracks max in-flight to prove the
 * lane cap AND actual parallelism; yields a macrotask so lanes interleave.
 */
class ChartHttpClient implements HttpClient {
  public readonly gets: string[] = [];
  public inFlight = 0;
  public maxInFlight = 0;
  constructor(private readonly notFound: Set<string> = new Set()) {}

  async get(url: string, _opts?: FetchOptions): Promise<RawResponse> {
    this.gets.push(url);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setImmediate(r)); // yield so concurrent lanes overlap
    this.inFlight -= 1;

    const sym = decodeURIComponent(url.substring(url.lastIndexOf('=') + 1));
    if (this.notFound.has(sym)) {
      return { url, status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('not found'), fromCache304: false };
    }
    const body = Buffer.from(
      JSON.stringify([{ Date: '2026-07-13', Value: '0.395', LTP: '0.395', Volume: '8431620', Turnover: '3343045.326', open: null, high: null, low: null }]),
    );
    return { url, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body, fromCache304: false };
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    return this.get(url, opts);
  }
}

function makeSource(symbols: string[], fetchConcurrency?: number): SourceRecord {
  const endpointConfig: Record<string, unknown> = {
    method: 'GET',
    responseKind: 'json',
    provider: 'msx-company-chart',
    urlTemplate: 'https://www.msx.om/company-chart-data.aspx?s={symbol}',
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    symbols,
  };
  if (fetchConcurrency !== undefined) endpointConfig.fetch_concurrency = fetchConcurrency;
  return {
    id: 1,
    venue: 'MSX',
    dataType: 'ohlcv_backfill',
    entryUrl: 'https://www.msx.om/company-chart-data.aspx?s={symbol}',
    endpointConfig: endpointConfig as unknown as SourceRecord['endpointConfig'],
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    lastContentHash: null,
  };
}

function makeCtx(
  source: SourceRecord,
  http: HttpClient,
  onFetched?: (f: FetchResult) => Promise<void>,
): FetchContext {
  const ctx: FetchContext = {
    source,
    http,
    browser: {
      bootstrap: browserBoom as never,
      refreshIfChallenged: browserBoom as never,
      get: browserBoom as never,
      request: browserBoom as never,
      close: async () => {},
    } as unknown as FetchContext['browser'],
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    now: () => '2026-07-14T00:00:00.000Z',
  };
  if (onFetched) ctx.onFetched = onFetched;
  return ctx;
}

test('msx history fetch: streaming sink stages each ticker w/ meta, isolates 404, bounds concurrency', async () => {
  const http = new ChartHttpClient(new Set(['DELISTED']));
  const source = makeSource(['BKMB', 'OQGN', 'DELISTED', 'OMINV', 'SMNP'], 2);
  const staged: FetchResult[] = [];
  const returned = await msxHistory.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.deepEqual(returned, [], 'streaming path drains via the sink and returns nothing');
  assert.equal(staged.length, 4, 'DELISTED (404) skipped; the other four staged');
  assert.equal(http.maxInFlight, 2, 'pool ran exactly fetch_concurrency=2 in parallel (bounded AND concurrent)');
  assert.deepEqual(staged.map((f) => f.externalId).sort(), ['BKMB', 'OMINV', 'OQGN', 'SMNP']);
  for (const f of staged) {
    assert.equal(f.httpStatus, 200);
    assert.equal(f.meta!.venue, 'MSX');
    assert.equal(f.meta!.source, 'msx-company-chart');
    assert.equal(f.meta!.dataType, 'ohlcv_backfill');
    assert.equal(typeof f.meta!.ticker, 'string');
    assert.ok(f.url.includes('company-chart-data.aspx'));
  }
});

test('msx history fetch: no sink → serial array (back-compat), failures skipped', async () => {
  const http = new ChartHttpClient(new Set(['DELISTED']));
  const source = makeSource(['BKMB', 'DELISTED', 'OQGN'], 8);
  const returned = await msxHistory.fetch(makeCtx(source, http)); // no onFetched

  assert.equal(returned.length, 2, 'array path returns the survivors');
  assert.equal(http.maxInFlight, 1, 'no sink ⇒ strictly serial, never overlaps');
  assert.deepEqual(returned.map((f) => f.externalId).sort(), ['BKMB', 'OQGN']);
});

test('msx history fetch: absent fetch_concurrency defaults the pool to 4', async () => {
  const http = new ChartHttpClient();
  const source = makeSource(['BKMB', 'OQGN', 'OMINV', 'SMNP', 'OTEL', 'ARENA']); // no fetch_concurrency
  const staged: FetchResult[] = [];
  await msxHistory.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.equal(staged.length, 6);
  assert.equal(http.maxInFlight, 4, 'default 4 caps the pool even with 6 tickers');
});

test('msx history fetch: a staged JSON parses end-to-end with the meta-carried venue/ticker', async () => {
  const http = new ChartHttpClient();
  const source = makeSource(['BKMB'], 1);
  const staged: FetchResult[] = [];
  await msxHistory.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));
  assert.equal(staged.length, 1);
  const f = staged[0]!;
  const { rows } = parseMsxHistory(snapshot(f.body, f.meta!));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.venue, 'MSX');
  assert.equal(rows[0]!.ticker, 'BKMB');
  assert.equal(rows[0]!.close, 0.395);
  assert.equal(rows[0]!.open, null); // close-only
});

// ── ROUTING (provider-aware resolution) ───────────────────────────────────────────────────────────

test('msx history routing: provider=msx-company-chart + ohlcv_backfill → msxHistory', () => {
  const source = makeSource(['BKMB']);
  const tasks = resolveTasksForSource(source);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], msxHistory);
});

test('msx history routing: provider=msx-company-chart + quotes → no task (never mis-dispatch)', () => {
  const source = makeSource(['BKMB']);
  source.dataType = 'quotes';
  assert.deepEqual(resolveTasksForSource(source), []);
});

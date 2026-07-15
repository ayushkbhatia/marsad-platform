// Parse + fetch + routing tests for the BHB webapi DataExportCompanyProfile ≥2y EOD-close backfill
// adapter. Zero network (inline shape-samples — the DataExportCompanyProfile response is verified in
// BHB-API-CONTRACT.md §2). Run: node --import tsx --test (from ingestion/).
//
// The parser's correctness is load-bearing for the 2-source cross-check: the venue+ticker it emits
// (recovered from snapshot.meta, NOT the JSON bytes) must produce the SAME natural_key as the live BHB
// webapi quote's OHLCV bar (OHLCV.CLOSE:BHB:GFH:{tradeDate}, CONTRACT §6.5), so these assert the
// meta-carried venue/ticker explicitly. The EMPTY-STRING date key, the space-padded Price, the
// MM/DD/YYYY→YYYY-MM-DD conversion, the status:2 "No items found!" empty response, and the
// EOD-CLOSE-ONLY null-OHLCV contract are the other correctness deliverables.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bhbOhlcvBackfill,
  parseBhbOhlcv,
  toIsoTradeDate,
  BHB_OHLCV_PARSER_VERSION,
} from './ohlcv.js';
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

// A real-shape DataExportCompanyProfile response (BHB-API-CONTRACT.md §2): date key is the EMPTY STRING,
// Price is a space-padded string. Two rows: a normal close and a genuine boundary value.
const GFH_EXPORT = Buffer.from(
  JSON.stringify({
    status: 1,
    data: [
      { '': '01/05/2020', Price: '   0.230' },
      { '': '12/31/2026', Price: '0.415' },
    ],
  }),
  'utf8',
);

function snapshot(body: Buffer, meta: Record<string, unknown>): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'BHB',
    dataType: 'ohlcv_backfill',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-15T14:00:00.000Z',
    meta,
  };
}

// ── toIsoTradeDate (the MM/DD/YYYY → YYYY-MM-DD pure rewrite) ──────────────────────────────────────

test('bhb ohlcv: MM/DD/YYYY → YYYY-MM-DD (zero-pads month/day, no tz math)', () => {
  assert.equal(toIsoTradeDate('01/05/2020'), '2020-01-05');
  assert.equal(toIsoTradeDate('12/31/2026'), '2026-12-31');
  assert.equal(toIsoTradeDate('7/4/2021'), '2021-07-04'); // single-digit month AND day both pad
  assert.equal(toIsoTradeDate('  03/09/2015  '), '2015-03-09'); // surrounding whitespace tolerated
});

test('bhb ohlcv: toIsoTradeDate rejects non-date shapes (→ null, caller skips the row)', () => {
  assert.equal(toIsoTradeDate('2020-01-05'), null); // already ISO — not the source MM/DD/YYYY shape
  assert.equal(toIsoTradeDate('Date'), null); // a stray header cell
  assert.equal(toIsoTradeDate('01/05/20'), null); // 2-digit year not accepted (avoid century guessing)
  assert.equal(toIsoTradeDate(''), null);
  assert.equal(toIsoTradeDate(undefined), null);
  assert.equal(toIsoTradeDate(42), null);
});

// ── PARSE golden (against the real-shape GFH export) ──────────────────────────────────────────────

test('bhb ohlcv: DataExport JSON → EOD-close bars, BHB/GFH, close-only (open/high/low/volume null)', () => {
  const { rows, parserVersion } = parseBhbOhlcv(snapshot(GFH_EXPORT, { venue: 'BHB', ticker: 'GFH' }));
  assert.equal(parserVersion, BHB_OHLCV_PARSER_VERSION);
  assert.equal(parserVersion, bhbOhlcvBackfill.parserVersion);

  assert.equal(rows.length, 2);

  for (const r of rows) {
    assert.equal(r.venue, 'BHB');
    assert.equal(r.ticker, 'GFH');
    assert.equal(typeof r.close, 'number'); // NOT NULL guaranteed
    assert.match(r.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
    // EOD-CLOSE-ONLY feed (owner requirement): open/high/low/volume are NEVER fabricated.
    assert.equal(r.open, null);
    assert.equal(r.high, null);
    assert.equal(r.low, null);
    assert.equal(r.volume, null);
  }

  // First row: MM/DD/YYYY → ISO, space-padded Price parsed to a number.
  assert.equal(rows[0]!.tradeDate, '2020-01-05');
  assert.equal(rows[0]!.close, 0.23);
  // Second row: a non-padded Price and a year-boundary date.
  assert.equal(rows[1]!.tradeDate, '2026-12-31');
  assert.equal(rows[1]!.close, 0.415);
});

test('bhb ohlcv: emits rows in source-file order (faithful 1:1 projection, no reorder)', () => {
  const { rows } = parseBhbOhlcv(snapshot(GFH_EXPORT, { venue: 'BHB', ticker: 'GFH' }));
  assert.deepEqual(rows.map((r) => r.tradeDate), ['2020-01-05', '2026-12-31']);
});

// ── PARSE edge cases ──────────────────────────────────────────────────────────────────────────────

test('bhb ohlcv: status:2 (data:null, "No items found!") → zero rows, no throw', () => {
  const body = Buffer.from(JSON.stringify({ status: 2, data: null, message: 'No items found!' }), 'utf8');
  const { rows } = parseBhbOhlcv(snapshot(body, { venue: 'BHB', ticker: 'DELISTED' }));
  assert.equal(rows.length, 0);
});

test('bhb ohlcv: missing meta.ticker → zero rows (no mis-attribution)', () => {
  const { rows } = parseBhbOhlcv(snapshot(GFH_EXPORT, { venue: 'BHB' }));
  assert.equal(rows.length, 0);
});

test('bhb ohlcv: unknown venue → zero rows', () => {
  const { rows } = parseBhbOhlcv(snapshot(GFH_EXPORT, { venue: 'NASDAQ', ticker: 'GFH' }));
  assert.equal(rows.length, 0);
});

test('bhb ohlcv: non-JSON garbage body (CF challenge HTML) → zero rows, no throw', () => {
  const body = Buffer.from('<html><body>Attention Required! | Cloudflare</body></html>');
  const { rows } = parseBhbOhlcv(snapshot(body, { venue: 'BHB', ticker: 'GFH' }));
  assert.equal(rows.length, 0);
});

test('bhb ohlcv: a row with a null/blank Price is skipped (close NOT NULL); a garbage date row is skipped', () => {
  const body = Buffer.from(
    JSON.stringify({
      status: 1,
      data: [
        { '': '01/01/2024', Price: '1.000' },
        { '': '01/02/2024', Price: null }, // null close — dropped
        { '': '01/03/2024', Price: '   ' }, // blank close — dropped
        { '': 'Date', Price: '9.999' }, // stray header cell (non-date) — dropped
        { '': '01/06/2024', Price: '1.050' },
      ],
    }),
    'utf8',
  );
  const { rows } = parseBhbOhlcv(snapshot(body, { venue: 'BHB', ticker: 'GFH' }));
  assert.deepEqual(rows.map((r) => r.tradeDate), ['2024-01-01', '2024-01-06']);
});

test('bhb ohlcv: a genuine 0 close is kept (close 0 is a real value, not null)', () => {
  const body = Buffer.from(JSON.stringify({ status: 1, data: [{ '': '01/01/2024', Price: '   0.000' }] }), 'utf8');
  const { rows } = parseBhbOhlcv(snapshot(body, { venue: 'BHB', ticker: 'GFH' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.close, 0);
});

test('bhb ohlcv: non-array data or absent status → zero rows', () => {
  assert.equal(parseBhbOhlcv(snapshot(Buffer.from('{"status":1,"data":{}}'), { venue: 'BHB', ticker: 'GFH' })).rows.length, 0);
  assert.equal(parseBhbOhlcv(snapshot(Buffer.from('{"data":[]}'), { venue: 'BHB', ticker: 'GFH' })).rows.length, 0);
});

// ── FETCH: single-GET mock, streaming sink, isolation, bounded pool, array path, URL shape ─────────

const browserBoom = () => {
  throw new Error('bhb ohlcv backfill is plain http (via sticky proxy) — must not touch ctx.browser');
};

/**
 * Single-GET HttpClient double. Any URL for a symbol in `notFound` returns HTTP 404 (skipped); every
 * other returns a valid status:1 one-row export. Records URLs and tracks max in-flight to prove the lane
 * cap AND actual parallelism; yields a macrotask so lanes interleave.
 */
class ExportHttpClient implements HttpClient {
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

    const sym = decodeURIComponent(/parameterValue=([^&]*)/.exec(url)?.[1] ?? '');
    if (this.notFound.has(sym)) {
      return { url, status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('not found'), fromCache304: false };
    }
    const body = Buffer.from(JSON.stringify({ status: 1, data: [{ '': '12/31/2026', Price: '   0.415' }] }), 'utf8');
    return { url, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body, fromCache304: false };
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    return this.get(url, opts);
  }
}

const URL_TEMPLATE =
  'https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}';

function makeSource(symbols: string[], extra?: { fetchConcurrency?: number; fromYear?: number }): SourceRecord {
  const endpointConfig: Record<string, unknown> = {
    method: 'GET',
    responseKind: 'json',
    provider: 'bhb_webapi',
    urlTemplate: URL_TEMPLATE,
    headers: { Authorization: 'Bearer test', Accept: 'application/json' },
    use_proxy: true,
    proxy_mode: 'sticky',
    symbols,
  };
  if (extra?.fetchConcurrency !== undefined) endpointConfig.fetch_concurrency = extra.fetchConcurrency;
  if (extra?.fromYear !== undefined) endpointConfig.fromYear = extra.fromYear;
  return {
    id: 1,
    venue: 'BHB',
    dataType: 'ohlcv_backfill',
    entryUrl: URL_TEMPLATE,
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
  now = '2026-07-15T00:00:00.000Z',
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
    now: () => now,
  };
  if (onFetched) ctx.onFetched = onFetched;
  return ctx;
}

test('bhb ohlcv fetch: streaming sink stages each symbol w/ meta, isolates 404, bounds concurrency', async () => {
  const http = new ExportHttpClient(new Set(['DELISTED']));
  const source = makeSource(['GFH', 'BBK', 'DELISTED', 'BEYON', 'NBB'], { fetchConcurrency: 2 });
  const staged: FetchResult[] = [];
  const returned = await bhbOhlcvBackfill.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.deepEqual(returned, [], 'streaming path drains via the sink and returns nothing');
  assert.equal(staged.length, 4, 'DELISTED (404) skipped; the other four staged');
  assert.equal(http.maxInFlight, 2, 'pool ran exactly fetch_concurrency=2 in parallel (bounded AND concurrent)');
  assert.deepEqual(staged.map((f) => f.externalId).sort(), ['BBK', 'BEYON', 'GFH', 'NBB']);
  for (const f of staged) {
    assert.equal(f.httpStatus, 200);
    assert.equal(f.meta!.venue, 'BHB');
    assert.equal(f.meta!.source, 'bhb_webapi');
    assert.equal(f.meta!.dataType, 'ohlcv_backfill');
    assert.equal(typeof f.meta!.ticker, 'string');
    assert.ok(f.url.includes('DataExportCompanyProfile'));
  }
});

test('bhb ohlcv fetch: URL is built with {symbol}, {fromYear} and {toYear}=current year (from ctx.now())', async () => {
  const http = new ExportHttpClient();
  const source = makeSource(['GFH'], { fromYear: 2000 });
  await bhbOhlcvBackfill.fetch(makeCtx(source, http, async () => {}, '2026-07-15T00:00:00.000Z'));
  assert.equal(http.gets.length, 1);
  const url = http.gets[0]!;
  assert.ok(url.includes('parameterValue=GFH'), 'symbol substituted');
  assert.ok(url.includes('FromDateYear=2000'), 'fromYear from endpoint_config');
  assert.ok(url.includes('ToDateYear=2026'), 'toYear = current year from ctx.now()');
});

test('bhb ohlcv fetch: no sink → serial array (back-compat), failures skipped', async () => {
  const http = new ExportHttpClient(new Set(['DELISTED']));
  const source = makeSource(['GFH', 'DELISTED', 'BBK'], { fetchConcurrency: 8 });
  const returned = await bhbOhlcvBackfill.fetch(makeCtx(source, http)); // no onFetched

  assert.equal(returned.length, 2, 'array path returns the survivors');
  assert.equal(http.maxInFlight, 1, 'no sink ⇒ strictly serial, never overlaps');
  assert.deepEqual(returned.map((f) => f.externalId).sort(), ['BBK', 'GFH']);
});

test('bhb ohlcv fetch: absent fetch_concurrency defaults the pool to 4', async () => {
  const http = new ExportHttpClient();
  const source = makeSource(['GFH', 'BBK', 'BEYON', 'NBB', 'SALAM', 'TRAFCO']); // no fetch_concurrency
  const staged: FetchResult[] = [];
  await bhbOhlcvBackfill.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.equal(staged.length, 6);
  assert.equal(http.maxInFlight, 4, 'default 4 caps the pool even with 6 symbols');
});

test('bhb ohlcv fetch: a staged JSON parses end-to-end with the meta-carried venue/ticker', async () => {
  const http = new ExportHttpClient();
  const source = makeSource(['GFH'], { fetchConcurrency: 1 });
  const staged: FetchResult[] = [];
  await bhbOhlcvBackfill.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));
  assert.equal(staged.length, 1);
  const f = staged[0]!;
  const { rows } = parseBhbOhlcv(snapshot(f.body, f.meta!));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.venue, 'BHB');
  assert.equal(rows[0]!.ticker, 'GFH');
  assert.equal(rows[0]!.close, 0.415);
  assert.equal(rows[0]!.open, null); // close-only
  assert.equal(rows[0]!.volume, null);
});

// ── ROUTING (provider-aware resolution) ───────────────────────────────────────────────────────────

test('bhb ohlcv routing: provider=bhb_webapi + ohlcv_backfill → bhbOhlcvBackfill', () => {
  const source = makeSource(['GFH']);
  const tasks = resolveTasksForSource(source);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], bhbOhlcvBackfill);
});

test('bhb ohlcv routing: provider=bhb_webapi + quotes → no task (never mis-dispatch)', () => {
  const source = makeSource(['GFH']);
  source.dataType = 'quotes';
  assert.deepEqual(resolveTasksForSource(source), []);
});

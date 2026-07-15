// Parse + fetch + routing tests for the MSX full-OHLCV summary-report.aspx/List backfill adapter.
// Zero network. Run: node --import tsx --test (from ingestion/).
//
// The parser's correctness is load-bearing for the 2-source cross-check: the venue+ticker it emits
// (recovered from snapshot.meta, NOT the JSON bytes) must produce the SAME natural_key as any future
// MSX EOD-bulletin bar (OHLCV.CLOSE:MSX:BKMB:{tradeDate}, CONTRACT §6.5), so these assert the
// meta-carried venue/ticker explicitly. Full OHLC + the "Mmm DD, YYYY"→ISO date conversion and the
// comma-stripped numerics are the other correctness deliverables.

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

// A real summary-report.aspx/List shape: {"d":[ …oldest-first… ]}, numbers as (comma-grouped) strings.
const LIST_BODY = JSON.stringify({
  d: [
    { Symbol: 'BKMB', DateEn: 'Jan 01, 2003', Open: '3.8200', High: '3.8200', Low: '3.8000', Close: '3.810', Volume: '1,300', Turnover: '4,950' },
    { Symbol: 'BKMB', DateEn: 'Jul 14, 2026', Open: '0.3980', High: '0.3990', Low: '0.3910', Close: '0.392', Volume: '13,488,558', Turnover: '5,324,793' },
  ],
});

function snapshot(body: Buffer, meta: Record<string, unknown>): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'MSX',
    dataType: 'ohlcv_backfill',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-15T14:00:00.000Z',
    meta,
  };
}

// ── PARSE ─────────────────────────────────────────────────────────────────────────────────────────

test('msx history: List JSON → full OHLCV bars, MSX/BKMB, ISO date, comma-stripped volume', () => {
  const { rows, parserVersion } = parseMsxHistory(snapshot(Buffer.from(LIST_BODY), { venue: 'MSX', ticker: 'BKMB' }));
  assert.equal(parserVersion, MSX_HISTORY_PARSER_VERSION);
  assert.equal(parserVersion, msxHistory.parserVersion);
  assert.equal(rows.length, 2);

  const first = rows[0]!;
  assert.equal(first.venue, 'MSX');
  assert.equal(first.ticker, 'BKMB');
  assert.equal(first.tradeDate, '2003-01-01'); // "Jan 01, 2003" → ISO
  assert.equal(first.open, 3.82);
  assert.equal(first.high, 3.82);
  assert.equal(first.low, 3.8);
  assert.equal(first.close, 3.81);
  assert.equal(first.volume, 1300);
  assert.equal(first.valueTraded, 4950);

  const last = rows[1]!;
  assert.equal(last.tradeDate, '2026-07-14');
  assert.equal(last.open, 0.398);
  assert.equal(last.close, 0.392);
  assert.equal(last.volume, 13488558); // "13,488,558" comma-stripped
  assert.equal(last.valueTraded, 5324793);
});

test('msx history: tolerates a bare array (no {d} wrapper)', () => {
  const bare = JSON.stringify([{ DateEn: 'Jul 14, 2026', Open: '1', High: '1', Low: '1', Close: '1.0', Volume: '5', Turnover: '5' }]);
  const { rows } = parseMsxHistory(snapshot(Buffer.from(bare), { venue: 'MSX', ticker: 'OQGN' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tradeDate, '2026-07-14');
  assert.equal(rows[0]!.close, 1);
});

test('msx history: a row with a null/blank close is skipped (close NOT NULL); genuine 0 kept', () => {
  const body = JSON.stringify({
    d: [
      { DateEn: 'Jul 01, 2026', Close: '1.00', Volume: '10', Turnover: '10' },
      { DateEn: 'Jul 02, 2026', Close: null, Volume: '20', Turnover: '20' },
      { DateEn: 'Jul 03, 2026', Close: '', Volume: '30', Turnover: '30' },
      { DateEn: 'Jul 06, 2026', Close: '0', Open: '0', Volume: '0', Turnover: '0' },
    ],
  });
  const { rows } = parseMsxHistory(snapshot(Buffer.from(body), { venue: 'MSX', ticker: 'BKMB' }));
  assert.deepEqual(rows.map((r) => r.tradeDate), ['2026-07-01', '2026-07-06']);
  const zero = rows.find((r) => r.tradeDate === '2026-07-06')!;
  assert.equal(zero.close, 0); // a genuine 0 close is a real value, not null
});

test('msx history: a row whose date is not "Mmm DD, YYYY" is skipped (garbage/intraday)', () => {
  const body = JSON.stringify({
    d: [
      { DateEn: 'Jul 01, 2026', Close: '1.00' },
      { DateEn: '2026-07-02 10:00:06', Close: '1.01' }, // not the "Mmm DD, YYYY" daily format
      { DateEn: 'garbage', Close: '1.02' },
    ],
  });
  const { rows } = parseMsxHistory(snapshot(Buffer.from(body), { venue: 'MSX', ticker: 'BKMB' }));
  assert.deepEqual(rows.map((r) => r.tradeDate), ['2026-07-01']);
});

test('msx history: missing meta.ticker → zero rows (no mis-attribution)', () => {
  assert.equal(parseMsxHistory(snapshot(Buffer.from(LIST_BODY), { venue: 'MSX' })).rows.length, 0);
});

test('msx history: unknown venue → zero rows', () => {
  assert.equal(parseMsxHistory(snapshot(Buffer.from(LIST_BODY), { venue: 'NASDAQ', ticker: 'BKMB' })).rows.length, 0);
});

test('msx history: non-JSON garbage / non-array → zero rows, no throw', () => {
  assert.equal(parseMsxHistory(snapshot(Buffer.from('<html>403</html>'), { venue: 'MSX', ticker: 'BKMB' })).rows.length, 0);
  assert.equal(parseMsxHistory(snapshot(Buffer.from('{"d":null}'), { venue: 'MSX', ticker: 'BKMB' })).rows.length, 0);
});

// ── FETCH: POST body, streaming sink, isolation, bounded pool, array path ──────────────────────────

const browserBoom = () => {
  throw new Error('msx history backfill is plain http — must not touch ctx.browser');
};

/** POST HttpClient double. Parses the request body for Symbol; a Symbol in `notFound` returns 404,
 *  every other returns a valid one-row List body. Records bodies + tracks max in-flight. */
class ListHttpClient implements HttpClient {
  public readonly posts: { url: string; body: string }[] = [];
  public inFlight = 0;
  public maxInFlight = 0;
  constructor(private readonly notFound: Set<string> = new Set()) {}

  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    const body = typeof opts.body === 'string' ? opts.body : opts.body?.toString('utf8') ?? '';
    this.posts.push({ url, body });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setImmediate(r)); // yield so concurrent lanes overlap
    this.inFlight -= 1;

    const sym = (JSON.parse(body) as { Symbol?: string }).Symbol ?? '';
    if (this.notFound.has(sym)) {
      return { url, status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('not found'), fromCache304: false };
    }
    const payload = Buffer.from(
      JSON.stringify({ d: [{ Symbol: sym, DateEn: 'Jul 14, 2026', Open: '0.398', High: '0.399', Low: '0.391', Close: '0.392', Volume: '13,488,558', Turnover: '5,324,793' }] }),
    );
    return { url, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: payload, fromCache304: false };
  }
  async get(url: string, opts?: FetchOptions): Promise<RawResponse> {
    return this.request(url, { ...(opts ?? {}), method: 'GET' });
  }
}

function makeSource(symbols: string[], fetchConcurrency?: number): SourceRecord {
  const endpointConfig: Record<string, unknown> = {
    method: 'POST',
    responseKind: 'json',
    provider: 'msx-summary',
    urlTemplate: 'https://www.msx.om/summary-report.aspx/List',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
    symbols,
  };
  if (fetchConcurrency !== undefined) endpointConfig.fetch_concurrency = fetchConcurrency;
  return {
    id: 1,
    venue: 'MSX',
    dataType: 'ohlcv_backfill',
    entryUrl: 'https://www.msx.om/summary-report.aspx/List',
    endpointConfig: endpointConfig as unknown as SourceRecord['endpointConfig'],
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    lastContentHash: null,
  };
}

function makeCtx(source: SourceRecord, http: HttpClient, onFetched?: (f: FetchResult) => Promise<void>): FetchContext {
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
    now: () => '2026-07-15T00:00:00.000Z',
  };
  if (onFetched) ctx.onFetched = onFetched;
  return ctx;
}

test('msx history fetch: POST body carries Symbol/Type/From/To; sink stages w/ meta; isolates 404; bounds pool', async () => {
  const http = new ListHttpClient(new Set(['DELISTED']));
  const source = makeSource(['BKMB', 'OQGN', 'DELISTED', 'OMINV', 'SMNP'], 2);
  const staged: FetchResult[] = [];
  const returned = await msxHistory.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.deepEqual(returned, [], 'streaming path drains via the sink and returns nothing');
  assert.equal(staged.length, 4, 'DELISTED (404) skipped; the other four staged');
  assert.equal(http.maxInFlight, 2, 'pool ran exactly fetch_concurrency=2 in parallel');
  assert.deepEqual(staged.map((f) => f.externalId).sort(), ['BKMB', 'OMINV', 'OQGN', 'SMNP']);

  // POST body shape (per the endpoint contract): Type=D (Daily), To bounded at today, Symbol=ticker.
  const bkmb = http.posts.find((p) => (JSON.parse(p.body) as { Symbol: string }).Symbol === 'BKMB')!;
  const parsed = JSON.parse(bkmb.body) as { Symbol: string; Type: string; From: string; To: string };
  assert.equal(parsed.Type, 'D');
  assert.equal(parsed.To, '2026-07-15'); // ctx.now() date
  assert.match(parsed.From, /^\d{4}-\d{2}-\d{2}$/);

  for (const f of staged) {
    assert.equal(f.httpStatus, 200);
    assert.equal(f.meta!.venue, 'MSX');
    assert.equal(f.meta!.source, 'msx-summary');
    assert.equal(f.meta!.dataType, 'ohlcv_backfill');
    assert.equal(typeof f.meta!.ticker, 'string');
  }
});

test('msx history fetch: no sink → serial array (back-compat), failures skipped', async () => {
  const http = new ListHttpClient(new Set(['DELISTED']));
  const source = makeSource(['BKMB', 'DELISTED', 'OQGN'], 8);
  const returned = await msxHistory.fetch(makeCtx(source, http));
  assert.equal(returned.length, 2);
  assert.equal(http.maxInFlight, 1, 'no sink ⇒ strictly serial');
  assert.deepEqual(returned.map((f) => f.externalId).sort(), ['BKMB', 'OQGN']);
});

test('msx history fetch: absent fetch_concurrency defaults the pool to 4', async () => {
  const http = new ListHttpClient();
  const source = makeSource(['BKMB', 'OQGN', 'OMINV', 'SMNP', 'OTEL', 'ARENA']);
  const staged: FetchResult[] = [];
  await msxHistory.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));
  assert.equal(staged.length, 6);
  assert.equal(http.maxInFlight, 4);
});

test('msx history fetch: a staged JSON parses end-to-end with the meta-carried venue/ticker', async () => {
  const http = new ListHttpClient();
  const staged: FetchResult[] = [];
  await msxHistory.fetch(makeCtx(makeSource(['BKMB'], 1), http, async (f) => { staged.push(f); }));
  assert.equal(staged.length, 1);
  const { rows } = parseMsxHistory(snapshot(staged[0]!.body, staged[0]!.meta!));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.venue, 'MSX');
  assert.equal(rows[0]!.ticker, 'BKMB');
  assert.equal(rows[0]!.close, 0.392);
  assert.equal(rows[0]!.open, 0.398); // full OHLC now
});

// ── ROUTING (provider-aware resolution) ───────────────────────────────────────────────────────────

test('msx history routing: provider=msx-summary + ohlcv_backfill → msxHistory', () => {
  const tasks = resolveTasksForSource(makeSource(['BKMB']));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], msxHistory);
});

test('msx history routing: provider=msx-summary + quotes → no task (never mis-dispatch)', () => {
  const source = makeSource(['BKMB']);
  source.dataType = 'quotes';
  assert.deepEqual(resolveTasksForSource(source), []);
});

// Golden + fetch + routing tests for the Mubasher ADX ≥2y OHLCV-CSV backfill adapter. Zero network.
// Run: node --import tsx --test (from ingestion/).
//
// The parser's correctness is load-bearing for the 2-source cross-check: the venue+ticker it emits
// (recovered from snapshot.meta, NOT the CSV bytes) must produce the SAME natural_key as any future
// ADX EOD-bulletin bar (OHLCV.CLOSE:ADX:FAB:{tradeDate}, CONTRACT §6.5), so these assert the
// meta-carried venue/ticker explicitly. The 2-step fetch (page → hash → CSV) and the Historical_-dir
// hash anchoring (vs the intraday decoy) are the transport-side correctness deliverables.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mubasherOhlcvCsv,
  parseMubasherOhlcvCsv,
  MUBASHER_OHLCV_CSV_PARSER_VERSION,
} from '../ohlcv-csv.js';
import { resolveTasksForSource } from '../../../runtime.js';
import type {
  FetchContext,
  FetchOptions,
  FetchResult,
  HttpClient,
  RawResponse,
  SourceRecord,
  StoredSnapshot,
} from '../../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixDir = resolve(here, '../../../../fixtures/mubasher');

const FAB_CSV = readFileSync(resolve(fixDir, 'adx-fab-ohlcv.csv'));
const FAB_PAGE = readFileSync(resolve(fixDir, 'adx-fab-stock-page.html'));

/** The default hash pattern the adapter ships — the tests assert it anchors on the Historical_ dir. */
const HASH_PATTERN = 'Historical_Stock_Charts_Dir/([a-f0-9]+)\\.csv';

function snapshot(body: Buffer, meta: Record<string, unknown>): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'ADX',
    dataType: 'ohlcv_backfill',
    contentType: 'application/octet-stream',
    externalId: null,
    body,
    fetchedAt: '2026-07-14T13:00:00.000Z',
    meta,
  };
}

// ── PARSE golden (against the real captured FAB CSV) ──────────────────────────────────────────────

test('mubasher ohlcv-csv: FAB CSV → ~5906 bars, ADX/FAB, close is a number', () => {
  const { rows, parserVersion } = parseMubasherOhlcvCsv(snapshot(FAB_CSV, { venue: 'ADX', ticker: 'FAB' }));
  assert.equal(parserVersion, MUBASHER_OHLCV_CSV_PARSER_VERSION);
  assert.equal(parserVersion, mubasherOhlcvCsv.parserVersion);
  assert.ok(rows.length >= 5900, `expected ~5906 daily bars, got ${rows.length}`);
  assert.ok(rows.length <= 5910, `expected ~5906 daily bars, got ${rows.length}`);

  for (const r of rows) {
    assert.equal(r.venue, 'ADX');
    assert.equal(r.ticker, 'FAB');
    assert.equal(typeof r.close, 'number'); // NOT NULL guaranteed
    assert.match(r.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  }

  const first = rows[0]!;
  assert.equal(first.tradeDate, '2000-12-12');
  assert.equal(first.open, 9.07);
  assert.equal(first.high, 9.07);
  assert.equal(first.low, 9.07);
  assert.equal(first.close, 9.07);
  assert.equal(first.volume, 110649);

  const last = rows[rows.length - 1]!;
  assert.equal(last.tradeDate, '2026-07-14');
  assert.equal(last.open, 18.0);
  assert.equal(last.high, 18.16);
  assert.equal(last.low, 17.84);
  assert.equal(last.close, 17.86);
  assert.equal(last.volume, 3638463);
});

test('mubasher ohlcv-csv: emits every source line verbatim in file order (no reorder, no dedup)', () => {
  // GROUND-TRUTH: the real Mubasher FAB series is NOT globally sorted — it carries same-day DOUBLE
  // prints (2006-03-20 twice) AND an out-of-order appended segment (…2016-07-31 then back to
  // 2007-09-04…). The PURE parser must be a FAITHFUL 1:1 projection of the CSV: it preserves file
  // order and does NOT reorder or dedup (that is a downstream lake/cross-check concern, keyed by
  // OHLCV.CLOSE:ADX:FAB:{tradeDate}). This asserts row N maps to source data line N exactly.
  const { rows } = parseMubasherOhlcvCsv(snapshot(FAB_CSV, { venue: 'ADX', ticker: 'FAB' }));
  const dataLines = FAB_CSV.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  assert.equal(rows.length, dataLines.length, 'one row per non-blank CSV line (none dropped, none added)');
  for (let i = 0; i < rows.length; i++) {
    const expectedDate = dataLines[i]!.split(',')[0]!.split('/')[0];
    assert.equal(rows[i]!.tradeDate, expectedDate, `row ${i} tradeDate must equal source line ${i}`);
  }
});

// ── PARSE edge cases ──────────────────────────────────────────────────────────────────────────────

test('mubasher ohlcv-csv: missing meta.ticker → zero rows (no mis-attribution)', () => {
  const { rows } = parseMubasherOhlcvCsv(snapshot(FAB_CSV, { venue: 'ADX' }));
  assert.equal(rows.length, 0);
});

test('mubasher ohlcv-csv: unknown venue → zero rows', () => {
  const { rows } = parseMubasherOhlcvCsv(snapshot(FAB_CSV, { venue: 'NASDAQ', ticker: 'FAB' }));
  assert.equal(rows.length, 0);
});

test('mubasher ohlcv-csv: non-CSV garbage body → zero rows, no throw', () => {
  const body = Buffer.from('<html><body>404 Not Found</body></html>');
  const { rows } = parseMubasherOhlcvCsv(snapshot(body, { venue: 'ADX', ticker: 'FAB' }));
  assert.equal(rows.length, 0);
});

test('mubasher ohlcv-csv: a line with an empty close field is skipped (close NOT NULL)', () => {
  // Three lines: a good bar, a bar with an empty close, and another good bar.
  const body = Buffer.from(
    '2026-07-01/00:00:00,10.0,10.5,9.9,10.2,1000\n' +
      '2026-07-02/00:00:00,10.2,10.4,10.0,,2000\n' +
      '2026-07-03/00:00:00,10.1,10.3,10.0,10.15,3000\n',
  );
  const { rows } = parseMubasherOhlcvCsv(snapshot(body, { venue: 'ADX', ticker: 'FAB' }));
  assert.equal(rows.length, 2, 'the empty-close bar is dropped');
  assert.deepEqual(
    rows.map((r) => r.tradeDate),
    ['2026-07-01', '2026-07-03'],
  );
});

test('mubasher ohlcv-csv: a stray header/garbage line is skipped, genuine 0 close is kept', () => {
  const body = Buffer.from(
    'DATE,OPEN,HIGH,LOW,CLOSE,VOLUME\n' + // stray header — date field is not YYYY-MM-DD → skipped
      '2026-07-01/00:00:00,0,0,0,0,0\n', // genuine all-zero bar — close 0 is a real value, kept
  );
  const { rows } = parseMubasherOhlcvCsv(snapshot(body, { venue: 'ADX', ticker: 'FAB' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.close, 0);
  assert.equal(rows[0]!.volume, 0);
  assert.equal(rows[0]!.tradeDate, '2026-07-01');
});

// ── HASH extraction (anchored on the Historical_ dir, not the intraday decoy) ─────────────────────

test('mubasher ohlcv-csv: hash regex extracts the FAB historical hash from the stock page', () => {
  const match = new RegExp(HASH_PATTERN).exec(FAB_PAGE.toString('utf8'));
  assert.ok(match, 'the historical-data-url hash must be found');
  assert.equal(match![1], '2071fb2e203234df6dee15934e448ee88971');
  // The matched substring must have come from the HISTORICAL dir, never the intraday decoy — even
  // though both carry the same hash on this page, the anchor guarantees the ≥2y file is selected.
  assert.ok(match![0].startsWith('Historical_Stock_Charts_Dir/'));
  assert.ok(!match![0].includes('Intraday'));
});

// ── FETCH: 2-step mock (page → hash → CSV), streaming sink, isolation, bounded pool, array path ───

const browserBoom = () => {
  throw new Error('mubasher ohlcv-csv backfill is plain http — must not touch ctx.browser');
};

/**
 * Two-step HttpClient double. A stock-page GET (URL contains '/stocks/') returns an HTML page whose
 * historical-data-url embeds a per-ticker hash (unless the ticker is in `notFound` → 404 no hash).
 * A CSV GET (URL contains '.csv') returns CSV bytes. Records URLs and tracks max in-flight to prove
 * the lane cap AND actual parallelism; yields a macrotask so lanes interleave.
 */
class TwoStepHttpClient implements HttpClient {
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

    if (url.includes('/stocks/')) {
      const ticker = url.substring(url.lastIndexOf('/') + 1);
      if (this.notFound.has(ticker)) {
        return { url, status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('not found'), fromCache304: false };
      }
      // A valid lowercase-hex hash (the adapter's hashPattern is [a-f0-9]+): derive one
      // deterministically per ticker so the CSV URL is distinct but always hex.
      const hash = Array.from(ticker)
        .map((c) => (c.charCodeAt(0) % 16).toString(16))
        .join('');
      const html =
        `<mubasher-stock-chart ` +
        `intraday-data-url="https://static.mubasher.info/File.MubasherCharts/File.Delay_Stock_Intraday_Charts_Dir/${hash}.csv" ` +
        `historical-data-url="https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/${hash}.csv">` +
        `</mubasher-stock-chart>`;
      return { url, status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html), fromCache304: false };
    }
    // CSV step.
    return {
      url,
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('2026-07-14/00:00:00,18.0,18.16,17.84,17.86,3638463\n'),
      fromCache304: false,
    };
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    return this.get(url, opts);
  }
}

function makeCsvSource(symbols: string[], fetchConcurrency?: number): SourceRecord {
  const endpointConfig: Record<string, unknown> = {
    responseKind: 'csv',
    provider: 'mubasher_csv',
    pageUrlTemplate: 'https://english.mubasher.info/markets/ADX/stocks/{symbol}',
    csvUrlTemplate: 'https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/{hash}.csv',
    hashPattern: HASH_PATTERN,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    symbols,
  };
  if (fetchConcurrency !== undefined) endpointConfig.fetch_concurrency = fetchConcurrency;
  return {
    id: 1,
    venue: 'ADX',
    dataType: 'ohlcv_backfill',
    entryUrl: 'https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/',
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

test('mubasher ohlcv-csv fetch: streaming sink stages each ticker w/ meta, isolates 404, bounds concurrency', async () => {
  const http = new TwoStepHttpClient(new Set(['DELISTED']));
  const source = makeCsvSource(['FAB', 'ADCB', 'DELISTED', 'ALDAR', 'IHC'], 2);
  const staged: FetchResult[] = [];
  const returned = await mubasherOhlcvCsv.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.deepEqual(returned, [], 'streaming path drains via the sink and returns nothing');
  assert.equal(staged.length, 4, 'DELISTED (page 404 → no hash) skipped; the other four staged');
  assert.equal(http.maxInFlight, 2, 'pool ran exactly fetch_concurrency=2 in parallel (bounded AND concurrent)');
  assert.deepEqual(staged.map((f) => f.externalId).sort(), ['ADCB', 'ALDAR', 'FAB', 'IHC']);
  for (const f of staged) {
    assert.equal(f.httpStatus, 200);
    assert.equal(f.meta!.venue, 'ADX');
    assert.equal(f.meta!.source, 'mubasher_csv');
    assert.equal(f.meta!.dataType, 'ohlcv_backfill');
    assert.equal(typeof f.meta!.ticker, 'string');
    // Each staged CSV must have gone through the CSV endpoint, not the page.
    assert.ok(f.url.includes('.csv'));
  }
});

test('mubasher ohlcv-csv fetch: no sink → serial array (back-compat), failures skipped', async () => {
  const http = new TwoStepHttpClient(new Set(['DELISTED']));
  const source = makeCsvSource(['FAB', 'DELISTED', 'ADCB'], 8);
  const returned = await mubasherOhlcvCsv.fetch(makeCtx(source, http)); // no onFetched

  assert.equal(returned.length, 2, 'array path returns the survivors');
  assert.equal(http.maxInFlight, 1, 'no sink ⇒ strictly serial, never overlaps');
  assert.deepEqual(returned.map((f) => f.externalId).sort(), ['ADCB', 'FAB']);
});

test('mubasher ohlcv-csv fetch: absent fetch_concurrency defaults the pool to 4', async () => {
  const http = new TwoStepHttpClient();
  const source = makeCsvSource(['FAB', 'ADCB', 'ALDAR', 'IHC', '2POINTZERO', 'ADNOCGAS']); // no fetch_concurrency
  const staged: FetchResult[] = [];
  await mubasherOhlcvCsv.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));

  assert.equal(staged.length, 6);
  assert.equal(http.maxInFlight, 4, 'default 4 caps the pool even with 6 tickers');
});

test('mubasher ohlcv-csv fetch: a staged CSV parses end-to-end with the meta-carried venue/ticker', async () => {
  const http = new TwoStepHttpClient();
  const source = makeCsvSource(['FAB'], 1);
  const staged: FetchResult[] = [];
  await mubasherOhlcvCsv.fetch(makeCtx(source, http, async (f) => { staged.push(f); }));
  assert.equal(staged.length, 1);
  const f = staged[0]!;
  // Feed the FetchResult back through the pure parser exactly as the snapshot store would.
  const { rows } = parseMubasherOhlcvCsv(snapshot(f.body, f.meta!));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.venue, 'ADX');
  assert.equal(rows[0]!.ticker, 'FAB');
  assert.equal(rows[0]!.close, 17.86);
});

// ── ROUTING (provider-aware resolution) ───────────────────────────────────────────────────────────

test('mubasher ohlcv-csv routing: provider=mubasher_csv + ohlcv_backfill → mubasherOhlcvCsv', () => {
  const source = makeCsvSource(['FAB']);
  const tasks = resolveTasksForSource(source);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0], mubasherOhlcvCsv);
});

test('mubasher ohlcv-csv routing: provider=mubasher_csv + quotes → no task (never mis-dispatch)', () => {
  const source = makeCsvSource(['FAB']);
  source.dataType = 'quotes';
  assert.deepEqual(resolveTasksForSource(source), []);
});

// BHB parser tests. NO real fixture (BHB board is SPA-over-JSON; XLSX not captured in sandbox).
// Quotes tested against an inline webapi-shape sample; EOD tested against inline sheet rows. Both
// MUST be re-pointed at real goldens once the VPS captures them. Zero network.
// Run with: node --test (or tsx --test) from ingestion/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bhbQuotes } from './quotes.js';
import { mapBulletinRows, type SheetRow } from './eod.js';
import type { StoredSnapshot } from '../../core/types.js';

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'BHB',
    dataType: 'quotes',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T10:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('BHB quotes: parses the real webapi GetTabularData?storedProcdure=Quotes board', () => {
  // REAL shape captured live 2026-07-15 (sticky proxy): space-padded `symbol`,
  // `Last Price`/`OPENING`/`VOLUME` (spaced/upper keys), Change absolute, no prevClose.
  const board = {
    status: 1,
    data: [
      { symbol: 'ABC                 ', currency: 'USD                 ', Bid: 0.3, 'Bid Vol': 25396.0, Ask: 0.302, 'Ask Vol': 30000.0, 'Last Price': 0.3, Change: -0.001, OPENING: 0.305, High: 0.31, Low: 0.3, VOLUME: 84604.0, SYS_TREND: '-' },
      // legacy/alt shape carrying PreviousClose to keep exercising change derivation
      { Symbol: 'GFH', LastPrice: 0.52, PreviousClose: 0.53, Volume: 340000 },
    ],
  };
  const { rows, parserVersion } = bhbQuotes.parse(snap(Buffer.from(JSON.stringify(board), 'utf8')));
  assert.equal(parserVersion, bhbQuotes.parserVersion);
  assert.equal(rows.length, 2);

  const abc = rows.find((r) => r.ticker === 'ABC')!; // space-padded symbol must be trimmed
  assert.equal(abc.venue, 'BHB');
  assert.equal(abc.last, 0.3); // 'Last Price'
  assert.equal(abc.open, 0.305); // 'OPENING'
  assert.equal(abc.high, 0.31);
  assert.equal(abc.low, 0.3);
  assert.equal(abc.volume, 84604); // 'VOLUME'
  assert.equal(abc.change, -0.001);
  assert.equal(abc.bid, 0.3);
  assert.equal(abc.ask, 0.302);
  assert.equal(abc.changePct, null); // no prevClose / pct on the real board
  assert.equal(abc.asOf, '2026-07-13T10:00:00.000Z');

  const gfh = rows.find((r) => r.ticker === 'GFH')!;
  assert.equal(gfh.change, -0.01); // 0.52 - 0.53 derived
  assert.equal(gfh.changePct, -1.8868); // -0.01/0.53*100
});

test('BHB quotes: non-JSON body yields zero rows (PARSE_DRIFT), not a throw', () => {
  const { rows } = bhbQuotes.parse(snap(Buffer.from('<html>spa shell</html>', 'utf8')));
  assert.equal(rows.length, 0);
});

test('BHB EOD: mapBulletinRows maps Daily-Trading-Summary rows to NormalizedOhlcv', () => {
  // Inline header-keyed rows as decodeWorkbook() would emit from the XLSX.
  const sheetRows: SheetRow[] = [
    { Symbol: 'AUB', Open: '0.965', High: '0.990', Low: '0.960', Close: '0.980', Volume: '1,200,000', Value: '1,176,000' },
    { Symbol: 'GFH', Open: 0.32, High: 0.33, Low: 0.315, Close: 0.325, Volume: 5000000, Value: 1625000 },
    { Symbol: 'NOTRADE', Close: '' }, // non-traded row: no close -> skipped (close is NOT NULL)
  ];
  const out = mapBulletinRows(sheetRows, '2026-07-13');
  assert.equal(out.length, 2);

  const aub = out.find((r) => r.ticker === 'AUB')!;
  assert.equal(aub.venue, 'BHB');
  assert.equal(aub.tradeDate, '2026-07-13');
  assert.equal(aub.close, 0.98);
  assert.equal(aub.open, 0.965);
  assert.equal(aub.high, 0.99);
  assert.equal(aub.low, 0.96);
  assert.equal(aub.volume, 1200000); // comma-stripped
  assert.equal(aub.valueTraded, 1176000);

  const gfh = out.find((r) => r.ticker === 'GFH')!;
  assert.equal(gfh.close, 0.325);
  assert.equal(gfh.volume, 5000000);
});

// ── FETCH: dynamic APIKey (scrape homepage → webapi Bearer; re-scrape on rotation) ────────────────
import { bhbQuotes as bhbQuotesFetch, __resetBhbApiKeyCache } from './quotes.js';
import type {
  FetchContext,
  FetchOptions,
  FetchResult,
  HttpClient,
  RawResponse,
  SourceRecord,
} from '../../core/types.js';

const TOKEN_PAGE = 'https://www.bahrainbourse.com/en';
const WEBAPI = 'https://webapi.bahrainbourse.com/api/data/GetTabularData?storedProcdure=Quotes';
const BOARD = JSON.stringify({ status: 1, data: [{ symbol: 'ABC', 'Last Price': 0.3, VOLUME: 100 }] });

/** Mock BHB origin: homepage serves `APIKey = '<currentKey>'`; the webapi 200s only when the request's
 *  Bearer matches currentKey, else 401. `currentKey` can be rotated to exercise the re-scrape path. */
class BhbHttp implements HttpClient {
  public gets: string[] = [];
  constructor(public currentKey: string) {}
  async get(url: string, opts?: FetchOptions): Promise<RawResponse> {
    this.gets.push(url);
    if (url === TOKEN_PAGE) {
      const html = `<script>var APIKey = '${this.currentKey}';</script>`;
      return { url, status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html), fromCache304: false };
    }
    const auth = (opts?.headers?.['authorization'] ?? '') as string;
    const ok = auth === `Bearer ${this.currentKey}`;
    return {
      url, status: ok ? 200 : 401,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(ok ? BOARD : ''), fromCache304: false,
    };
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> { return this.get(url, opts); }
}

function ctxFor(http: HttpClient): FetchContext {
  const source = {
    id: 16, venue: 'BHB', dataType: 'quotes', entryUrl: WEBAPI,
    endpointConfig: { urlTemplate: WEBAPI, headers: { Accept: 'application/json' } } as unknown as SourceRecord['endpointConfig'],
    normalizeRules: [], transport: 'http', robotsStatus: 'allowed', active: true, lastContentHash: null,
  } as SourceRecord;
  return {
    source, http,
    browser: { bootstrap() { throw new Error('no browser'); }, refreshIfChallenged() {}, get() { throw new Error('no browser'); }, request() { throw new Error('no browser'); }, close: async () => {} } as unknown as FetchContext['browser'],
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    now: () => '2026-07-15T10:00:00.000Z',
  };
}

test('BHB fetch: scrapes the homepage APIKey then GETs the webapi with a Bearer', async () => {
  __resetBhbApiKeyCache();
  const http = new BhbHttp('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
  const [fr] = await bhbQuotesFetch.fetch(ctxFor(http));
  assert.equal(fr!.httpStatus, 200);
  assert.equal(bhbQuotesFetch.parse({ ...snap(fr!.body), meta: {} }).rows.length, 1);
  assert.deepEqual(http.gets, [TOKEN_PAGE, WEBAPI], 'homepage scrape precedes the webapi GET');
});

test('BHB fetch: a rotated token (webapi 401) triggers ONE re-scrape + retry', async () => {
  __resetBhbApiKeyCache();
  const http = new BhbHttp('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  // first poll caches v1
  await bhbQuotesFetch.fetch(ctxFor(http));
  // token rotates at the origin; the cached v1 now 401s → adapter must re-scrape v2 + retry
  http.currentKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
  http.gets = [];
  const [fr] = await bhbQuotesFetch.fetch(ctxFor(http));
  assert.equal(fr!.httpStatus, 200, 'recovered after re-scraping the rotated key');
  // sequence: webapi(401 w/ stale cached key) → homepage(rescrape) → webapi(200)
  assert.deepEqual(http.gets, [WEBAPI, TOKEN_PAGE, WEBAPI]);
});

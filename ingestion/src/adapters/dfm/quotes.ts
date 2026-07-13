// DFM (Dubai Financial Market) — quotes TaskSpec.
//
// TRANSPORT REALITY (from captured fixtures, documented for the VPS):
//   * marketwatch.dfm.ae/en is a pure SPA SHELL — the captured HTML contains NO quote rows; the
//     board is loaded from a JSON API on api2.dfm.ae (/mw/v1 market-watch). The exact route is
//     portal-generated and MUST be pinned on the VPS (ingest.sources.endpoint_config already flags
//     network_capture on ^https://api2\.dfm\.ae/mw/v1/). DFM sits behind Imperva/Incapsula, so its
//     source is seeded transport = 'http_bootstrap' (Playwright request-context) even though the
//     payload is plain JSON once cookies are seated.
//   * Because no real JSON fixture could be captured in the build sandbox (WAF + SPA), there is NO
//     golden fixture file for DFM quotes yet. The parser below is written to the standard DFM
//     market-watch JSON shape and is unit-tested against an INLINE shape-sample (see quotes.test.ts,
//     mirroring the TDWL shape-sample convention). FIRST VPS RUN MUST capture a real /mw/v1 response
//     into ingestion/fixtures/dfm/ and promote it to the golden, adjusting field names if they
//     differ. Treat DFM quotes as provisional until then.
//
// The parser is defensive about field naming: DFM's mw payload has used several casings across
// redesigns, so we resolve each logical field from a small set of accepted keys.

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const DFM_QUOTES_PARSER_VERSION = 1;

type Json = Record<string, unknown>;

function pick(row: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== null && row[k] !== '') {
      return row[k];
    }
  }
  return undefined;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.replace(/,/g, '').trim();
    if (t === '' || t === '-') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

/**
 * Locate the array of quote rows in the DFM board payload. Accepted top-level shapes:
 *   [ {...}, ... ]                          (bare array)
 *   { data: [ ... ] } | { Data: [ ... ] }
 *   { result: [ ... ] } | { Result: [ ... ] }
 *   { items: [ ... ] } | { rows: [ ... ] }  | { securities: [ ... ] }
 */
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    for (const key of ['data', 'Data', 'result', 'Result', 'items', 'Items', 'rows', 'Rows', 'securities', 'Securities']) {
      const v = (payload as Json)[key];
      if (Array.isArray(v)) return v.filter(isObj);
      // one level of nesting: { data: { securities: [...] } }
      if (isObj(v)) {
        for (const k2 of ['securities', 'Securities', 'items', 'Items', 'rows', 'Rows', 'list', 'List']) {
          const v2 = (v as Json)[k2];
          if (Array.isArray(v2)) return v2.filter(isObj);
        }
      }
    }
  }
  return [];
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function fetchQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  // DFM is WAF-fronted: use the browser request-context when the source is http_bootstrap/headless,
  // else plain http. The scheduler picks the client per transport; we honor whichever is wired in.
  const client = ctx.source.transport === 'http' ? ctx.http : ctx.browser;
  const res = await client.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'DFM', dataType: 'quotes', lang: 'en' },
    },
  ];
}

/** PURE parser. DFM board JSON -> NormalizedQuote[]. asOf = snapshot fetch time (delayed print). */
function parseQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.body.toString('utf8'));
  } catch {
    return { rows: [], parserVersion: DFM_QUOTES_PARSER_VERSION };
  }

  const asOf = snapshot.fetchedAt;
  const rows: NormalizedQuote[] = [];

  for (const r of locateRows(payload)) {
    const ticker = str(pick(r, ['Symbol', 'symbol', 'CompanySymbol', 'Code', 'code', 'Ticker', 'ticker']));
    if (ticker === '') continue;

    const last = num(pick(r, ['Price', 'price', 'LastPrice', 'lastPrice', 'ClosePrice', 'Close', 'LTP', 'last']));
    const prevClose = num(pick(r, ['PreviousClose', 'PrevClose', 'previousClose', 'prevClose', 'PrevClosePrice']));
    let change = num(pick(r, ['Change', 'change', 'PriceChange', 'NetChange']));
    let changePct = num(pick(r, ['PercentChange', 'percentChange', 'ChangePercent', 'changePercent', 'PercChange', 'PctChange']));
    if (change === null && last !== null && prevClose !== null) {
      change = Number((last - prevClose).toFixed(6));
    }
    if (changePct === null && change !== null && prevClose !== null && prevClose !== 0) {
      changePct = Number(((change / prevClose) * 100).toFixed(4));
    }

    rows.push({
      venue: 'DFM',
      ticker,
      last,
      change,
      changePct,
      open: num(pick(r, ['Open', 'open', 'OpenPrice', 'openPrice'])),
      high: num(pick(r, ['High', 'high', 'DayHigh', 'HighPrice'])),
      low: num(pick(r, ['Low', 'low', 'DayLow', 'LowPrice'])),
      volume: num(pick(r, ['Volume', 'volume', 'TradedVolume', 'Quantity', 'Shares'])),
      week52High: num(pick(r, ['Week52High', 'High52', 'YearHigh', 'FiftyTwoWeekHigh'])),
      week52Low: num(pick(r, ['Week52Low', 'Low52', 'YearLow', 'FiftyTwoWeekLow'])),
      bid: num(pick(r, ['BidPrice', 'Bid', 'bid'])),
      ask: num(pick(r, ['AskPrice', 'Ask', 'ask', 'OfferPrice', 'Offer'])),
      asOf,
    });
  }

  return { rows, parserVersion: DFM_QUOTES_PARSER_VERSION };
}

export const dfmQuotes: TaskSpec<NormalizedQuote> = {
  dataType: 'quotes',
  parserVersion: DFM_QUOTES_PARSER_VERSION,
  fetch: fetchQuotes,
  parse: parseQuotes,
};

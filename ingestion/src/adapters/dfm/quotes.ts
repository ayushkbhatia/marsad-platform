// DFM (Dubai Financial Market) — quotes TaskSpec.
//
// TRANSPORT REALITY (captured live from the VPS 2026-07-15):
//   * marketwatch.dfm.ae/en is a pure SPA SHELL. The live board is a POST to
//     https://marketwatch.dfm.ae/dapi/fetch with a command envelope body
//     [{"id":"<uuid>","command":"stocks","data":[{"id":"lastrefreshtime","value":"0"},{"id":"id","value":""}]}]
//     returning [{ id, command, data:[ ~473 securities ] }] — plain JSON, NO WAF challenge from the
//     VPS IP (confirmed via plain curl), so the source runs transport='http' with method POST + body
//     pinned in endpoint_config. The legacy api2.dfm.ae/mw/v1 network_capture route is DEAD (0 hits);
//     this replaces it (migration repoints ingest.sources id=4).
//   * Security field names are lowercase DFM board keys: id (ticker), lastradeprice, openingprice,
//     highestprice, lowestprice, previousclosingprice, netchange, changepercentage, totalvolume,
//     bidprice, offerprice, highestin52weeks, lowestin52weeks. locateRows() unwraps the [{data:[…]}]
//     group envelope; the field pickers accept these keys alongside the legacy casings.
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
  if (Array.isArray(payload)) {
    const objs = payload.filter(isObj);
    // Live board shape: [{ id, command:'stocks', data:[ ...securities... ] }] — the
    // bare array holds GROUP wrappers, not securities. When its elements carry a
    // `data`/`Data` array, flatten those; otherwise the array IS the security list.
    const groups = objs.filter((o) => Array.isArray(o.data) || Array.isArray(o.Data));
    if (groups.length > 0) {
      return groups.flatMap((g) => {
        const d = (g.data ?? g.Data) as unknown;
        return Array.isArray(d) ? d.filter(isObj) : [];
      });
    }
    return objs;
  }
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
  // The live board (marketwatch.dfm.ae/dapi/fetch) is a POST that takes a command
  // envelope body (cfg.body); the legacy api2.dfm.ae route was a GET. Honor the
  // configured method so one adapter serves both.
  const opts = {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
  };
  const res =
    (cfg.method ?? 'GET') === 'POST'
      ? await client.request(url, { method: 'POST', body: cfg.body ?? '', ...opts })
      : await client.get(url, opts);
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
    // 'id' is the DFM board's ticker key (e.g. "EMAARDEV", "DU"); kept LAST so a
    // real Symbol/Code field wins first for any legacy shape.
    const ticker = str(pick(r, ['Symbol', 'symbol', 'CompanySymbol', 'Code', 'code', 'Ticker', 'ticker', 'id']));
    if (ticker === '') continue;

    const last = num(pick(r, ['Price', 'price', 'LastPrice', 'lastPrice', 'ClosePrice', 'Close', 'LTP', 'last', 'lastradeprice', 'lastsessionprice']));
    const prevClose = num(pick(r, ['PreviousClose', 'PrevClose', 'previousClose', 'prevClose', 'PrevClosePrice', 'previousclosingprice']));
    let change = num(pick(r, ['Change', 'change', 'PriceChange', 'NetChange', 'netchange']));
    let changePct = num(pick(r, ['PercentChange', 'percentChange', 'ChangePercent', 'changePercent', 'PercChange', 'PctChange', 'changepercentage']));
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
      open: num(pick(r, ['Open', 'open', 'OpenPrice', 'openPrice', 'openingprice'])),
      high: num(pick(r, ['High', 'high', 'DayHigh', 'HighPrice', 'highestprice'])),
      low: num(pick(r, ['Low', 'low', 'DayLow', 'LowPrice', 'lowestprice'])),
      volume: num(pick(r, ['Volume', 'volume', 'TradedVolume', 'Quantity', 'Shares', 'totalvolume'])),
      week52High: num(pick(r, ['Week52High', 'High52', 'YearHigh', 'FiftyTwoWeekHigh', 'highestin52weeks'])),
      week52Low: num(pick(r, ['Week52Low', 'Low52', 'YearLow', 'FiftyTwoWeekLow', 'lowestin52weeks'])),
      bid: num(pick(r, ['BidPrice', 'Bid', 'bid', 'bidprice'])),
      ask: num(pick(r, ['AskPrice', 'Ask', 'ask', 'OfferPrice', 'Offer', 'offerprice'])),
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

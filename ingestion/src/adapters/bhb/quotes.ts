// BHB (Bahrain Bourse) — quotes TaskSpec.
//
// TRANSPORT REALITY (from captured fixtures, documented for the VPS):
//   * bahrainbourse.com/en is a pure SPA SHELL — the captured 195 KB HTML carries NO quote rows;
//     the market watch board is loaded from a JSON API on webapi.bahrainbourse.com/api (host
//     confirmed live in the SPA bundle). The exact route is portal-generated and MUST be pinned on
//     the VPS (ingest.sources.endpoint_config actionDiscovery: ^https://webapi\.bahrainbourse\.com
//     /api/). BHB has NO WAF, so transport is plain 'http' with a capture-once discovery step.
//   * No real JSON fixture could be captured in the sandbox (SPA shell only), so there is NO golden
//     for BHB quotes yet. The parser is written to the standard webapi board shape and unit-tested
//     against an INLINE shape-sample. FIRST VPS RUN MUST capture a real /api market-watch response
//     into ingestion/fixtures/bhb/ and promote it to the golden. BHB's fully reliable data path is
//     the EOD Daily-Trading-Summary XLSX (see eod.ts) — the GCC's easiest EOD source.

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const BHB_QUOTES_PARSER_VERSION = 1;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pick(row: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== null && row[k] !== '') return row[k];
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
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    for (const key of ['data', 'Data', 'result', 'Result', 'items', 'Items', 'rows', 'Rows', 'securities', 'Securities', 'list', 'List', 'Table']) {
      const v = payload[key];
      if (Array.isArray(v)) return v.filter(isObj);
      if (isObj(v)) {
        for (const k2 of ['securities', 'Securities', 'items', 'Items', 'rows', 'Rows', 'list', 'List', 'Table']) {
          const v2 = (v as Json)[k2];
          if (Array.isArray(v2)) return v2.filter(isObj);
        }
      }
    }
  }
  return [];
}

async function fetchQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const res = await ctx.http.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'BHB', dataType: 'quotes', lang: 'en' },
    },
  ];
}

/** PURE parser. BHB webapi board JSON -> NormalizedQuote[]. */
function parseQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.body.toString('utf8'));
  } catch {
    return { rows: [], parserVersion: BHB_QUOTES_PARSER_VERSION };
  }

  const asOf = snapshot.fetchedAt;
  const rows: NormalizedQuote[] = [];

  for (const r of locateRows(payload)) {
    const ticker = str(pick(r, ['Symbol', 'symbol', 'Code', 'code', 'Ticker', 'ticker', 'ISIN']));
    if (ticker === '') continue;

    const last = num(pick(r, ['LastPrice', 'lastPrice', 'Price', 'price', 'ClosePrice', 'Close', 'LTP', 'last']));
    const prevClose = num(pick(r, ['PreviousClose', 'PrevClose', 'previousClose', 'prevClose']));
    let change = num(pick(r, ['Change', 'change', 'NetChange', 'PriceChange']));
    let changePct = num(pick(r, ['PercentChange', 'percentChange', 'ChangePercent', 'changePercent', 'PctChange']));
    if (change === null && last !== null && prevClose !== null) {
      change = Number((last - prevClose).toFixed(6));
    }
    if (changePct === null && change !== null && prevClose !== null && prevClose !== 0) {
      changePct = Number(((change / prevClose) * 100).toFixed(4));
    }

    rows.push({
      venue: 'BHB',
      ticker,
      last,
      change,
      changePct,
      open: num(pick(r, ['Open', 'open', 'OpenPrice'])),
      high: num(pick(r, ['High', 'high', 'DayHigh', 'HighPrice'])),
      low: num(pick(r, ['Low', 'low', 'DayLow', 'LowPrice'])),
      volume: num(pick(r, ['Volume', 'volume', 'TradedVolume', 'Quantity'])),
      week52High: num(pick(r, ['Week52High', 'High52', 'YearHigh'])),
      week52Low: num(pick(r, ['Week52Low', 'Low52', 'YearLow'])),
      bid: num(pick(r, ['BidPrice', 'Bid', 'bid'])),
      ask: num(pick(r, ['AskPrice', 'Ask', 'ask', 'OfferPrice', 'Offer'])),
      asOf,
    });
  }

  return { rows, parserVersion: BHB_QUOTES_PARSER_VERSION };
}

export const bhbQuotes: TaskSpec<NormalizedQuote> = {
  dataType: 'quotes',
  parserVersion: BHB_QUOTES_PARSER_VERSION,
  fetch: fetchQuotes,
  parse: parseQuotes,
};

// BHB (Bahrain Bourse) — quotes TaskSpec.
//
// TRANSPORT REALITY (proven live 2026-07-15 via sticky proxy — see scratchpad BHB-API-CONTRACT):
//   * bahrainbourse.com/en is a pure SPA SHELL; the whole market board comes from ONE JSON call:
//       GET https://webapi.bahrainbourse.com/api/data/GetTabularData?storedProcdure=Quotes
//     Auth header `Authorization: Bearer <APIKey>` (a PUBLIC client token shipped in the page JS,
//     not a server secret) that ROTATES several times/day — so the adapter scrapes it fresh from the
//     homepage and re-scrapes on a 401 (see the DYNAMIC APIKey block below), never a pinned config token.
//   * DIRECT from the VPS — both the homepage scrape and the webapi return 200 with the plain VPS IP
//     (verified 2026-07-15: the historical Cloudflare/geo block is gone). use_proxy=false, no proxy.
//     transport='http' (plain GET, no bootstrap/discovery needed).
//   * Real board shape (41 rows): space-padded `symbol`, `Last Price`, `OPENING`, `High`, `Low`,
//     `VOLUME`, `Change`, `Bid`/`Ask` (no PreviousClose/pct). Gives live last (10-min cron) + daily
//     OHLCV. The parser handles these exact keys; unit-tested against the real shape in quotes.test.
//     EOD close history is a separate per-security feed (see ohlcv.ts / DataExportCompanyProfile).

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';
import { FetchError } from '../../core/types.js';

export const BHB_QUOTES_PARSER_VERSION = 1;

// ── DYNAMIC APIKey (the BHB webapi Bearer token) ──────────────────────────────────────────────────
// The `Authorization: Bearer <APIKey>` token is a PUBLIC client token embedded verbatim in the BHB
// homepage JS (`APIKey = '<64hex>'`) that ROTATES (observed several times/day). Hardcoding it in
// endpoint_config is a time-bomb — BHB 401s the moment it rotates. So we scrape it fresh, cache it
// in-process across polls, and re-scrape ONCE on an auth failure (401/403, or the CF 400). No secret:
// it is the same token any browser visitor is handed. Both the homepage scrape and the webapi work
// DIRECT from the VPS (verified 2026-07-15) — no proxy.
let cachedApiKey: string | null = null;

/** Test-only: reset the in-process APIKey cache so fetch tests are order-independent. */
export function __resetBhbApiKeyCache(): void {
  cachedApiKey = null;
}

const BHB_TOKEN_PAGE = 'https://www.bahrainbourse.com/en';
const API_KEY_RE = /APIKey['"]?\s*[:=]\s*['"]([a-fA-F0-9]{32,})['"]/;
const BHB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface BhbQuotesConfig {
  urlTemplate?: string;
  tokenPageUrl?: string;
  headers?: Record<string, string>;
}

/** Scrape the current APIKey from the BHB homepage (plain HTTP). null on any failure / no key. */
async function scrapeApiKey(ctx: FetchContext, cfg: BhbQuotesConfig): Promise<string | null> {
  const pageUrl = cfg.tokenPageUrl ?? BHB_TOKEN_PAGE;
  try {
    const res = await ctx.http.get(pageUrl, { headers: { 'user-agent': BHB_UA } });
    if (res.status < 200 || res.status >= 300) return null;
    return API_KEY_RE.exec(res.body.toString('utf8'))?.[1] ?? null;
  } catch (err) {
    ctx.logger?.warn('bhb quotes: APIKey scrape failed', { err: String(err).slice(0, 140) });
    return null;
  }
}

/** webapi GET headers: source headers with any Authorization/User-Agent stripped, then a LOWERCASE
 *  authorization Bearer (live token) + lowercase user-agent. Lowercase keys override the fetcher's
 *  defaults instead of duplicating them (a dup header trips BHB's Cloudflare 400). */
function webapiHeaders(cfg: BhbQuotesConfig, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    if (/^(authorization|user-agent)$/i.test(k)) continue; // set canonically below
    out[k.toLowerCase()] = v;
  }
  out['user-agent'] = cfg.headers?.['user-agent'] ?? cfg.headers?.['User-Agent'] ?? BHB_UA;
  out['authorization'] = `Bearer ${token}`;
  if (!out['accept']) out['accept'] = 'application/json';
  return out;
}

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
  const cfg = ctx.source.endpointConfig as unknown as BhbQuotesConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;

  // Token: reuse the in-process cache, else scrape a fresh one from the homepage.
  let token = cachedApiKey ?? (await scrapeApiKey(ctx, cfg));
  if (!token) {
    throw new FetchError(
      'HTTP_4XX',
      'bhb quotes: could not obtain an APIKey from the BHB homepage (scrape found no `APIKey = …`)',
    );
  }
  let res = await ctx.http.get(url, { headers: webapiHeaders(cfg, token) });

  // A rotated token ⇒ 401/403 (or a Cloudflare 400): re-scrape ONCE and retry with the fresh key.
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    const fresh = await scrapeApiKey(ctx, cfg);
    if (fresh && fresh !== token) {
      token = fresh;
      res = await ctx.http.get(url, { headers: webapiHeaders(cfg, token) });
    }
  }
  if (res.status >= 200 && res.status < 300) cachedApiKey = token; // remember the working key

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

    const last = num(pick(r, ['Last Price', 'LastPrice', 'lastPrice', 'Price', 'price', 'ClosePrice', 'Close', 'LTP', 'last']));
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
      open: num(pick(r, ['OPENING', 'Open', 'open', 'OpenPrice'])),
      high: num(pick(r, ['High', 'high', 'DayHigh', 'HighPrice'])),
      low: num(pick(r, ['Low', 'low', 'DayLow', 'LowPrice'])),
      volume: num(pick(r, ['VOLUME', 'Volume', 'volume', 'TradedVolume', 'Quantity'])),
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

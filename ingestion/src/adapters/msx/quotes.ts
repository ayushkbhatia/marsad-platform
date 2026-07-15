// MSX (Muscat Stock Exchange) — quotes TaskSpec.
//
// TRANSPORT REALITY (VPS-verified 2026-07-15):
//   * PRIMARY — the live market-watch board is a plain-HTTP POST to msx.om/api.aspx/MarketTicker
//     (ASP.NET ScriptService: content-type application/json, body {"Sector":""} = all sectors,
//     X-Requested-With: XMLHttpRequest). Returns {"d":[ {Symbol,LTP,Change%,ClosePrice,…names} ]}
//     for ~63 main-market securities in ONE request — NOT reCAPTCHA-gated, no browser (transport
//     'http', not 'http_bootstrap'). This is the page behind market-watch-custom.aspx. It carries
//     no OHLC/volume — those come from the Summary-Report OHLCV export (backfill), by design.
//   * FALLBACK — the per-security page  msx.om/snapshot.aspx?s={symbol}  is plain-HTTP, server-
//     rendered with real quote data in stable ASP.NET label spans (fixture snapshot-BKMB.html).
//     Kept for resilience; a 68-way fan-out, so only for board outage.
//
// fetchQuotes selects the board when the source is method=POST; parseQuotes emits many quotes from
// the JSON board or one quote from an HTML snapshot. The board supersedes the fan-out for cost
// (1 request vs 68, and it unblocks the www.msx.om 300/day host budget).

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';
import { FetchError } from '../../core/types.js';

export const MSX_QUOTES_PARSER_VERSION = 1;

/** Grab the inner text of the first element with the given id="..."; null if absent/empty. */
function byId(html: string, id: string): string | null {
  const re = new RegExp(
    `<[a-zA-Z][^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/[a-zA-Z]+>`,
    'i',
  );
  const m = re.exec(html);
  if (!m || m[1] === undefined) return null;
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Inner text of the first element carrying class="...cls..." (word-boundary), else null. */
function byClass(html: string, cls: string): string | null {
  const re = new RegExp(
    `<[a-zA-Z][^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[a-zA-Z]+>`,
    'i',
  );
  const m = re.exec(html);
  if (!m || m[1] === undefined) return null;
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Parse a numeric string that may contain thousands separators; blank/non-finite -> null. */
function num(v: string | null): number | null {
  if (v === null) return null;
  const t = v.replace(/,/g, '').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const CTL = 'ctl00_ContentPlaceHolder1_';

async function fetchQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;

  // PRIMARY (2026-07-15): the live market-watch board is ONE plain-HTTP POST to
  // api.aspx/MarketTicker (body {"Sector":""} = all sectors, ~63 main-market securities:
  // Symbol/LTP/Change%/ClosePrice) — NOT captcha-gated, no browser needed. This replaces the
  // 68-per-symbol snapshot.aspx fan-out (1 request vs 68; also unblocks the www.msx.om 300/day
  // host budget). Selected when the source is configured method=POST; parseQuotes detects the
  // JSON body and emits one quote per row. OHLC/volume are NOT on this board — they come from the
  // Summary-Report OHLCV export (backfill), by design.
  if ((cfg.method ?? 'GET').toUpperCase() === 'POST') {
    const url = cfg.urlTemplate ?? ctx.source.entryUrl;
    const res = await ctx.http.request(url, {
      method: 'POST',
      body: cfg.body ?? '{"Sector":""}',
      ...(cfg.headers ? { headers: cfg.headers } : {}),
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });
    return [
      {
        url: res.url,
        contentType: res.headers['content-type'] ?? 'application/json',
        httpStatus: res.status,
        body: res.body,
        fetchedAt: ctx.now(),
        meta: { venue: 'MSX', dataType: 'quotes', lang: 'en', board: true },
      },
    ];
  }

  // FALLBACK: snapshot.aspx?s={symbol} fan-out (server-rendered HTML, golden-fixtured). Requires a
  // symbol universe on endpoint_config.symbols. An empty universe means the fan-out is misconfigured
  // (missing/misspelled `symbols` key): treat it as a config incident rather than a silent zero-row
  // no-op that masks the misconfig from the freshness sweep/heartbeat.
  const template = cfg.urlTemplate ?? ctx.source.entryUrl;
  const symbols = extractSymbols(ctx);
  if (symbols.length === 0) {
    throw new FetchError(
      'HTTP_4XX',
      `MSX quotes snapshot.aspx fan-out has no symbol universe (endpoint_config.symbols empty for source ${ctx.source.id}); ` +
        `pin the board endpoint (actionDiscovery network_capture) or configure a non-empty symbols array`,
    );
  }
  const results: FetchResult[] = [];
  for (const symbol of symbols) {
    const url = template.includes('{symbol}')
      ? template.replace('{symbol}', encodeURIComponent(symbol))
      : template;
    const res = await ctx.http.get(url, {
      ...(cfg.headers ? { headers: cfg.headers } : {}),
    });
    results.push({
      externalId: symbol,
      url: res.url,
      contentType: res.headers['content-type'] ?? 'text/html',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'MSX', dataType: 'quotes', symbol, lang: 'en' },
    });
  }
  return results;
}

/** Read the symbol universe from source config meta (endpointConfig.headers is not it); the handler
 *  injects it via a `symbols` array on endpointConfig. Kept tolerant: unknown => empty. */
function extractSymbols(ctx: FetchContext): string[] {
  const cfg = ctx.source.endpointConfig as unknown as { symbols?: unknown };
  const raw = cfg.symbols;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

/** Coerce a MarketTicker string/number field to number; blank/non-finite -> null. */
function numAny(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return num(String(v));
}

/**
 * PURE parser for the MarketTicker board JSON -> one NormalizedQuote per row.
 * Row: { Symbol, LTP (last), Change (PERCENT, e.g. -2.72), ClosePrice, …names }. The board carries
 * no OHLC/volume/prev-close columns, so change (absolute) and prev-close are DERIVED from last and
 * the % move: prevClose = last / (1 + pct/100); change = last - prevClose. asOf = snapshot fetch
 * time (delayed board print, no per-row timestamp).
 */
function parseBoardJson(raw: string, asOf: string): ParseResult<NormalizedQuote> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { rows: [], parserVersion: MSX_QUOTES_PARSER_VERSION };
  }
  const d = (payload as { d?: unknown })?.d ?? payload;
  const rows = Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
  const out: NormalizedQuote[] = [];
  for (const r of rows) {
    const ticker = typeof r['Symbol'] === 'string' ? r['Symbol'].trim() : '';
    if (ticker === '') continue;
    const last = numAny(r['LTP']);
    const changePct = numAny(r['Change']);
    let change: number | null = null;
    if (last !== null && changePct !== null && 1 + changePct / 100 !== 0) {
      const prevClose = last / (1 + changePct / 100);
      change = Number((last - prevClose).toFixed(6));
    }
    if (last === null && changePct === null) continue; // empty/suspended stub
    out.push({
      venue: 'MSX',
      ticker,
      last,
      change,
      changePct,
      open: null,
      high: null,
      low: null,
      volume: null,
      asOf,
    });
  }
  return { rows: out, parserVersion: MSX_QUOTES_PARSER_VERSION };
}

/**
 * PURE parser for ONE snapshot.aspx?s={symbol} page -> exactly one NormalizedQuote (or zero if the
 * page carries no last price, e.g. a delisted/suspended stub). Ticker comes from the snapshot's
 * externalId/meta (the symbol we requested) with a fallback to the CompanySymbolLabel "(BKMB)".
 */
function parseQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  const raw = snapshot.body.toString('utf8');

  // Board mode: a JSON MarketTicker payload ({"d":[ {Symbol,LTP,Change,ClosePrice}, … ]}) yields
  // MANY quotes in one snapshot. Detected by a JSON-object body (the snapshot.aspx fallback is HTML).
  const head = raw.slice(0, 64).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    return parseBoardJson(raw, snapshot.fetchedAt);
  }

  const html = raw;

  // Ticker: prefer the requested symbol from lineage; fall back to the page label "(BKMB)".
  let ticker =
    snapshot.externalId ??
    (typeof snapshot.meta['symbol'] === 'string' ? (snapshot.meta['symbol'] as string) : null) ??
    '';
  if (ticker === '') {
    const label = byId(html, `${CTL}CompanySymbolLabel`); // e.g. "(BKMB)"
    if (label) ticker = label.replace(/[()]/g, '').trim();
  }
  if (ticker === '') {
    return { rows: [], parserVersion: MSX_QUOTES_PARSER_VERSION };
  }

  const last = num(byId(html, `${CTL}LTPLabel`)) ?? num(byClass(html, 'market-ltp'));
  const prevClose = num(byId(html, `${CTL}PrevCloseLabel`));
  const open = num(byId(html, `${CTL}OpenLabel`));

  // Change label looks like: "<span>-0.50%</span> <span>(-0.002)</span>" — pull pct and abs.
  const changeText = byId(html, `${CTL}ChangeLabel`) ?? byClass(html, 'market-change') ?? '';
  const pctMatch = /(-?\d+(?:\.\d+)?)\s*%/.exec(changeText);
  const absMatch = /\(\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(changeText);
  let changePct = pctMatch && pctMatch[1] !== undefined ? Number(pctMatch[1]) : null;
  let change = absMatch && absMatch[1] !== undefined ? Number(absMatch[1]) : null;
  if (change !== null && !Number.isFinite(change)) change = null;
  if (changePct !== null && !Number.isFinite(changePct)) changePct = null;
  // Derive whichever is missing from last/prevClose when possible.
  if (change === null && last !== null && prevClose !== null) {
    change = Number((last - prevClose).toFixed(6));
  }
  if (changePct === null && change !== null && prevClose !== null && prevClose !== 0) {
    changePct = Number(((change / prevClose) * 100).toFixed(4));
  }

  const high = num(byId(html, 'ChartDataHigh')) ?? num(byClass(html, 'company-high'));
  const low = num(byId(html, 'ChartDataLow')) ?? num(byClass(html, 'company-low'));
  const volume = num(byId(html, 'ChartDataVolume')) ?? num(byClass(html, 'company-volume'));

  // A page with no last price at all is a suspended/empty stub -> emit nothing.
  if (last === null && open === null && prevClose === null) {
    return { rows: [], parserVersion: MSX_QUOTES_PARSER_VERSION };
  }

  const quote: NormalizedQuote = {
    venue: 'MSX',
    ticker,
    last,
    change,
    changePct,
    open,
    high,
    low,
    volume,
    asOf: snapshot.fetchedAt,
  };
  return { rows: [quote], parserVersion: MSX_QUOTES_PARSER_VERSION };
}

export const msxQuotes: TaskSpec<NormalizedQuote> = {
  dataType: 'quotes',
  parserVersion: MSX_QUOTES_PARSER_VERSION,
  fetch: fetchQuotes,
  parse: parseQuotes,
};

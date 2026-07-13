// MSX (Muscat Stock Exchange) — quotes TaskSpec.
//
// TRANSPORT REALITY (from captured fixtures, documented for the VPS):
//   * The MSX market-watch *board* (msx.om/market-watch) is a JS/SPA page whose rows are rendered
//     client-side from an XHR feed; some paths are reCAPTCHA-gated. The board JSON route is NOT
//     reachable from the captured static HTML and must be pinned on the VPS (endpoint_config
//     actionDiscovery in ingest.sources already flags network_capture + a snapshot.aspx fallback).
//   * The per-security page  msx.om/snapshot.aspx?s={symbol}  IS plain-HTTP, NOT captcha-gated, and
//     is SERVER-RENDERED with real quote data in stable ASP.NET label spans. Fixture
//     ingestion/fixtures/msx/snapshot-BKMB.html (HTTP 200) is our golden.
//
// So the working, golden-verified MSX quote path is: fan out over the security universe, GET
// snapshot.aspx?s={symbol} per security, snapshot each, and parse ONE quote per snapshot with this
// pure parser. The board endpoint, once pinned on the VPS, can supersede the fan-out for cost; the
// parser here is the reliable fallback and the one with a real fixture.

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
  // The intended PRIMARY MSX quote path is the board endpoint pinned on the VPS via
  // endpoint_config.actionDiscovery (network_capture). This snapshot.aspx?s={symbol} fan-out is the
  // golden-verified FALLBACK and requires a symbol universe supplied on endpoint_config.symbols.
  // An empty universe here means the fan-out is misconfigured (missing/misspelled `symbols` key):
  // treat it as a config incident rather than a silent zero-row no-op that masks the misconfig from
  // the freshness sweep/heartbeat. Template placeholder {symbol} is substituted per security.
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

/**
 * PURE parser for ONE snapshot.aspx?s={symbol} page -> exactly one NormalizedQuote (or zero if the
 * page carries no last price, e.g. a delisted/suspended stub). Ticker comes from the snapshot's
 * externalId/meta (the symbol we requested) with a fallback to the CompanySymbolLabel "(BKMB)".
 */
function parseQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  const html = snapshot.body.toString('utf8');

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

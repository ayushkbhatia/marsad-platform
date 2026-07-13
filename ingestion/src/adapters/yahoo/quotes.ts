// ingestion/src/adapters/yahoo/quotes.ts
//
// Yahoo Finance quotes TaskSpec — the CROSS-CHECK partner source for TDWL/QE/DFM.
//
// WHY YAHOO (owner idea, verified live this session): Yahoo Finance republishes DELAYED quotes for 3
// of the 6 GCC venues (TDWL/QE/DFM) as plain JSON, reachable from the plain VPS IP with NO WAF/proxy
// and NO crumb/cookie. It is the SECOND source per venue for the 2-source cross-check → VERIFIED lake
// objects (CONTRACT §7, 02-data-lake.md):
//   * TDWL: Yahoo is the cross-check partner vs the Mubasher aggregator (adapters/mubasher).
//   * QE/DFM: Yahoo is the cross-check partner vs the venue-official board.
// For the cross-check to fire, the Yahoo NormalizedQuote MUST key IDENTICALLY to the primary source's
// row: venue ∈ TDWL/QE/DFM and ticker = our RAW ticker (2222 / QNBK / EMAAR — Yahoo suffix STRIPPED),
// so runtime.mapRowsToStaging emits the same `QUOTE.LAST:{venue}:{ticker}:{session}` natural_key
// (CONTRACT §6.5). See symbols.fromYahooSymbol.
//
// TRANSPORT: `http`. Per-symbol v8/finance/chart (the v7 batch endpoint 401s unauthenticated from the
// VPS and needs a fragile crumb+cookie lifecycle — investigation verdict: not worth it for a 3-venue
// adapter). One GET per symbol: interval=1d&range=1d returns meta + a 1-bar series; we read the meta.
//   GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=1d&range=1d
//   → { chart: { result: [ { meta: { regularMarketPrice, chartPreviousClose, ... } } ] } }
// The URL template + the per-cycle symbol list are CONFIG (ctx.source.endpointConfig), NEVER
// hardcoded here (CONTRACT §0.6). A browser User-Agent header is REQUIRED (seed sets it).
//
// CRITICAL FIELD NOTE (verified live, corrects the task/memory note): the v8/chart meta has NO
// `previousClose` key — only `chartPreviousClose`. change = regularMarketPrice - chartPreviousClose;
// changePct = change / chartPreviousClose * 100.
//
// parse = PURE: snapshot bytes (ONE symbol's chart response) → NormalizedQuote[] (0 or 1 row). No
// I/O, no Date.now() — asOf comes from meta.regularMarketTime (epoch seconds → ISO UTC). Replayable.
// Golden-tested against ingestion/fixtures/yahoo/quote-*.json.
//
// ── FETCH / SYMBOL-LIST WIRING (READ — cross-scope) ────────────────────────────────────────────
// The v8/chart endpoint is per-symbol, so fetch() must know WHICH tickers to poll for the venue. The
// contract says that list comes from public.securities (populated by the primary source) — but the
// frozen FetchContext (core/types.ts) gives fetch() NO DB handle, and runtime.runTask does NOT inject
// a securities list. So fetch() reads the symbol list from endpoint_config (config over code): either
// `endpointConfig.symbols` (an explicit ticker list, editable from Desk) or, absent that, a single
// `{symbol}`/`{ticker}` already baked into urlTemplate. Wiring the LIVE public.securities → per-cycle
// symbol list (and the request-budget rotation) belongs to the worker/runtime layer and is flagged in
// the migration + the build notes; it is out of this adapter's assigned scope. The PURE parser — the
// load-bearing, cross-check-correctness deliverable — is complete and fixture-tested regardless.

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';
import { fromYahooSymbol } from './symbols.js';

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const YAHOO_QUOTES_PARSER_VERSION = 1;

/** The v8/finance/chart meta block we read (a subset — Yahoo sends many more keys). */
interface YahooChartMeta {
  symbol?: string;
  currency?: string;
  exchangeName?: string;
  regularMarketPrice?: number | null;
  chartPreviousClose?: number | null; // NOT `previousClose` — see file header
  regularMarketDayHigh?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketVolume?: number | null;
  regularMarketTime?: number | null; // epoch SECONDS
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
}

interface YahooChartResult {
  meta?: YahooChartMeta;
}

interface YahooChartEnvelope {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: unknown;
  };
}

/** Finite-number guard: maps absent/null/non-finite to null, keeps genuine zeros and negatives. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}

/**
 * Round to 6 dp (quotes_latest.change is numeric(18,6)) to avoid float dust from the subtraction.
 * Pure; returns null when either operand is missing.
 */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * Convert epoch SECONDS → ISO-8601 UTC instant. Yahoo's regularMarketTime is the exchange delayed
 * print time in epoch seconds. Pure — no Date.now(). Returns null on absent/non-finite input (the
 * writer then falls back to captured_at for as_of, per CONTRACT §6.1).
 */
export function epochSecondsToIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return new Date(v * 1000).toISOString();
}

/**
 * Map ONE Yahoo chart meta → NormalizedQuote, or null when it cannot be attributed to a covered
 * venue/ticker or carries no price. venue+ticker are recovered from meta.symbol via fromYahooSymbol
 * (suffix stripped) so the natural_key collides with the primary source (CONTRACT §6.5).
 *
 * change/changePct are computed from chartPreviousClose (the meta has NO previousClose key):
 *   change    = last - chartPreviousClose
 *   changePct = change / chartPreviousClose * 100
 * Both are null when last or chartPreviousClose is missing (or prevClose is 0 for the pct).
 *
 * Exported for unit testing.
 */
export function mapYahooMeta(meta: YahooChartMeta): NormalizedQuote | null {
  const sym = typeof meta.symbol === 'string' ? meta.symbol : '';
  const parsed = fromYahooSymbol(sym);
  if (parsed === null) return null; // not a TDWL/QE/DFM symbol → drop (never mis-attribute)

  const last = num(meta.regularMarketPrice);
  // No price ⇒ nothing to cross-check. Yahoo is a cross-check VALUE partner: its only job is to
  // confirm the primary source's `last`. A null-price row (halted/suspended/no-trade security)
  // carries no confirmable fact, yet would enter cross-check as a candidate with numericValue=null;
  // two null-valued candidates then fall into agreement.ts's comparableText branch and can FALSELY
  // agree → a bogus VERIFIED "no price" object. Drop it here (matches this fn's documented contract:
  // "or carries no price" → null). The primary source still stands alone (PENDING single_source).
  if (last === null) return null;
  const prevClose = num(meta.chartPreviousClose);

  let change: number | null = null;
  let changePct: number | null = null;
  if (last !== null && prevClose !== null) {
    change = round6(last - prevClose);
    changePct = prevClose !== 0 ? Number((((last - prevClose) / prevClose) * 100).toFixed(4)) : null;
  }

  // asOf: exchange delayed print time. Empty string ⇒ writer stamps captured_at (CONTRACT §6.1).
  const asOf = epochSecondsToIso(meta.regularMarketTime) ?? '';

  return {
    venue: parsed.venue,
    ticker: parsed.ticker, // RAW ticker, suffix stripped → cross-check key collision
    last,
    change,
    changePct,
    open: null, // v8/chart 1d meta carries no open; only day high/low/prev-close
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    week52High: num(meta.fiftyTwoWeekHigh),
    week52Low: num(meta.fiftyTwoWeekLow),
    asOf,
  };
}

/**
 * PURE parser: verbatim snapshot bytes of ONE symbol's v8/chart response → NormalizedQuote[] (0 or 1
 * row). Returns zero rows on a malformed / error / uncovered-symbol body (on a CHANGED snapshot that
 * surfaces as PARSE_DRIFT upstream, CONTRACT §10) rather than throwing, matching the QE parser's
 * defensive style. No Date.now() — replayable.
 */
export function parseYahooQuote(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  let doc: YahooChartEnvelope;
  try {
    doc = JSON.parse(snapshot.body.toString('utf8')) as YahooChartEnvelope;
  } catch {
    return { rows: [], parserVersion: YAHOO_QUOTES_PARSER_VERSION };
  }

  const result = doc?.chart?.result;
  if (!Array.isArray(result)) {
    return { rows: [], parserVersion: YAHOO_QUOTES_PARSER_VERSION };
  }

  const rows: NormalizedQuote[] = [];
  for (const r of result) {
    if (r === null || typeof r !== 'object' || r.meta === null || typeof r.meta !== 'object') continue;
    const q = mapYahooMeta(r.meta);
    if (q !== null) rows.push(q);
  }
  return { rows, parserVersion: YAHOO_QUOTES_PARSER_VERSION };
}

/**
 * Resolve the per-cycle symbol list for fetch(). Config over code (CONTRACT §0.6): the list lives on
 * endpoint_config.symbols (Yahoo symbols like "2222.SR", editable from Desk / to be populated from
 * public.securities by the runtime — see the file header wiring note). When absent, falls back to a
 * single symbol already baked into urlTemplate/entry_url (the {symbol} placeholder pre-substituted),
 * so a single-symbol source still works. Returns [] when neither is available.
 */
function symbolsFromConfig(ctx: FetchContext): string[] {
  const cfg = ctx.source.endpointConfig as unknown as { symbols?: unknown };
  const raw = cfg?.symbols;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  }
  return [];
}

/**
 * Build the per-symbol chart URL from the config template. urlTemplate SHOULD carry a {symbol}
 * placeholder (config over code); if it does not, the template is returned unchanged (single-symbol
 * source). {epochMs} is substituted with the injected now() so fetch stays testable.
 */
function buildUrl(template: string, symbol: string, nowIso: string): string {
  const epochMs = String(Date.parse(nowIso) || 0);
  return template.replace(/\{symbol\}/g, encodeURIComponent(symbol)).replace(/\{epochMs\}/g, epochMs);
}

/**
 * fetch(): impure/transport. Plain HTTP (ctx.http) — Yahoo is reachable from the VPS IP with no
 * WAF/proxy. One GET per symbol (v8/chart is per-symbol; the v7 batch endpoint 401s unauthenticated).
 * URL template + symbol list + headers (a browser User-Agent is REQUIRED) all come from
 * source.endpointConfig. Each symbol yields one FetchResult whose meta records the symbol so the
 * snapshot index carries it as external_id-like provenance and per-symbol dedup works.
 *
 * The per-host token bucket + ≤300 req/day/host budget live in core/fetcher.ts (CONTRACT §5); this
 * adapter does NOT re-implement rate limiting, but see the migration for the once-per-session-day
 * sweep cadence that keeps the 3-venue sweep inside the budget.
 */
export async function fetchYahooQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const template = cfg.urlTemplate ?? ctx.source.entryUrl;
  const headers = cfg.headers;
  const symbols = symbolsFromConfig(ctx);

  // No explicit list ⇒ treat the (already-substituted) template as a single-symbol source.
  const targets = symbols.length > 0 ? symbols : [''];

  const out: FetchResult[] = [];
  for (const symbol of targets) {
    const fetchedAt = ctx.now();
    const url = buildUrl(template, symbol, fetchedAt);
    let res;
    try {
      res = await ctx.http.get(url, headers ? { headers } : {});
    } catch (err) {
      // Per-symbol isolation: a ticker not on Yahoo (404) or a transient failure must
      // NOT abort the whole venue sweep — skip and continue (mirrors yahoo/ohlcv.ts).
      ctx.logger?.warn('yahoo quotes: symbol fetch failed, skipping', {
        symbol,
        err: String(err).slice(0, 140),
      });
      continue;
    }
    out.push({
      externalId: symbol || undefined,
      url: res.url,
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt,
      meta: { dataType: 'quotes', lang: 'en', source: 'yahoo', delayed: true, symbol: symbol || null },
    });
  }
  return out;
}

/** The Yahoo cross-check quotes TaskSpec (mounted by adapters/yahoo/index.ts). */
export const yahooQuotes: TaskSpec<NormalizedQuote> = {
  dataType: 'quotes',
  parserVersion: YAHOO_QUOTES_PARSER_VERSION,
  fetch: fetchYahooQuotes,
  parse: parseYahooQuote,
};

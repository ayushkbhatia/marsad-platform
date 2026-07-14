// ingestion/src/adapters/yahoo/ohlcv.ts
//
// Yahoo Finance historical OHLCV TaskSpec — the ≥2-year daily-bar BACKFILL source for TDWL/QE/DFM.
//
// WHY: the same v8/finance/chart endpoint with range=2y (or 5y) & interval=1d returns daily OHLCV for
// ≥2 years, which seeds the price backfill (01-ingestion.md exit criterion: ≥2y daily OHLCV per
// security). This is a one-time-per-security drain, scheduled low-priority so it does not eat the live
// quote request budget (see the migration's ohlcv_backfill source/schedule).
//
//   GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=1d&range=2y
//   → chart.result[0] = {
//       meta: { symbol, gmtoffset, ... },
//       timestamp: [epochSeconds, ...],                    // one per bar
//       indicators: { quote: [ { open[], high[], low[], close[], volume[] } ], adjclose: [ {adjclose[]} ] }
//     }
// All arrays are INDEX-ALIGNED and equal length (verified: 2222.SR range=2y = 505 bars,
// 2024-07-14 → 2026-07-13). We use the RAW OHLC (not adjclose) — ohlcv_daily.close is the traded
// close of record (CONTRACT §6.3); adjclose is split/dividend-adjusted and would not cross-check a
// venue-official raw close.
//
// CROSS-CHECK / natural_key: NormalizedOhlcv carries our venue + RAW ticker (Yahoo suffix stripped)
// and tradeDate 'YYYY-MM-DD', so runtime.mapRowsToStaging emits
// `OHLCV.CLOSE:{venue}:{ticker}:{tradeDate}` identical to any venue EOD-bulletin row for the same bar
// (CONTRACT §6.5, runtime.ts mapOhlcv).
//
// tradeDate DERIVATION: each timestamp is epoch SECONDS at the bar's session start, in UTC. Yahoo also
// gives meta.gmtoffset (seconds east of UTC — 10800 = AST/GST/AST +3 for all three GCC venues). The
// trade date is the LOCAL calendar date, so tradeDate = date((timestamp + gmtoffset) as UTC). Verified:
// ts 1720940400 (2024-07-14T07:00Z) + 10800 → 2024-07-14 local → tradeDate 2024-07-14. PURE: no
// timezone DB, no Date.now(); the offset travels in the response. Golden-tested against the 2y fixture.

import type {
  FetchContext,
  FetchResult,
  NormalizedOhlcv,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';
import { fromYahooSymbol } from './symbols.js';

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const YAHOO_OHLCV_PARSER_VERSION = 1;

interface YahooQuoteArrays {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

interface YahooOhlcvResult {
  meta?: { symbol?: string; gmtoffset?: number | null };
  timestamp?: number[];
  indicators?: {
    quote?: YahooQuoteArrays[];
    adjclose?: { adjclose?: (number | null)[] }[];
  };
}

interface YahooOhlcvEnvelope {
  chart?: { result?: YahooOhlcvResult[] | null; error?: unknown };
}

/** Finite-number guard: absent/null/non-finite → null; keeps genuine zeros. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}

/**
 * epoch SECONDS + gmtoffset SECONDS → local calendar date 'YYYY-MM-DD'. PURE. The offset shifts the
 * instant into the venue's local wall clock; we then take the UTC date parts of that shifted instant
 * (never Date.getFullYear which would apply the RUNNER's tz). Returns null on non-finite input.
 */
export function barTradeDate(epochSeconds: unknown, gmtOffsetSeconds: unknown): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  const offset = typeof gmtOffsetSeconds === 'number' && Number.isFinite(gmtOffsetSeconds) ? gmtOffsetSeconds : 0;
  const d = new Date((epochSeconds + offset) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * PURE parser: verbatim snapshot bytes of ONE symbol's range=Ny chart response → NormalizedOhlcv[]
 * (one row per daily bar). venue+ticker recovered from meta.symbol (suffix stripped) so bars key
 * identically to a venue EOD close (CONTRACT §6.5). A bar with no `close` is skipped — ohlcv_daily.close
 * is NOT NULL (CONTRACT §6.3), so a null close cannot produce a valid row. Malformed / uncovered /
 * mis-aligned bodies return zero rows (PARSE_DRIFT on a CHANGED snapshot, CONTRACT §10) rather than
 * throwing. No Date.now() — replayable.
 */
export function parseYahooOhlcv(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  let doc: YahooOhlcvEnvelope;
  try {
    doc = JSON.parse(snapshot.body.toString('utf8')) as YahooOhlcvEnvelope;
  } catch {
    return { rows: [], parserVersion: YAHOO_OHLCV_PARSER_VERSION };
  }

  const result = doc?.chart?.result;
  if (!Array.isArray(result) || result.length === 0) {
    return { rows: [], parserVersion: YAHOO_OHLCV_PARSER_VERSION };
  }

  const rows: NormalizedOhlcv[] = [];
  for (const r of result) {
    if (r === null || typeof r !== 'object') continue;
    const parsed = fromYahooSymbol(typeof r.meta?.symbol === 'string' ? r.meta.symbol : '');
    if (parsed === null) continue; // not a TDWL/QE/DFM symbol → never mis-attribute

    const gmtoffset = r.meta?.gmtoffset ?? 0;
    const timestamps = Array.isArray(r.timestamp) ? r.timestamp : [];
    const q = Array.isArray(r.indicators?.quote) ? r.indicators!.quote![0] : undefined;
    if (!q) continue;

    const open = Array.isArray(q.open) ? q.open : [];
    const high = Array.isArray(q.high) ? q.high : [];
    const low = Array.isArray(q.low) ? q.low : [];
    const close = Array.isArray(q.close) ? q.close : [];
    const volume = Array.isArray(q.volume) ? q.volume : [];

    for (let i = 0; i < timestamps.length; i++) {
      const c = num(close[i]);
      if (c === null) continue; // close is NOT NULL in ohlcv_daily — skip no-trade / null bars
      const tradeDate = barTradeDate(timestamps[i], gmtoffset);
      if (tradeDate === null) continue;

      rows.push({
        venue: parsed.venue,
        ticker: parsed.ticker, // RAW ticker (suffix stripped) → cross-check key collision
        tradeDate,
        open: num(open[i]),
        high: num(high[i]),
        low: num(low[i]),
        close: c,
        volume: num(volume[i]),
      });
    }
  }
  return { rows, parserVersion: YAHOO_OHLCV_PARSER_VERSION };
}

/**
 * Build the per-symbol backfill URL from the config template ({symbol}/{epochMs} placeholders).
 * The range (2y/5y) is baked into the template by the seed (config over code).
 */
function buildUrl(template: string, symbol: string, nowIso: string): string {
  const epochMs = String(Date.parse(nowIso) || 0);
  return template.replace(/\{symbol\}/g, encodeURIComponent(symbol)).replace(/\{epochMs\}/g, epochMs);
}

/** Symbol list from endpoint_config.symbols (see quotes.ts header for the wiring note). */
function symbolsFromConfig(ctx: FetchContext): string[] {
  const cfg = ctx.source.endpointConfig as unknown as { symbols?: unknown };
  const raw = cfg?.symbols;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  }
  return [];
}

/** Bounded-fetch pool size from endpoint_config.fetch_concurrency (default 8, clamped ≥1). */
function fetchConcurrency(ctx: FetchContext): number {
  const raw = (ctx.source.endpointConfig as unknown as { fetch_concurrency?: unknown }).fetch_concurrency;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

/**
 * Run `worker` over `items` with at most `size` outstanding at once (worker-pool, same shape as the
 * worker's ingest-poller drain loop). A worker that throws propagates; fetchOneSymbol never throws
 * (per-symbol isolation is inside it), so in practice a lane only ends by exhausting the cursor.
 */
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }
  const lanes = Math.max(1, Math.min(size, items.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
}

/**
 * One symbol's GET → FetchResult, or null on any failure. PER-SYMBOL ISOLATION: a ticker not on
 * Yahoo (rights/warrants/funds/format mismatch → 404) or a transient failure returns null (logged,
 * skipped) rather than throwing, so it never aborts the ~50-400 symbol venue sweep.
 */
async function fetchOneSymbol(ctx: FetchContext, symbol: string): Promise<FetchResult | null> {
  const cfg = ctx.source.endpointConfig;
  const template = cfg.urlTemplate ?? ctx.source.entryUrl;
  const headers = cfg.headers;
  const fetchedAt = ctx.now();
  const url = buildUrl(template, symbol, fetchedAt);
  let res;
  try {
    res = await ctx.http.get(url, headers ? { headers } : {});
  } catch (err) {
    ctx.logger?.warn('yahoo ohlcv: symbol fetch failed, skipping', {
      symbol,
      err: String(err).slice(0, 140),
    });
    return null;
  }
  return {
    externalId: symbol || undefined,
    url: res.url,
    contentType: res.headers['content-type'] ?? 'application/json',
    httpStatus: res.status,
    body: res.body,
    fetchedAt,
    meta: { dataType: 'ohlcv_backfill', lang: 'en', source: 'yahoo', delayed: true, symbol: symbol || null },
  };
}

/**
 * fetch(): impure/transport. One GET per symbol of the range=Ny&interval=1d chart. Backfill is a
 * one-time-per-security drain routed to a dedicated high-throughput http client (runtime
 * httpClientForSource: high concurrency + rate + per-host budget, since every request rotates a
 * fresh exit IP). URL template + symbol list + headers come from source.endpointConfig (config
 * over code).
 *
 * TWO PATHS:
 *   - STREAMING (ctx.onFetched supplied by the runtime): fetch symbols at bounded concurrency
 *     (endpoint_config.fetch_concurrency, default 8) and push each result to the sink the moment it
 *     lands — the runtime snapshots + parses + stages it immediately. Bars accrue progressively and
 *     a mid-sweep crash keeps everything already staged (fetch is idempotent). Returns [] (drained).
 *   - ARRAY (no sink — unit tests / any direct caller): serial fetch → array, byte-for-byte the
 *     original behaviour and per-symbol isolation.
 */
export async function fetchYahooOhlcv(ctx: FetchContext): Promise<FetchResult[]> {
  const symbols = symbolsFromConfig(ctx);
  const targets = symbols.length > 0 ? symbols : [''];

  if (ctx.onFetched) {
    const sink = ctx.onFetched;
    await runPool(targets, fetchConcurrency(ctx), async (symbol) => {
      const fr = await fetchOneSymbol(ctx, symbol);
      if (fr) await sink(fr);
    });
    return [];
  }

  const out: FetchResult[] = [];
  for (const symbol of targets) {
    const fr = await fetchOneSymbol(ctx, symbol);
    if (fr) out.push(fr);
  }
  return out;
}

/** The Yahoo OHLCV backfill TaskSpec (mounted by adapters/yahoo/index.ts as eodBulletin). */
export const yahooOhlcv: TaskSpec<NormalizedOhlcv> = {
  dataType: 'ohlcv_backfill',
  parserVersion: YAHOO_OHLCV_PARSER_VERSION,
  fetch: fetchYahooOhlcv,
  parse: parseYahooOhlcv,
};

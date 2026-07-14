// ingestion/src/adapters/msx/history.ts
//
// MSX (Muscat Stock Exchange) ≥2-year daily price-history BACKFILL TaskSpec — the price backfill
// drain for MSX, one of the three venues Yahoo does NOT cover (ADX/MSX/BHB). Config-driven: one seed
// row (migration 0034) with provider='msx-company-chart', fanned over the MSX symbol universe.
//
// WHY A FIRST-CLASS MSX SOURCE (not Mubasher): unlike ADX (adapters/mubasher/ohlcv-csv.ts), MSX
// exposes its OWN native, plain-HTTP JSON history handler — no aggregator, no 2-step hash scrape:
//   GET https://www.msx.om/company-chart-data.aspx?s={symbol}
//   → application/json array; ONE response is the FULL daily series to IPO/2003 (verified live
//     2026-07-14: BKMB 5745 daily rows 2003-01-01→2026-07-13, 24 yrs; OQGN 668 rows from 2023-10-24
//     IPO) — comfortably ≥2y for every symbol. The Highstock rangeSelector (1w/1m/…/all) only zooms
//     client-side; there is no server paging, so a single GET per symbol is the whole history.
//   (Served behind Imperva/Incapsula, but a plain browser UA returns 200 with no auth/captcha — no
//    proxy needed. If the VPS IP gets 403'd under volume, flip use_proxy=true in the seed row; the
//    runtime honors it with no redeploy.)
//
// ── CLOSE-ONLY (honest depth limit) ───────────────────────────────────────────────────────────────
// This venue is a CLOSE-ONLY series, NOT true OHLC. Each daily row is
//   {"Date":"YYYY-MM-DD","Value":"close","Volume":"str","LTP":"close","Turnover":"str",
//    "open":null,"high":null,"low":null}
// LTP == Value == the daily close; open/high/low keys EXIST but are null in every observed row for
// every symbol probed. We therefore emit open/high/low as NULL — we do NOT fabricate OHLC. close is
// mapped from LTP (==Value), volume from Volume, valueTraded from Turnover. This still clears the
// ≥2y daily-price requirement (01-ingestion.md exit criterion) and cross-checks the venue-official
// close against the existing snapshot.aspx quote for the same day.
//
// ── TODAY'S INTRADAY TICKS ARE FILTERED OUT ───────────────────────────────────────────────────────
// The CURRENT trading day is appended to the same array as intraday ticks with a SPACE-delimited
// timestamp ("Date":"YYYY-MM-DD HH:MM:SS", plus numeric Year/Month/Day/Hour/Minute keys). Those are
// NOT daily bars. The daily series = rows whose Date has NO space — mirrors the site's own filter
// (data[i].Date.split(' ').length == 1). We keep only space-free Dates; the intraday ticks (and any
// same-day double the site would show live) never become ohlcv_daily bars.
//
// ── META-CARRIED VENUE + TICKER ──────────────────────────────────────────────────────────────────
// The JSON body carries NO ticker and NO venue, so fetch() STAMPS meta.venue + meta.ticker on the
// FetchResult (venue = ctx.source.venue = 'MSX'; ticker = the RAW symbol requested). The snapshot
// store round-trips FetchResult.meta → StoredSnapshot.meta (exactly as adapters/mubasher/ohlcv-csv.ts
// does), so the PURE parser recovers venue/ticker from snapshot.meta — never from the bytes.
//
// ── natural_key COLLISION (deliberate) ───────────────────────────────────────────────────────────
// NormalizedOhlcv carries our venue (MSX) + RAW ticker + tradeDate, so runtime.mapOhlcv emits
//   OHLCV.CLOSE:MSX:{ticker}:{tradeDate}
// IDENTICAL to any future MSX EOD-bulletin bar for the same day (CONTRACT §6.5). When such a second
// MSX OHLCV source lands, the two collide on the same natural_key and the 2-source cross-check fires
// — which is the whole point of seeding this as the MSX backfill source of record now.
//
// ── PURITY ───────────────────────────────────────────────────────────────────────────────────────
// parse() has no Date.now / Math.random / new Date: the JSON Date IS already the venue-local calendar
// date, so there is nothing to compute. Malformed / uncovered bytes yield zero rows (a PARSE_DRIFT
// signal on a CHANGED snapshot, CONTRACT §10) and NEVER throw. Golden-tested against
// ingestion/fixtures/msx/company-chart-BKMB.json.

import type {
  FetchContext,
  FetchResult,
  NormalizedOhlcv,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from '../../core/types.js';

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const MSX_HISTORY_PARSER_VERSION = 1;

/** The six GCC venue codes (VenueCode is a closed union; guard meta.venue against it). */
const VENUE_CODES: ReadonlySet<string> = new Set<VenueCode>(['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB']);

/** Default bounded-fetch concurrency (single GET per symbol); clamped ≥1. */
const DEFAULT_FETCH_CONCURRENCY = 4;

/** The alt-provider discriminant carried on the FetchResult meta + endpoint_config. */
const PROVIDER = 'msx-company-chart';

/** One raw daily/intraday row as returned by company-chart-data.aspx. */
interface MsxChartRow {
  Date?: unknown; // 'YYYY-MM-DD' (daily) or 'YYYY-MM-DD HH:MM:SS' (today's intraday ticks)
  Value?: unknown; // daily close (string on daily rows, number on intraday ticks)
  LTP?: unknown; // == Value (the daily close)
  Volume?: unknown;
  Turnover?: unknown;
  open?: unknown; // always null on this venue (close-only)
  high?: unknown; // always null
  low?: unknown; // always null
}

interface MsxHistoryConfig {
  urlTemplate?: string; // '.../company-chart-data.aspx?s={symbol}'
  headers?: Record<string, string>;
  fetch_concurrency?: number;
  symbols?: unknown; // string[] injected by the runtime from public.securities (RAW MSX tickers)
}

/**
 * Finite-number guard for a value that may arrive as a string ("3.800", "8431620") or a number:
 * empty / '-' / non-finite → null; keeps a genuine 0. The DB columns are nullable (except close,
 * handled by the caller), so we never emit NaN.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE parser: verbatim JSON snapshot bytes of ONE ticker's full history → NormalizedOhlcv[] (one row
 * per DAILY bar). venue + ticker are recovered from snapshot.meta (stamped by fetch), NOT from the
 * bytes (the JSON carries neither).
 *
 * DAILY FILTER: keep only rows whose Date has NO space — the current trading day is appended as
 * space-timestamped intraday ticks ("YYYY-MM-DD HH:MM:SS") which are NOT daily bars (mirrors the
 * site's own data[i].Date.split(' ').length == 1 filter). A row with a null/blank close (LTP) is
 * skipped — ohlcv_daily.close is NOT NULL (CONTRACT §6.3). open/high/low are always emitted NULL:
 * the venue is close-only (open/high/low null in every row) — we do NOT fabricate OHLC. Any throw →
 * zero rows (never hard-throw): a CHANGED-but-unparseable snapshot surfaces as PARSE_DRIFT upstream,
 * not a crash. No Date.now() — replayable.
 */
export function parseMsxHistory(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const parserVersion = MSX_HISTORY_PARSER_VERSION;
  try {
    const meta = snapshot.meta ?? {};
    const ticker = typeof meta.ticker === 'string' ? meta.ticker.trim() : '';
    const venueRaw = typeof meta.venue === 'string' ? meta.venue.trim() : '';
    // No ticker ⇒ cannot resolve a security_id downstream; unknown venue ⇒ cannot key. Emit nothing
    // (rather than mis-attribute) — matches the mubasher/yahoo OHLCV guards.
    if (ticker === '' || !VENUE_CODES.has(venueRaw)) return { rows: [], parserVersion };
    const venue = venueRaw as VenueCode;

    const doc = JSON.parse(snapshot.body.toString('utf8')) as unknown;
    if (!Array.isArray(doc)) return { rows: [], parserVersion };

    const rows: NormalizedOhlcv[] = [];
    for (const raw of doc) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as MsxChartRow;

      const date = typeof r.Date === 'string' ? r.Date : '';
      // DAILY only: reject the space-timestamped intraday ticks of the current trading day, and any
      // value that is not a bare ISO calendar date.
      if (date.includes(' ')) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      // close = LTP (== Value == the daily close). Prefer LTP; fall back to Value if LTP is absent.
      const close = num(r.LTP) ?? num(r.Value);
      if (close === null) continue; // ohlcv_daily.close is NOT NULL — a null close cannot be a row.

      rows.push({
        venue,
        ticker, // RAW ticker → OHLCV.CLOSE natural_key collision with a future MSX venue EOD bar
        tradeDate: date,
        // close-only venue: open/high/low are null in every source row — never fabricated.
        open: null,
        high: null,
        low: null,
        close,
        volume: num(r.Volume),
        valueTraded: num(r.Turnover),
      });
    }
    return { rows, parserVersion };
  } catch {
    return { rows: [], parserVersion };
  }
}

/** endpoint_config accessor (local cast — the frozen EndpointConfig surface stays untouched). */
function configOf(ctx: FetchContext): MsxHistoryConfig {
  return ctx.source.endpointConfig as unknown as MsxHistoryConfig;
}

/** RAW listed-ticker list from endpoint_config.symbols (injected by the runtime; see runtime.ts). */
function symbolsFromConfig(ctx: FetchContext): string[] {
  const raw = configOf(ctx).symbols;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  }
  return [];
}

/** Bounded-fetch pool size from endpoint_config.fetch_concurrency (default 4, clamped ≥1). */
function fetchConcurrency(ctx: FetchContext): number {
  const raw = configOf(ctx).fetch_concurrency;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FETCH_CONCURRENCY;
}

/**
 * Run `worker` over `items` with at most `size` outstanding at once (worker-pool; same shape as
 * yahoo/ohlcv.ts and mubasher/ohlcv-csv.ts runPool). fetchOneTicker never throws (per-ticker
 * isolation is inside it), so a lane only ends by exhausting the cursor.
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
 * One ticker's single GET → the JSON FetchResult, or null on ANY failure. PER-TICKER ISOLATION: a
 * ticker whose request throws or returns non-2xx returns null (logged, skipped) rather than throwing
 * — so it never aborts the MSX symbol sweep. venue + ticker are stamped on meta for the pure parser
 * (the JSON body carries neither).
 */
async function fetchOneTicker(ctx: FetchContext, ticker: string): Promise<FetchResult | null> {
  const cfg = configOf(ctx);
  const template = cfg.urlTemplate ?? ctx.source.entryUrl;
  const headers = cfg.headers;
  const fetchedAt = ctx.now();
  const url = template.replace(/\{symbol\}/g, encodeURIComponent(ticker));

  let res;
  try {
    res = await ctx.http.get(url, headers ? { headers } : {});
  } catch (err) {
    ctx.logger?.warn('msx history: symbol fetch failed, skipping ticker', {
      ticker,
      err: String(err).slice(0, 140),
    });
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    ctx.logger?.warn('msx history: non-2xx, skipping ticker', { ticker, status: res.status });
    return null;
  }

  return {
    externalId: ticker,
    url: res.url,
    contentType: res.headers['content-type'] ?? 'application/json',
    httpStatus: res.status,
    body: res.body,
    fetchedAt,
    // meta carries the venue + ticker the pure parser needs (the JSON bytes carry neither), plus lang
    // + provenance for lineage. Round-trips through the snapshot store into StoredSnapshot.meta.
    meta: {
      dataType: 'ohlcv_backfill',
      source: PROVIDER,
      venue: ctx.source.venue,
      ticker,
      lang: 'en',
      delayed: true,
    },
  };
}

/**
 * fetch(): impure/transport. Plain HTTP (ctx.http) — MSX's company-chart-data.aspx is reachable from
 * the VPS IP with a browser UA (Imperva-fronted but no auth/captcha). One GET per symbol. Two paths,
 * mirroring yahoo/ohlcv.ts and mubasher/ohlcv-csv.ts exactly:
 *   - STREAMING (ctx.onFetched supplied): fetch tickers at bounded concurrency
 *     (endpoint_config.fetch_concurrency, default 4) and push each JSON FetchResult to the sink the
 *     moment it lands — the runtime snapshots + parses + stages it immediately, so bars accrue
 *     progressively and a mid-sweep crash keeps everything already staged (fetch is idempotent).
 *     Returns [] (drained).
 *   - ARRAY (no sink — unit tests / any direct caller): serial fetch → array of survivors, same
 *     per-ticker isolation.
 */
export async function fetchMsxHistory(ctx: FetchContext): Promise<FetchResult[]> {
  const targets = symbolsFromConfig(ctx);

  if (ctx.onFetched) {
    const sink = ctx.onFetched;
    await runPool(targets, fetchConcurrency(ctx), async (ticker) => {
      const fr = await fetchOneTicker(ctx, ticker);
      if (fr) await sink(fr);
    });
    return [];
  }

  const out: FetchResult[] = [];
  for (const ticker of targets) {
    const fr = await fetchOneTicker(ctx, ticker);
    if (fr) out.push(fr);
  }
  return out;
}

/** The MSX company-chart history backfill TaskSpec (routed by runtime.tasksForProvider). */
export const msxHistory: TaskSpec<NormalizedOhlcv> = {
  dataType: 'ohlcv_backfill',
  parserVersion: MSX_HISTORY_PARSER_VERSION,
  fetch: fetchMsxHistory,
  parse: parseMsxHistory,
};

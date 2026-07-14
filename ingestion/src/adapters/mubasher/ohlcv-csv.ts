// ingestion/src/adapters/mubasher/ohlcv-csv.ts
//
// Mubasher-backed ≥2-year daily OHLCV BACKFILL TaskSpec — the price backfill drain for the venues
// Yahoo does NOT cover (ADX/MSX/BHB). Config-driven: one seed row per venue (migration 0033 seeds ADX).
//
// WHY MUBASHER-CSV: Yahoo Finance has no findable symbols for ADX/MSX/BHB (0021 header), so those three
// venues had ZERO ≥2y daily bars. Mubasher (english.mubasher.info) publishes each listed stock's full
// historical daily series as a plain CSV, reachable from a plain IP with NO WAF/proxy and NO crumb —
// so this task uses plain `http` transport (ctx.http), exactly like the Mubasher TDWL quotes adapter.
// It is the ADX/MSX/BHB analogue of yahoo/ohlcv.ts (same runPool / streaming-sink / per-symbol
// isolation shape) and, like Yahoo, Mubasher is a cross-venue AGGREGATOR — it owns NO VenueAdapter and
// is NOT a key in the frozen ADAPTERS map. The venue travels on each NormalizedOhlcv row.
//
// ── THE 2-STEP FETCH (per ticker) ────────────────────────────────────────────────────────────────
// The CSV lives at a per-ticker opaque hash URL that is NOT derivable from the ticker — it must be
// scraped from the stock page first:
//   (1) GET https://english.mubasher.info/markets/{VENUE}/stocks/{TICKER}   (the stock page, HTML)
//       → an attribute historical-data-url=".../File.Historical_Stock_Charts_Dir/{hash}.csv"
//       A DECOY intraday attribute on the SAME page carries the SAME hash under
//       File.Delay_Stock_Intraday_Charts_Dir, so the extraction regex MUST anchor on
//       'Historical_Stock_Charts_Dir' to pick the ≥2y historical file (default hashPattern below).
//       A non-existent ticker → page 404 (no hash) → that ticker is SKIPPED (per-ticker isolation).
//   (2) GET https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/{hash}.csv
//       (Referer = the stock page). NO header row; each line: DATE/TIME,open,high,low,close,volume
//       e.g. 2026-07-14/00:00:00,18.0,18.16,17.84,17.86,3638463. The DATE part before '/' is ALREADY
//       the venue-local calendar trade date 'YYYY-MM-DD' — NO timezone math is needed or done.
//
// ── META-CARRIED VENUE + TICKER ──────────────────────────────────────────────────────────────────
// The CSV body carries NO ticker and NO venue, so fetch() STAMPS meta.ticker + meta.venue on the
// FetchResult. The snapshot store round-trips FetchResult.meta → StoredSnapshot.meta (exactly as
// adapters/adx/filings.ts round-trips meta.filingFieldMap), so the PURE parser recovers venue/ticker
// from snapshot.meta — never from the bytes, never from a live DB lookup.
//
// ── PURITY ───────────────────────────────────────────────────────────────────────────────────────
// parse() has no Date.now / Math.random / new Date: the CSV date is already the local calendar date,
// so there is nothing to compute. Malformed / uncovered / stray-header bytes yield zero rows (a
// PARSE_DRIFT signal on a CHANGED snapshot, CONTRACT §10) and NEVER throw. Golden-tested against
// ingestion/fixtures/mubasher/adx-fab-ohlcv.csv.
//
// ── natural_key COLLISION (deliberate) ───────────────────────────────────────────────────────────
// NormalizedOhlcv carries our venue + RAW ticker + tradeDate, so runtime.mapOhlcv emits
//   OHLCV.CLOSE:{venue}:{ticker}:{tradeDate}
// IDENTICAL to any future ADX/MSX/BHB EOD-bulletin bar for the same day (CONTRACT §6.5). When such a
// second source lands, the two collide on the same natural_key and the 2-source cross-check fires —
// which is the whole point of seeding Mubasher as the backfill source of record now.

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
export const MUBASHER_OHLCV_CSV_PARSER_VERSION = 1;

/** The six GCC venue codes (VenueCode is a closed union; guard meta.venue against it). */
const VENUE_CODES: ReadonlySet<string> = new Set<VenueCode>(['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB']);

/** Default hash-extraction pattern — MUST anchor on the Historical_ dir to skip the intraday decoy. */
const DEFAULT_HASH_PATTERN = 'Historical_Stock_Charts_Dir/([a-f0-9]+)\\.csv';

/** Default bounded-fetch concurrency (per-ticker 2-step); clamped ≥1. */
const DEFAULT_FETCH_CONCURRENCY = 4;

/** The alt-provider discriminant carried on the FetchResult meta + endpoint_config. */
const PROVIDER = 'mubasher_csv';

interface MubasherCsvConfig {
  pageUrlTemplate?: string; // '.../markets/ADX/stocks/{symbol}'
  csvUrlTemplate?: string; // '.../File.Historical_Stock_Charts_Dir/{hash}.csv'
  hashPattern?: string; // regex w/ one capture group for the hash (default DEFAULT_HASH_PATTERN)
  headers?: Record<string, string>;
  fetch_concurrency?: number;
  symbols?: unknown; // string[] injected by the runtime from public.securities (RAW tickers)
}

/**
 * Finite-number guard for a CSV field: empty / '-' / non-finite → null; keeps a genuine 0.
 * The DB columns are nullable (except close, handled by the caller), so we never emit NaN.
 */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE parser: verbatim CSV snapshot bytes of ONE ticker's full history → NormalizedOhlcv[] (one row
 * per daily bar). venue + ticker are recovered from snapshot.meta (stamped by fetch), NOT from the
 * bytes (the CSV carries neither). A bar with a null close is skipped — ohlcv_daily.close is NOT NULL
 * (CONTRACT §6.3). A line whose date field is not YYYY-MM-DD (a stray header / garbage line) is
 * skipped. Any throw → zero rows (never hard-throw): a CHANGED-but-unparseable snapshot surfaces as
 * PARSE_DRIFT upstream, not a crash. No Date.now() — replayable.
 */
export function parseMubasherOhlcvCsv(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const parserVersion = MUBASHER_OHLCV_CSV_PARSER_VERSION;
  try {
    const meta = snapshot.meta ?? {};
    const ticker = typeof meta.ticker === 'string' ? meta.ticker.trim() : '';
    const venueRaw = typeof meta.venue === 'string' ? meta.venue.trim() : '';
    // No ticker ⇒ cannot resolve a security_id downstream; unknown venue ⇒ cannot key. Emit nothing
    // (rather than mis-attribute) — matches yahoo/ohlcv.ts's fromYahooSymbol===null guard.
    if (ticker === '' || !VENUE_CODES.has(venueRaw)) return { rows: [], parserVersion };
    const venue = venueRaw as VenueCode;

    const body = snapshot.body.toString('utf8');
    const rows: NormalizedOhlcv[] = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const f = line.split(',');
      const datePart = (f[0] ?? '').split('/')[0] ?? '';
      // Require an ISO calendar date. This also skips any stray header row or garbage line — a line
      // that does not begin with a YYYY-MM-DD date is not a bar.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;

      const close = num(f[4]);
      if (close === null) continue; // ohlcv_daily.close is NOT NULL — a null close cannot be a row.

      rows.push({
        venue,
        ticker, // RAW ticker → OHLCV.CLOSE natural_key collision with a future venue EOD bar
        tradeDate: datePart,
        open: num(f[1]),
        high: num(f[2]),
        low: num(f[3]),
        close,
        volume: num(f[5]),
      });
    }
    return { rows, parserVersion };
  } catch {
    return { rows: [], parserVersion };
  }
}

/** endpoint_config accessor (local cast — the frozen EndpointConfig surface stays untouched). */
function configOf(ctx: FetchContext): MubasherCsvConfig {
  return ctx.source.endpointConfig as unknown as MubasherCsvConfig;
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
 * yahoo/ohlcv.ts runPool and the worker's ingest-poller drain loop). fetchOneTicker never throws
 * (per-ticker isolation is inside it), so a lane only ends by exhausting the cursor.
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
 * One ticker's 2-step GET → the CSV FetchResult, or null on ANY failure. PER-TICKER ISOLATION: a
 * ticker whose stock page 404s (delisted / bad slug), whose page carries no historical hash, or whose
 * CSV fetch throws returns null (logged, skipped) rather than throwing — so it never aborts the
 * ~93-ticker venue sweep.
 */
async function fetchOneTicker(ctx: FetchContext, ticker: string): Promise<FetchResult | null> {
  const cfg = configOf(ctx);
  const pageTemplate = cfg.pageUrlTemplate ?? ctx.source.entryUrl;
  const csvTemplate = cfg.csvUrlTemplate ?? '';
  const headers = cfg.headers;
  const hashPattern = cfg.hashPattern ?? DEFAULT_HASH_PATTERN;
  const fetchedAt = ctx.now();

  const pageUrl = pageTemplate.replace(/\{symbol\}/g, encodeURIComponent(ticker));

  // (a) Stock page — scrape the per-ticker historical CSV hash.
  let pageRes;
  try {
    pageRes = await ctx.http.get(pageUrl, headers ? { headers } : {});
  } catch (err) {
    ctx.logger?.warn('mubasher ohlcv-csv: stock-page fetch failed, skipping ticker', {
      ticker,
      err: String(err).slice(0, 140),
    });
    return null;
  }
  if (pageRes.status < 200 || pageRes.status >= 300) {
    ctx.logger?.warn('mubasher ohlcv-csv: stock-page non-2xx, skipping ticker', {
      ticker,
      status: pageRes.status,
    });
    return null;
  }

  // (b) Anchor on the Historical_ dir so the intraday decoy (same hash) is never matched.
  const pageBody = pageRes.body.toString('utf8');
  const match = new RegExp(hashPattern).exec(pageBody);
  const hash = match?.[1];
  if (!hash) {
    ctx.logger?.warn('mubasher ohlcv-csv: no historical hash on page, skipping ticker', { ticker });
    return null;
  }

  // (c) Historical CSV — Referer = the stock page (required by the origin).
  const csvUrl = csvTemplate.replace(/\{hash\}/g, hash);
  let csvRes;
  try {
    csvRes = await ctx.http.get(csvUrl, { headers: { ...(headers ?? {}), Referer: pageUrl } });
  } catch (err) {
    ctx.logger?.warn('mubasher ohlcv-csv: CSV fetch failed, skipping ticker', {
      ticker,
      err: String(err).slice(0, 140),
    });
    return null;
  }

  return {
    externalId: ticker,
    url: csvRes.url,
    contentType: csvRes.headers['content-type'] ?? 'application/octet-stream',
    httpStatus: csvRes.status,
    body: csvRes.body,
    fetchedAt,
    // meta carries the venue + ticker the pure parser needs (the CSV bytes carry neither), plus lang
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
 * fetch(): impure/transport. Plain HTTP (ctx.http) — Mubasher's static host is reachable from the VPS
 * IP with no WAF/proxy. Two paths, mirroring yahoo/ohlcv.ts exactly:
 *   - STREAMING (ctx.onFetched supplied): fetch tickers at bounded concurrency
 *     (endpoint_config.fetch_concurrency, default 4) and push each CSV FetchResult to the sink the
 *     moment it lands — the runtime snapshots + parses + stages it immediately, so bars accrue
 *     progressively and a mid-sweep crash keeps everything already staged (fetch is idempotent).
 *     Returns [] (drained).
 *   - ARRAY (no sink — unit tests / any direct caller): serial fetch → array of survivors, same
 *     per-ticker isolation.
 */
export async function fetchMubasherOhlcvCsv(ctx: FetchContext): Promise<FetchResult[]> {
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

/** The Mubasher-CSV OHLCV backfill TaskSpec (routed by runtime.tasksForProvider for mubasher_csv). */
export const mubasherOhlcvCsv: TaskSpec<NormalizedOhlcv> = {
  dataType: 'ohlcv_backfill',
  parserVersion: MUBASHER_OHLCV_CSV_PARSER_VERSION,
  fetch: fetchMubasherOhlcvCsv,
  parse: parseMubasherOhlcvCsv,
};

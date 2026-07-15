// ingestion/src/adapters/msx/history.ts
//
// MSX (Muscat Stock Exchange) full-history daily OHLCV BACKFILL TaskSpec — the price backfill drain
// for MSX, one of the three venues Yahoo does NOT cover (ADX/MSX/BHB). Config-driven: one seed row
// with provider='msx-summary', fanned over the MSX symbol universe (injected by the runtime).
//
// SOURCE — the Summary-Report "List" endpoint (VPS-verified live 2026-07-15):
//   POST https://www.msx.om/summary-report.aspx/List
//   body {"Symbol":"{TICKER}","Type":"D","From":"1990-01-01","To":"{today YYYY-MM-DD}"}   (Type D=Daily)
//   → {"d":[ { Symbol, DateEn:"Jul 14, 2026", Open, High, Low, Close, Volume, Turnover, Trades,
//              PreviousClose, LastTrade, Change, ChangePer, …names }, … ]} ASCENDING (oldest first).
//   ONE POST is the FULL daily series to IPO/earliest (BKMB: 5750 bars 2003-01-01→2026-07-14, ~23y).
//   This is the page behind the site's snapshot.aspx → Performance → "Summary Report" → Export-to-Excel
//   flow: the Excel button just re-formats this same List JSON, so we hit the endpoint directly — no
//   browser, no XLSX. Plain HTTP (application/json + X-Requested-With), no WAF/captcha/proxy.
//
// ── FULL OHLC (supersedes the old close-only company-chart-data.aspx source) ──────────────────────
// Unlike the retired company-chart source (close-only, open/high/low always null), the List endpoint
// carries real Open/High/Low/Close per bar + Volume + Turnover. So this adapter emits true OHLCV.
// Numeric fields arrive as strings, some thousands-separated ("13,488,558") — num() strips commas.
//
// ── META-CARRIED VENUE + TICKER ──────────────────────────────────────────────────────────────────
// The JSON body carries the Symbol but we STAMP meta.venue + meta.ticker on the FetchResult (venue =
// ctx.source.venue = 'MSX'; ticker = the RAW symbol requested) so the PURE parser recovers venue/ticker
// from snapshot.meta — never from a live DB lookup. The snapshot store round-trips FetchResult.meta →
// StoredSnapshot.meta (exactly as adapters/mubasher/ohlcv-csv.ts does).
//
// ── natural_key COLLISION (deliberate) ───────────────────────────────────────────────────────────
// NormalizedOhlcv carries our venue (MSX) + RAW ticker + tradeDate, so runtime.mapOhlcv emits
//   OHLCV.CLOSE:MSX:{ticker}:{tradeDate}
// IDENTICAL to any MSX EOD-bulletin bar for the same day (CONTRACT §6.5). When such a second MSX
// OHLCV source lands, the two collide on the same natural_key and the 2-source cross-check fires.
//
// ── PURITY ───────────────────────────────────────────────────────────────────────────────────────
// parse() has no Date.now / Math.random / new Date: it converts the source's "Mmm DD, YYYY" date to
// ISO via a static month map (deterministic, replayable). Malformed / uncovered bytes yield zero rows
// (a PARSE_DRIFT signal on a CHANGED snapshot, CONTRACT §10) and NEVER throw. fetch() DOES use
// ctx.now() (impure, allowed) to bound the To date at today.

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
export const MSX_HISTORY_PARSER_VERSION = 2;

/** The six GCC venue codes (VenueCode is a closed union; guard meta.venue against it). */
const VENUE_CODES: ReadonlySet<string> = new Set<VenueCode>(['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB']);

/** Default bounded-fetch concurrency (single POST per symbol); clamped ≥1. */
const DEFAULT_FETCH_CONCURRENCY = 4;

/** Earliest From date — the endpoint clamps to each symbol's real IPO/earliest, so this is a floor. */
const DEFAULT_FROM_DATE = '1990-01-01';

/** The alt-provider discriminant carried on the FetchResult meta + endpoint_config. */
const PROVIDER = 'msx-summary';

/** Static month-name → 2-digit month map for the source's "Mmm DD, YYYY" date (pure, replayable). */
const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "Jul 14, 2026" → "2026-07-14"; anything else → null (skips header/garbage/intraday). */
function toIsoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mm = MONTHS[m[1] as string];
  if (!mm) return null;
  return `${m[3]}-${mm}-${(m[2] as string).padStart(2, '0')}`;
}

/** One raw daily row as returned by summary-report.aspx/List. */
interface MsxListRow {
  DateEn?: unknown; // 'Mmm DD, YYYY'
  Date?: unknown; // same, fallback
  Open?: unknown;
  High?: unknown;
  Low?: unknown;
  Close?: unknown; // the daily close (NOT NULL requirement)
  Volume?: unknown; // thousands-separated string
  Turnover?: unknown; // thousands-separated string
}

interface MsxHistoryConfig {
  urlTemplate?: string; // '.../summary-report.aspx/List'
  headers?: Record<string, string>;
  fromDate?: string; // From bound (default DEFAULT_FROM_DATE)
  timeoutMs?: number;
  fetch_concurrency?: number;
  symbols?: unknown; // string[] injected by the runtime from public.securities (RAW MSX tickers)
}

/**
 * Finite-number guard for a value that may arrive as a comma-grouped string ("13,488,558"), a plain
 * string ("0.3980"), or a number: empty / '-' / non-finite → null; keeps a genuine 0. The DB columns
 * are nullable (except close, handled by the caller), so we never emit NaN.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE parser: verbatim JSON snapshot bytes of ONE ticker's full history → NormalizedOhlcv[] (one row
 * per DAILY bar). venue + ticker are recovered from snapshot.meta (stamped by fetch), NOT from the
 * bytes. A row with a null close is skipped — ohlcv_daily.close is NOT NULL (CONTRACT §6.3). A row
 * whose date does not parse as "Mmm DD, YYYY" is skipped. Any throw → zero rows (never hard-throw):
 * a CHANGED-but-unparseable snapshot surfaces as PARSE_DRIFT upstream, not a crash. No Date.now().
 */
export function parseMsxHistory(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const parserVersion = MSX_HISTORY_PARSER_VERSION;
  try {
    const meta = snapshot.meta ?? {};
    const ticker = typeof meta.ticker === 'string' ? meta.ticker.trim() : '';
    const venueRaw = typeof meta.venue === 'string' ? meta.venue.trim() : '';
    // No ticker ⇒ cannot resolve a security_id downstream; unknown venue ⇒ cannot key. Emit nothing.
    if (ticker === '' || !VENUE_CODES.has(venueRaw)) return { rows: [], parserVersion };
    const venue = venueRaw as VenueCode;

    const doc = JSON.parse(snapshot.body.toString('utf8')) as unknown;
    // ASP.NET ScriptService wraps the payload as {"d":[…]}; tolerate a bare array too.
    const arr = Array.isArray(doc)
      ? doc
      : Array.isArray((doc as { d?: unknown })?.d)
        ? (doc as { d: unknown[] }).d
        : null;
    if (arr === null) return { rows: [], parserVersion };

    const rows: NormalizedOhlcv[] = [];
    for (const raw of arr) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as MsxListRow;

      const tradeDate = toIsoDate(r.DateEn) ?? toIsoDate(r.Date);
      if (tradeDate === null) continue; // header / intraday / garbage line

      const close = num(r.Close);
      if (close === null) continue; // ohlcv_daily.close is NOT NULL — a null close cannot be a row.

      rows.push({
        venue,
        ticker, // RAW ticker → OHLCV.CLOSE natural_key collision with a future MSX venue EOD bar
        tradeDate,
        open: num(r.Open),
        high: num(r.High),
        low: num(r.Low),
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
 * One ticker's single POST → the JSON FetchResult, or null on ANY failure. PER-TICKER ISOLATION: a
 * ticker whose request throws or returns non-2xx returns null (logged, skipped) rather than throwing
 * — so it never aborts the MSX symbol sweep. venue + ticker are stamped on meta for the pure parser.
 */
async function fetchOneTicker(ctx: FetchContext, ticker: string): Promise<FetchResult | null> {
  const cfg = configOf(ctx);
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const headers = cfg.headers;
  const fetchedAt = ctx.now();
  const from = cfg.fromDate ?? DEFAULT_FROM_DATE;
  const to = fetchedAt.slice(0, 10); // today's venue-local YYYY-MM-DD (endpoint accepts ISO)
  const body = JSON.stringify({ Symbol: ticker, Type: 'D', From: from, To: to });

  let res;
  try {
    res = await ctx.http.request(url, {
      method: 'POST',
      body,
      ...(headers ? { headers } : {}),
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });
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
    // meta carries the venue + ticker the pure parser needs, plus lang + provenance for lineage.
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
 * fetch(): impure/transport. Plain HTTP POST (ctx.http.request) — msx.om/summary-report.aspx/List is
 * reachable from the VPS IP with a browser UA (Imperva-fronted but no auth/captcha). One POST per
 * symbol. Two paths, mirroring yahoo/ohlcv.ts and mubasher/ohlcv-csv.ts:
 *   - STREAMING (ctx.onFetched supplied): fetch tickers at bounded concurrency and push each JSON
 *     FetchResult to the sink the moment it lands — bars accrue progressively; a mid-sweep crash
 *     keeps everything already staged (fetch is idempotent). Returns [] (drained).
 *   - ARRAY (no sink — unit tests / direct callers): serial fetch → array of survivors.
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

/** The MSX summary-report full-OHLCV history backfill TaskSpec (routed by runtime.tasksForProvider). */
export const msxHistory: TaskSpec<NormalizedOhlcv> = {
  dataType: 'ohlcv_backfill',
  parserVersion: MSX_HISTORY_PARSER_VERSION,
  fetch: fetchMsxHistory,
  parse: parseMsxHistory,
};

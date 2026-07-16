// ingestion/src/adapters/bhb/ohlcv.ts
//
// BHB (Bahrain Bourse) ≥2-year EOD-CLOSE-history BACKFILL TaskSpec — the price backfill drain for BHB,
// the LAST of the three venues Yahoo does NOT cover (ADX=Mubasher 0033, MSX=native 0034, BHB=this).
// Config-driven: one seed row (migration 20260715101500) with provider='bhb_webapi', fanned over the
// BHB symbol universe. This is the DEF-BHB-OHLCV pickup — the owner's D-src-4 "coverage-gap" decision
// was parked ONLY until a BHB-reachable proxy existed; one now does (BHB-API-CONTRACT.md, 2026-07-15),
// so we mirror the ADX/MSX adapter shape exactly (provider discriminant + withInjectedSymbols branch).
//
// WHY A FIRST-CLASS BHB SOURCE (not Mubasher): BHB has NO Mubasher historical CSV, but its OWN webapi
// exposes a per-security date-range price export — one GET is the full close history:
//   GET https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter
//        ?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={from}&ToDateYear={to}
//   → {status:1, data:[ {"":"MM/DD/YYYY","Price":"   0.230"}, … ]}  (GFH 2020→2026 = 1476 rows; the year
//     dropdown offers 2000..2026 → full history from FromDateYear=2000).
//
// ── AUTH + EGRESS (reconciled 2026-07-16) ──────────────────────────────────────────────────────────
// This host is webapi.bahrainbourse.com — the SAME host as BHB quotes/filings, which proved live DIRECT
// from the VPS (the historical Cloudflare/geo-block is gone; id16 quotes runs use_proxy=false). So this
// backfill also runs DIRECT (use_proxy=false) — the metered residential proxy is reserved for hosts that
// genuinely cannot be reached direct (owner egress policy), and this one can. Auth is the dynamic
// `Authorization: Bearer <APIKey>` via the shared bhbWebapiGet helper (scrape the rotating PUBLIC homepage
// token → cache → re-scrape once on 401) — NOT a pinned endpoint_config token, which rotates several
// times/day and would 401 within hours. transport='http' (plain GET, no bootstrap/discovery needed).
//
// ── EOD CLOSE ONLY (explicit owner requirement) ────────────────────────────────────────────────────
// This feed is EOD CLOSE ONLY — NOT OHLCV. The response carries a date + a single Price (the close);
// there is no open/high/low/volume. We map close←Price and emit open/high/low/volume as NULL — we do
// NOT fabricate OHLC. This still clears the ≥2y daily-price requirement (01-ingestion.md exit criterion)
// and cross-checks the venue-official close against the live BHB webapi quote for the same day.
//
// ── DATE (already the local calendar date — no tz math) ────────────────────────────────────────────
// The response date is a bare MM/DD/YYYY (US-format) BHB-local calendar trade date. We convert it to
// the ISO 'YYYY-MM-DD' ohlcv_daily.trade_date shape by re-ordering the components — a PURE string
// rewrite, NO timezone arithmetic and NO Date construction (mirrors msx/history.ts, mubasher/ohlcv-csv.ts).
//
// ── META-CARRIED VENUE + TICKER ──────────────────────────────────────────────────────────────────
// The JSON body carries NO ticker and NO venue (rows are just {date, Price}), so fetch() STAMPS
// meta.venue + meta.ticker on the FetchResult (venue = ctx.source.venue = 'BHB'; ticker = the RAW symbol
// requested). The snapshot store round-trips FetchResult.meta → StoredSnapshot.meta (exactly as
// adapters/msx/history.ts and adapters/mubasher/ohlcv-csv.ts do), so the PURE parser recovers
// venue/ticker from snapshot.meta — never from the bytes.
//
// ── natural_key COLLISION (deliberate) ───────────────────────────────────────────────────────────
// NormalizedOhlcv carries our venue (BHB) + RAW ticker + tradeDate, so runtime.mapOhlcv emits
//   OHLCV.CLOSE:BHB:{ticker}:{tradeDate}
// IDENTICAL to the daily BHB webapi quote's OHLCV bar for the same day (CONTRACT §6.5). When both land,
// they collide on the same natural_key and the 2-source cross-check fires — which is the whole point of
// seeding this as the BHB backfill source of record now.
//
// ── PURITY ───────────────────────────────────────────────────────────────────────────────────────
// parse() has no Date.now / Math.random / new Date: the response date IS already the venue-local
// calendar date, so there is nothing to compute. status!=1 ({status:2,data:null,"No items found!"} for a
// delisted symbol / empty window) or malformed bytes yield zero rows (a PARSE_DRIFT signal on a CHANGED
// snapshot, CONTRACT §10) and NEVER throw. fetch() uses ctx.now() ONLY to compute ToDateYear (the
// current year) — the transport side, never the parser.

import type {
  FetchContext,
  FetchResult,
  NormalizedOhlcv,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from '../../core/types.js';
import { bhbWebapiGet, type BhbWebapiConfig } from './webapi.js';

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const BHB_OHLCV_PARSER_VERSION = 1;

/** The six GCC venue codes (VenueCode is a closed union; guard meta.venue against it). */
const VENUE_CODES: ReadonlySet<string> = new Set<VenueCode>(['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB']);

/** Default bounded-fetch concurrency (single GET per symbol); clamped ≥1. Modest — direct HTTP, but a
 *  41-symbol deep-history drain should not hammer the origin. */
const DEFAULT_FETCH_CONCURRENCY = 4;

/** Default earliest year to request when endpoint_config carries no fromYear (dropdown offers 2000..). */
const DEFAULT_FROM_YEAR = 2000;

/** The alt-provider discriminant carried on the FetchResult meta + endpoint_config. */
const PROVIDER = 'bhb_webapi';

/** One raw row as returned by DataExportCompanyProfile. The DATE key is the EMPTY STRING; Price is a
 *  space-padded string ("   0.230"). Modeled as an index signature so the '' key is representable. */
interface BhbExportRow {
  ''?: unknown; // 'MM/DD/YYYY' — the trade date (the JSON key is literally the empty string)
  Price?: unknown; // space-padded close, e.g. "   0.230"
}

interface BhbExportEnvelope {
  status?: unknown; // 1 = data; 2 (data:null, "No items found!") = empty window / delisted symbol
  data?: unknown; // BhbExportRow[] when status===1
}

interface BhbOhlcvConfig {
  urlTemplate?: string; // '.../GetTabularDataWithDateRangeFilter?...&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}'
  headers?: Record<string, string>;
  fetch_concurrency?: number;
  fromYear?: unknown; // earliest year to request (default 2000); toYear is computed from ctx.now()
  symbols?: unknown; // string[] injected by the runtime from public.securities (RAW BHB tickers)
}

/**
 * Finite-number guard for the space-padded Price ("   0.230") — trims, rejects empty / '-' / non-finite,
 * keeps a genuine 0. Also tolerates a JSON number, defensively. ohlcv_daily.close is NOT NULL (the
 * caller drops a null close), so we never emit NaN.
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
 * PURE MM/DD/YYYY → 'YYYY-MM-DD'. A string rewrite only (the date is ALREADY the BHB-local calendar
 * date — no timezone math, no Date construction). Returns null on any shape that is not two 1-2 digit
 * month/day fields and a 4-digit year, so a garbage / header row is skipped rather than mis-dated.
 */
export function toIsoTradeDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (!m) return null;
  const month = m[1]!.padStart(2, '0');
  const day = m[2]!.padStart(2, '0');
  const year = m[3]!;
  return `${year}-${month}-${day}`;
}

/**
 * PURE parser: verbatim JSON snapshot bytes of ONE symbol's DataExportCompanyProfile response →
 * NormalizedOhlcv[] (one row per EOD close). venue + ticker are recovered from snapshot.meta (stamped by
 * fetch), NOT from the bytes (the rows are just {date, Price}).
 *
 * status!=1 (the {status:2,data:null,"No items found!"} empty-window / delisted response) → zero rows,
 * NO throw — that symbol simply yields nothing (per-symbol isolation upstream already skipped nothing;
 * here the empty payload is a legitimate outcome). A row whose Price is null/blank is skipped —
 * ohlcv_daily.close is NOT NULL (CONTRACT §6.3). A row whose date is not MM/DD/YYYY is skipped.
 * open/high/low/volume are ALWAYS emitted NULL: this feed is EOD-CLOSE-ONLY (explicit owner requirement)
 * — we do NOT fabricate OHLC. Any throw → zero rows (never hard-throw): a CHANGED-but-unparseable
 * snapshot surfaces as PARSE_DRIFT upstream, not a crash. No Date.now() — replayable.
 */
export function parseBhbOhlcv(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const parserVersion = BHB_OHLCV_PARSER_VERSION;
  try {
    const meta = snapshot.meta ?? {};
    const ticker = typeof meta.ticker === 'string' ? meta.ticker.trim() : '';
    const venueRaw = typeof meta.venue === 'string' ? meta.venue.trim() : '';
    // No ticker ⇒ cannot resolve a security_id downstream; unknown venue ⇒ cannot key. Emit nothing
    // (rather than mis-attribute) — matches the msx/mubasher/yahoo OHLCV guards.
    if (ticker === '' || !VENUE_CODES.has(venueRaw)) return { rows: [], parserVersion };
    const venue = venueRaw as VenueCode;

    const doc = JSON.parse(snapshot.body.toString('utf8')) as BhbExportEnvelope;
    // status:2 (data:null, "No items found!") or any non-1 status → empty (delisted / empty window).
    // Number(...) tolerates the numeric-or-string status the webapi may send.
    if (Number(doc?.status) !== 1) return { rows: [], parserVersion };
    const data = doc?.data;
    if (!Array.isArray(data)) return { rows: [], parserVersion };

    const rows: NormalizedOhlcv[] = [];
    for (const raw of data) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as BhbExportRow;

      const tradeDate = toIsoTradeDate(r['']);
      if (tradeDate === null) continue; // not a MM/DD/YYYY row (garbage / header) — skip, never mis-date.

      const close = num(r.Price);
      if (close === null) continue; // ohlcv_daily.close is NOT NULL — a null/blank close cannot be a row.

      rows.push({
        venue,
        ticker, // RAW ticker → OHLCV.CLOSE natural_key collision with the live BHB venue OHLCV bar
        tradeDate,
        // EOD-CLOSE-ONLY feed (owner requirement): open/high/low/volume are NEVER present — never fabricated.
        open: null,
        high: null,
        low: null,
        close,
        volume: null,
      });
    }
    return { rows, parserVersion };
  } catch {
    return { rows: [], parserVersion };
  }
}

/** endpoint_config accessor (local cast — the frozen EndpointConfig surface stays untouched). */
function configOf(ctx: FetchContext): BhbOhlcvConfig {
  return ctx.source.endpointConfig as unknown as BhbOhlcvConfig;
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

/** Earliest request year from endpoint_config.fromYear (default 2000, clamped ≥1). */
function fromYear(ctx: FetchContext): number {
  const raw = configOf(ctx).fromYear;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FROM_YEAR;
}

/**
 * The 4-digit calendar YEAR of an ISO-8601 instant, WITHOUT constructing a Date (keeps fetch trivially
 * deterministic under the injected ctx.now()). ctx.now() is 'YYYY-…' so the leading 4 chars are the
 * year. Falls back to DEFAULT_FROM_YEAR's era only if the string is malformed (never happens for
 * ctx.now(), but keeps the URL well-formed regardless).
 */
function yearOfIso(nowIso: string): number {
  const m = /^(\d{4})/.exec(nowIso);
  const n = m ? Number.parseInt(m[1]!, 10) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_FROM_YEAR;
}

/**
 * Build the per-symbol date-range URL from the config template. Substitutes {symbol} (RAW ticker),
 * {fromYear} (endpoint_config.fromYear, default 2000) and {toYear} (the current year from ctx.now()).
 */
function buildUrl(template: string, symbol: string, from: number, to: number): string {
  return template
    .replace(/\{symbol\}/g, encodeURIComponent(symbol))
    .replace(/\{fromYear\}/g, String(from))
    .replace(/\{toYear\}/g, String(to));
}

/**
 * One symbol's single GET → the JSON FetchResult, or null on ANY failure. PER-SYMBOL ISOLATION: a
 * symbol whose request throws or returns non-2xx returns null (logged, skipped) rather than throwing —
 * so one bad symbol never aborts the ~41-symbol BHB sweep. venue + ticker are stamped on meta for the
 * pure parser (the JSON body carries neither). A status:2 "No items found!" body is still a 200 → it is
 * returned and the parser yields zero rows for it (an empty history, not an error).
 */
async function fetchOneSymbol(ctx: FetchContext, symbol: string, from: number, to: number): Promise<FetchResult | null> {
  const cfg = configOf(ctx);
  const template = cfg.urlTemplate ?? ctx.source.entryUrl;
  const fetchedAt = ctx.now();
  const url = buildUrl(template, symbol, from, to);

  let res;
  try {
    // Dynamic APIKey Bearer (shared with quotes/filings): scrape the rotating PUBLIC homepage token →
    // cache in-process (one token serves the whole 41-symbol sweep) → re-scrape once on a 401. Direct
    // egress — no proxy. bhbWebapiGet throws only when NO key can be obtained at all (caught below).
    res = await bhbWebapiGet(ctx, url, cfg as unknown as BhbWebapiConfig);
  } catch (err) {
    ctx.logger?.warn('bhb ohlcv: symbol fetch failed, skipping', {
      symbol,
      err: String(err).slice(0, 140),
    });
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    ctx.logger?.warn('bhb ohlcv: non-2xx, skipping symbol', { symbol, status: res.status });
    return null;
  }

  return {
    externalId: symbol,
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
      ticker: symbol,
      lang: 'en',
      delayed: true,
    },
  };
}

/**
 * Run `worker` over `items` with at most `size` outstanding at once (worker-pool; same shape as
 * yahoo/ohlcv.ts, mubasher/ohlcv-csv.ts and msx/history.ts runPool). fetchOneSymbol never throws
 * (per-symbol isolation is inside it), so a lane only ends by exhausting the cursor.
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
 * fetch(): impure/transport. Plain HTTP (ctx.http), DIRECT egress (use_proxy=false — the webapi host is
 * reachable direct from the VPS, proven by the same-host quotes source), authed with the dynamic APIKey
 * Bearer via bhbWebapiGet. One GET per symbol of the full date range (FromDateYear=2000 →
 * ToDateYear=current year, the latter from ctx.now()). Two paths, mirroring yahoo/ohlcv.ts,
 * mubasher/ohlcv-csv.ts and msx/history.ts exactly:
 *   - STREAMING (ctx.onFetched supplied): fetch symbols at bounded concurrency
 *     (endpoint_config.fetch_concurrency, default 4) and push each JSON FetchResult to the sink the
 *     moment it lands — the runtime snapshots + parses + stages it immediately, so bars accrue
 *     progressively and a mid-sweep crash keeps everything already staged (fetch is idempotent).
 *     Returns [] (drained).
 *   - ARRAY (no sink — unit tests / any direct caller): serial fetch → array of survivors, same
 *     per-symbol isolation.
 */
export async function fetchBhbOhlcv(ctx: FetchContext): Promise<FetchResult[]> {
  const targets = symbolsFromConfig(ctx);
  const from = fromYear(ctx);
  const to = yearOfIso(ctx.now()); // ToDateYear = current year (transport-side clock only; parse stays pure)

  if (ctx.onFetched) {
    const sink = ctx.onFetched;
    await runPool(targets, fetchConcurrency(ctx), async (symbol) => {
      const fr = await fetchOneSymbol(ctx, symbol, from, to);
      if (fr) await sink(fr);
    });
    return [];
  }

  const out: FetchResult[] = [];
  for (const symbol of targets) {
    const fr = await fetchOneSymbol(ctx, symbol, from, to);
    if (fr) out.push(fr);
  }
  return out;
}

/** The BHB webapi EOD-close-history backfill TaskSpec (routed by runtime.tasksForProvider for bhb_webapi). */
export const bhbOhlcvBackfill: TaskSpec<NormalizedOhlcv> = {
  dataType: 'ohlcv_backfill',
  parserVersion: BHB_OHLCV_PARSER_VERSION,
  fetch: fetchBhbOhlcv,
  parse: parseBhbOhlcv,
};

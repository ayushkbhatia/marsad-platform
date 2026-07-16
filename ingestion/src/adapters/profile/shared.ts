// ingestion/src/adapters/profile/shared.ts
//
// Shared, CONFIG-DRIVEN securities-profile machinery (07 §3.3/§P1.7e-I). One helper set that every
// venue's profile TaskSpec reuses: a per-symbol fetch loop + a PURE fieldMap parser that emits
// NormalizedProfile[] (venue/ticker/sector/isin/sharesOutstanding). Fills the three currently-empty
// public.securities identity columns the ratio + Score engines are blocked on.
//
// ── CONFIG-DRIVEN (the ADX-quotes pattern, CONTRACT §0.6) ───────────────────────────────────────
// The exact JSON field NAMES + PATHS each venue's profile endpoint uses are pinned in
// endpoint_config.profileFieldMap (dotted paths), copied onto snapshot.meta.profileFieldMap by the
// fetch. So the parser stays PURE + replayable and a venue field rename is a DATA FIX (edit the
// source row), not a code deploy — exactly like adapters/adx/quotes.ts fieldMap. The DEFAULT maps
// below are best-effort from the documented shapes (07 §2.2); the REAL map + a golden fixture are
// pinned on the first VPS capture (the sources ship active=false until then — see the seed migration).
//
// ── PER-SYMBOL (one company per snapshot) ───────────────────────────────────────────────────────
// A profile endpoint is per-company: fetch() iterates the RAW listed tickers injected into
// endpoint_config.symbols by the runtime (withProfileSymbols — only securities WHERE
// profile_scraped_at IS NULL, chunked), GETs urlTemplate.replace({symbol}) per ticker, and stamps
// meta.venue + meta.ticker + meta.profileFieldMap so the PURE parser recovers identity from meta (the
// body may not carry our venue/ticker). Per-ticker isolation: one 404/garbage company never aborts
// the chunk. Streams via ctx.onFetched when present (progressive staging), else returns an array.
//
// ── PURITY ──────────────────────────────────────────────────────────────────────────────────────
// parse() has no I/O, no Date.now: it reads the stored bytes + meta only. An unmappable sector string
// lands as sector='Unclassified' (mapSectorToTaxonomy) with the raw string kept in rawSector — a
// LOGGED fallback (runtime.mapProfile logs it), never a silent 'unknown'. An all-null profile (no
// sector, isin, or shares recoverable) yields ZERO rows so nothing empty is staged.

import type {
  FetchContext,
  FetchResult,
  NormalizedProfile,
  ParseResult,
  StoredSnapshot,
  VenueCode,
} from '../../core/types.js';
import { mapSectorToTaxonomy } from '../../lake/sector-taxonomy.js';

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const PROFILE_PARSER_VERSION = 1;

const VENUE_CODES: ReadonlySet<string> = new Set<VenueCode>(['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB']);
const DEFAULT_FETCH_CONCURRENCY = 4;

/**
 * Where each of the profile facts lives in a venue's company JSON. Every value is a dotted path
 * (a.b.c) resolved against the company object (or the whole doc when `rowsPath` is unset). Only the
 * facts a venue actually exposes need a path; an absent path ⇒ that fact is null (never guessed).
 */
export interface ProfileFieldMap {
  /** Dotted path to the company object node inside the response (default: the doc root). */
  rowsPath?: string;
  sector?: string;
  industry?: string;
  isin?: string;
  shares?: string;
  /** Multiply the raw shares value — e.g. 1e6 when a venue reports "shares (millions)". Default 1. */
  sharesMultiplier?: number;
  /** Optional: the doc's own symbol field, checked against meta.ticker as a defensive mis-map guard. */
  symbol?: string;
}

interface ProfileConfig {
  urlTemplate?: string;
  headers?: Record<string, string>;
  fetch_concurrency?: number;
  profileFieldMap?: ProfileFieldMap;
  symbols?: unknown; // string[] injected by the runtime (RAW listed tickers)
}

/** Resolve a dotted path (`a.b.c`) against an object; undefined if any hop is missing. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj; // empty path ⇒ the node itself (rowsPath default = doc root)
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Trim to a non-empty string, else null. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Parse a shares-outstanding value → finite number (× multiplier), else null. Handles the comma-grouped
 * string venues serve ("2,516,431,000"), a plain number, and a `sharesMultiplier` for millions/thousands
 * reporting. A genuine 0 is dropped (a 0-share company is bad data, not a fact); non-finite ⇒ null.
 */
export function profileShares(v: unknown, multiplier = 1): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = Number.isFinite(v) ? v : null;
  else if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').replace(/[^0-9.eE+-]/g, '').trim();
    if (cleaned !== '' && cleaned !== '-' && cleaned !== '.') {
      const parsed = Number(cleaned);
      n = Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (n === null) return null;
  const out = n * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1);
  return Number.isFinite(out) && out > 0 ? out : null;
}

/**
 * PURE. Map one company doc (+ its meta identity + fieldMap) → NormalizedProfile, or null when the
 * doc carries NONE of sector/isin/shares (nothing worth staging). sector is ALWAYS set (the taxonomy
 * mapper yields 'Unclassified' at worst) BUT a doc with only an unmappable sector and no isin/shares
 * still counts as "has a fact" (we learned its raw sector) — so it stages with sector + rawSector.
 */
export function mapProfileDoc(
  doc: unknown,
  fm: ProfileFieldMap,
  venue: VenueCode,
  ticker: string,
): NormalizedProfile | null {
  const node = getPath(doc, fm.rowsPath);
  if (node === null || node === undefined || typeof node !== 'object') return null;

  const rawSectorStr = str(getPath(node, fm.sector));
  const isin = str(getPath(node, fm.isin));
  const shares = profileShares(getPath(node, fm.shares), fm.sharesMultiplier ?? 1);
  const industry = str(getPath(node, fm.industry));

  // Nothing usable at all ⇒ stage nothing (never write an empty profile).
  if (rawSectorStr === null && isin === null && shares === null) return null;

  const mapping = mapSectorToTaxonomy(rawSectorStr);
  return {
    venue,
    ticker,
    sector: mapping.sector,
    rawSector: mapping.rawSector,
    isin,
    sharesOutstanding: shares,
    industry,
  };
}

/**
 * PURE parser: verbatim company-JSON snapshot bytes of ONE ticker → NormalizedProfile[] (0 or 1 row).
 * venue + ticker + fieldMap are recovered from snapshot.meta (stamped by fetch). Unknown venue/ticker,
 * non-JSON bytes, or an all-null profile ⇒ zero rows (never throw — a CHANGED-but-unparseable snapshot
 * surfaces as PARSE_DRIFT upstream, not a crash). No Date.now() — replayable.
 */
export function parseProfileDoc(snapshot: StoredSnapshot): ParseResult<NormalizedProfile> {
  const parserVersion = PROFILE_PARSER_VERSION;
  try {
    const meta = snapshot.meta ?? {};
    const ticker = typeof meta.ticker === 'string' ? meta.ticker.trim() : '';
    const venueRaw = typeof meta.venue === 'string' ? meta.venue.trim() : '';
    if (ticker === '' || !VENUE_CODES.has(venueRaw)) return { rows: [], parserVersion };
    const venue = venueRaw as VenueCode;
    const fm = (meta.profileFieldMap as ProfileFieldMap | undefined) ?? {};

    let obj: unknown;
    try {
      obj = JSON.parse(snapshot.body.toString('utf8'));
    } catch {
      return { rows: [], parserVersion };
    }
    const row = mapProfileDoc(obj, fm, venue, ticker);
    return { rows: row ? [row] : [], parserVersion };
  } catch {
    return { rows: [], parserVersion };
  }
}

// ── fetch helpers ──────────────────────────────────────────────────────────────────────────────

function configOf(ctx: FetchContext): ProfileConfig {
  return ctx.source.endpointConfig as unknown as ProfileConfig;
}

/** RAW listed-ticker list from endpoint_config.symbols (injected by the runtime; see runtime.ts). */
export function profileSymbols(ctx: FetchContext): string[] {
  const raw = configOf(ctx).symbols;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  }
  return [];
}

function fetchConcurrency(ctx: FetchContext): number {
  const raw = configOf(ctx).fetch_concurrency;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FETCH_CONCURRENCY;
}

/** Bounded worker pool (mirrors mubasher/ohlcv-csv.ts runPool). `worker` never throws (isolation inside). */
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

/** The FetchResult meta shape the pure parser reads back (venue/ticker/fieldMap + provenance). */
function profileMeta(ctx: FetchContext, ticker: string): Record<string, unknown> {
  return {
    dataType: 'securities_profile',
    venue: ctx.source.venue,
    ticker,
    profileFieldMap: configOf(ctx).profileFieldMap ?? {},
    lang: 'en',
  };
}

/**
 * One ticker's profile GET (plain http) → FetchResult, or null on ANY failure (per-ticker isolation).
 * Used by the plain-HTTP venues (Mubasher/MSX/QE/DFM). urlTemplate.replace({symbol}) is the per-company
 * profile URL; headers + timeout come from endpoint_config.
 */
export async function fetchOneProfileHttp(ctx: FetchContext, ticker: string): Promise<FetchResult | null> {
  const cfg = configOf(ctx);
  const tmpl = cfg.urlTemplate ?? ctx.source.entryUrl;
  const url = tmpl.replace(/\{symbol\}/g, encodeURIComponent(ticker));
  const fetchedAt = ctx.now();
  try {
    const res = await ctx.http.get(url, cfg.headers ? { headers: cfg.headers } : {});
    if (res.status < 200 || res.status >= 300) {
      ctx.logger?.warn('profile: non-2xx, skipping ticker', { venue: ctx.source.venue, ticker, status: res.status });
      return null;
    }
    return {
      externalId: ticker,
      url: res.url,
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt,
      meta: profileMeta(ctx, ticker),
    };
  } catch (err) {
    ctx.logger?.warn('profile: fetch failed, skipping ticker', {
      venue: ctx.source.venue,
      ticker,
      err: String(err).slice(0, 140),
    });
    return null;
  }
}

/**
 * Plain-HTTP per-symbol profile fetch (Mubasher/MSX/QE/DFM). Streams via ctx.onFetched when supplied
 * (progressive staging), else returns an array. Bounded concurrency; per-ticker isolation.
 */
export async function fetchProfilesHttp(ctx: FetchContext): Promise<FetchResult[]> {
  const targets = profileSymbols(ctx);
  if (ctx.onFetched) {
    const sink = ctx.onFetched;
    await runPool(targets, fetchConcurrency(ctx), async (ticker) => {
      const fr = await fetchOneProfileHttp(ctx, ticker);
      if (fr) await sink(fr);
    });
    return [];
  }
  const out: FetchResult[] = [];
  for (const ticker of targets) {
    const fr = await fetchOneProfileHttp(ctx, ticker);
    if (fr) out.push(fr);
  }
  return out;
}

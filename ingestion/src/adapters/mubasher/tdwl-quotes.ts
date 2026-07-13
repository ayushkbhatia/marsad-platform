// ingestion/src/adapters/mubasher/tdwl-quotes.ts
//
// Mubasher-backed TDWL (Saudi Exchange / Tadawul) quotes TaskSpec.
//
// WHY MUBASHER (owner hybrid decision, GROUND TRUTH #3): the official saudiexchange.sa portal is
// Akamai-IP-blocked for every IP we can reach it from (datacenter + residential), so the direct
// TDWL http_bootstrap path (adapters/tdwl/quotes.ts, kept parked) cannot run in production. The
// Mubasher aggregator (english.mubasher.info) republishes DELAYED Saudi (TDWL) quotes and is
// reachable from the plain VPS IP with NO proxy and NO WAF bootstrap — so this task uses plain
// `http` transport (ctx.http), not the BrowserClient.
//
// TRANSPORT: `http`. The market board is a single JSON document — one GET returns the whole market.
//   Discovery (GROUND TRUTH): GET https://english.mubasher.info/api/1/stocks/prices?country=sa
//   → { "lastUpdate": "YYYY-MM-DD HH:MM:SS", "prices": [ {row}, ... ] }, content-type
//   application/json;charset=UTF-8, ~387 TDWL rows. The URL is CONFIG (ctx.source.endpointConfig),
//   never hardcoded here — this adapter knows only the response *shape*.
//
// fetch  = impure/transport: one GET of the board. Snapshot-first is the worker's job; fetch()
//          only returns the raw bytes verbatim in a FetchResult.
// parse  = PURE: snapshot bytes → NormalizedQuote[]. No I/O, no Date.now(), replayable. Golden-
//          tested against ingestion/fixtures/mubasher/tdwl-quotes.json.
//
// FIELD SHAPE (GROUND TRUTH — all numeric fields are STRINGS; prices/turnover/volume use commas as
// thousands separators → strip commas before parseFloat):
//   exchange           "TDWL"                         (venue guard)
//   code               "2222"                         → ticker (numeric ticker string)
//   name               "SAUDI ARAMCO"                 (ignored — resolved downstream by ticker)
//   value              "26.50"                        → last
//   change             "-0.28"                        → change
//   changePercentage   "-1.05%"                       → changePct (strip %)
//   open/high/low      "26.78"/"26.78"/"26.50"        → open/high/low
//   volume             "6,549,051"                    → volume (strip commas)
//   turnover           "174,585,242.96"               (value traded — not on NormalizedQuote v1)
//   status             "up"|"down"|"flat"             (ignored)
//   updatedAt          "2026-07-13 12:19:09"          → per-row as_of (see asOf note)
//   (top-level) lastUpdate "2026-07-13 15:30:00"      → feed timestamp / as_of fallback

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  VenueCode,
  TaskSpec,
} from "../../core/types.js";

const VENUE: VenueCode = "TDWL";

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const MUBASHER_TDWL_QUOTES_PARSER_VERSION = 1;

/** One row of the Mubasher /stocks/prices board. Every numeric field arrives as a STRING. */
export interface MubasherPriceRow {
  exchange?: string | null; // "TDWL"
  name?: string | null;
  url?: string | null; // "/markets/TDWL/stocks/2222"
  code?: string | null; // numeric ticker, e.g. "2222" → ticker
  value?: string | null; // last price
  change?: string | null;
  changePercentage?: string | null; // "12.71%" (may carry a trailing %)
  turnover?: string | null; // comma-grouped value traded
  open?: string | null;
  high?: string | null;
  low?: string | null;
  volume?: string | null; // comma-grouped
  status?: string | null; // "up"|"down"|"flat"
  chartFileUrl?: string | null;
  updatedAt?: string | null; // "YYYY-MM-DD HH:MM:SS" per-row print time
}

export interface MubasherBoard {
  lastUpdate?: string | null; // top-level feed timestamp "YYYY-MM-DD HH:MM:SS"
  prices?: MubasherPriceRow[] | null;
}

/**
 * Parse a Mubasher numeric string. All values are strings; prices/turnover/volume carry comma
 * thousands separators and changePercentage carries a trailing '%'. Strip commas, %, and whitespace,
 * then parse. Returns null for absent/blank/non-finite input (never NaN — DB columns are nullable).
 * Keeps genuine zeros and genuine negatives (change/changePercentage are legitimately signed).
 */
export function parseMubasherNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/,/g, "").replace(/%/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "+" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a Mubasher wall-clock timestamp "YYYY-MM-DD HH:MM:SS" to an ISO-8601 UTC instant.
 * Mubasher prints Saudi local time (AST = UTC+3, no DST) with no zone suffix, so subtract 3h.
 * Pure — parses the literal only, no Date.now(). Returns null on unparseable input (the writer then
 * falls back to captured_at for as_of).
 */
export function parseMubasherTimestampToUtc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const year = Number(y);
  const mon = Number(mo) - 1; // 0-based month
  const day = Number(d);
  const hour = Number(h);
  const min = Number(mi);
  const sec = se ? Number(se) : 0;
  if (mon < 0 || mon > 11 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) return null;
  const AST_OFFSET_MS = 3 * 60 * 60 * 1000; // AST is UTC+3, no DST
  const utcMs = Date.UTC(year, mon, day, hour, min, sec) - AST_OFFSET_MS;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

/**
 * Map one Mubasher board row → NormalizedQuote. Rows with no usable ticker (`code`) are dropped by
 * the caller (they cannot resolve a security_id downstream). `boardAsOf` is the parsed top-level
 * feed timestamp, used as the as_of fallback when a row omits/mis-formats its own updatedAt.
 */
export function mapMubasherRow(
  row: MubasherPriceRow,
  boardAsOf: string | null,
): NormalizedQuote | null {
  const code = typeof row.code === "string" ? row.code.trim() : row.code != null ? String(row.code).trim() : "";
  if (code === "") return null; // no natural key → cannot resolve security_id

  // as_of = exchange delayed print time. Prefer the per-row updatedAt, fall back to the board
  // feed timestamp, else '' (writer stamps captured_at). All are AST wall-clock → converted to UTC.
  const asOf = parseMubasherTimestampToUtc(row.updatedAt) ?? boardAsOf ?? "";

  return {
    venue: VENUE,
    ticker: code,
    last: parseMubasherNumber(row.value),
    change: parseMubasherNumber(row.change),
    changePct: parseMubasherNumber(row.changePercentage),
    open: parseMubasherNumber(row.open),
    high: parseMubasherNumber(row.high),
    low: parseMubasherNumber(row.low),
    volume: parseMubasherNumber(row.volume),
    asOf,
  };
}

/**
 * PURE parser: verbatim snapshot bytes → NormalizedQuote[]. Filters to TDWL rows (the endpoint is
 * queried with country=sa so every row is already TDWL, but we guard on exchange defensively).
 * Zero rows on a CHANGED snapshot ⇒ the harness flags PARSE_DRIFT (CONTRACT §10). Throws on
 * non-JSON / wrong-shape bytes so the harness records status='error' (a hard drift), distinct from
 * an empty-but-valid board.
 */
export function parseMubasherTdwlQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  const text = snapshot.body.toString("utf8");
  let doc: MubasherBoard;
  try {
    doc = JSON.parse(text) as MubasherBoard;
  } catch (err) {
    throw new Error(
      `Mubasher TDWL quotes parse: snapshot ${snapshot.snapshotId} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.prices)) {
    throw new Error(
      `Mubasher TDWL quotes parse: snapshot ${snapshot.snapshotId} missing top-level {prices:[...]} array`,
    );
  }

  const boardAsOf = parseMubasherTimestampToUtc(doc.lastUpdate);
  const rows: NormalizedQuote[] = [];
  for (const raw of doc.prices) {
    if (raw === null || typeof raw !== "object") continue;
    // Defensive venue guard: the source is TDWL-only (country=sa), but drop any stray non-TDWL row.
    const ex = typeof raw.exchange === "string" ? raw.exchange.trim().toUpperCase() : "";
    if (ex !== "" && ex !== VENUE) continue;
    const q = mapMubasherRow(raw, boardAsOf);
    if (q !== null) rows.push(q);
  }
  return { rows, parserVersion: MUBASHER_TDWL_QUOTES_PARSER_VERSION };
}

/**
 * fetch(): impure/transport. Plain HTTP (ctx.http) — Mubasher is reachable from the VPS IP with no
 * WAF/proxy. URL/method/headers come ENTIRELY from source.endpointConfig (config over code,
 * CONTRACT §0.6); this adapter knows only the shape (one GET returns the whole board). meta records
 * lang + provenance so the pure parser and lineage carry the delayed/EN context.
 */
export async function fetchMubasherTdwlQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const res = await ctx.http.get(url, cfg.headers ? { headers: cfg.headers } : {});
  return [
    {
      url: res.url,
      contentType: res.headers["content-type"] ?? "application/json",
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: VENUE, dataType: "quotes", lang: "en", source: "mubasher", delayed: true },
    },
  ];
}

/**
 * The Mubasher-backed TDWL quotes TaskSpec. This is what the TDWL VenueAdapter's `quotes` slot
 * resolves to in production (adapters/tdwl/quotes.ts re-exports it as `tdwlQuotes`).
 */
export const mubasherTdwlQuotes: TaskSpec<NormalizedQuote> = {
  dataType: "quotes",
  parserVersion: MUBASHER_TDWL_QUOTES_PARSER_VERSION,
  fetch: fetchMubasherTdwlQuotes,
  parse: parseMubasherTdwlQuotes,
};

// ingestion/src/adapters/adx/quotes.ts
//
// ADX (Abu Dhabi Securities Exchange) quotes TaskSpec — full board + FADGI index.
//
// Transport: http_bootstrap (Playwright request-context). adx.ae is WAF-fronted and returns 403 to
// plain HTTP even with a Googlebot UA (P1-recon-findings.md) — same class as TDWL. So fetch() uses
// ctx.browser and NEVER ctx.http.
//
// ENDPOINT DISCOVERY — TODO resolved on first VPS run. The recon doc did NOT pin ADX's market-data
// XHR path or its JSON field names, because both need a real browser session to observe. On the
// first VPS run the fetcher captures the board XHR via network_capture (page.on('response') matched
// against endpointConfig.actionDiscovery.responseUrlPattern) and the captured URL is written back to
// the ingest.sources row. The board's field names are ALSO unknown until then — so the parser is
// FULLY config-driven: endpointConfig.fieldMap maps ADX's actual field names onto NormalizedQuote,
// and is filled in from the captured golden. This keeps the parser PURE and replayable, and makes
// "ADX renamed a field" a data fix (edit the source row) rather than a code deploy.
//
// parse() is PURE: JSON bytes + the source's fieldMap → NormalizedQuote[]. The fieldMap travels on
// snapshot.meta.fieldMap (the worker copies endpointConfig.fieldMap onto the FetchResult.meta so the
// pure parser has it without re-reading ingest.sources). Golden-tested against a synthetic fixture
// exercising the config-driven mapping; hardened against the real golden on the VPS.

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from "../../core/types.js";

const VENUE: VenueCode = "ADX";
export const ADX_QUOTES_PARSER_VERSION = 1;

/**
 * Maps ADX's actual JSON field names → NormalizedQuote fields. Each value is the source key (or a
 * dotted path a.b.c) in an ADX board row. Filled from the captured golden and stored in
 * ingest.sources.endpoint_config.fieldMap. Only `symbol` is required; missing optionals map to null.
 */
export interface AdxFieldMap {
  symbol: string; // → ticker (required)
  last?: string;
  change?: string;
  changePct?: string;
  open?: string;
  high?: string;
  low?: string;
  prevClose?: string; // used to derive change/changePct when the board omits them
  volume?: string;
  bid?: string;
  ask?: string;
  asOf?: string; // exchange delayed print time field (ISO or epoch ms or a wall-clock string)
  /** How the rows array is located in the response: a dotted path, default "data". */
  rowsPath?: string;
  /** as_of value kind so the pure parser can normalize it. Default 'iso'. */
  asOfKind?: "iso" | "epoch_ms" | "epoch_s";
}

// A sensible default map matching the DFM-like shape the ADX board is EXPECTED to resemble
// (recon: "ADX's board JSON is expected to resemble DFM's"). Overridden by the real captured map.
const DEFAULT_FIELD_MAP: AdxFieldMap = {
  rowsPath: "data",
  symbol: "symbol",
  last: "last",
  change: "change",
  changePct: "changePercent",
  open: "open",
  high: "high",
  low: "low",
  prevClose: "previousClose",
  volume: "volume",
  bid: "bid",
  ask: "ask",
  asOf: "timestamp",
  asOfKind: "iso",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/** Resolve a dotted path (`a.b.c`) against an object; undefined if any hop is missing. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function adxNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s%]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize the ADX as_of value (iso string, epoch ms, or epoch s) to ISO-8601 UTC, or "". */
export function adxAsOfToUtc(v: unknown, kind: AdxFieldMap["asOfKind"]): string {
  if (v === null || v === undefined) return "";
  if (kind === "epoch_ms" || kind === "epoch_s") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return "";
    const ms = kind === "epoch_s" ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  // iso / wall-clock string
  const s = String(v).trim();
  if (s === "") return "";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Build FetchOptions without an explicit `undefined` headers key (exactOptionalPropertyTypes).
 *  Shared by the ADX quotes/filings/eod fetchers. */
export function browserOpts(
  headers: Record<string, string> | undefined,
  timeoutMs = 20_000,
): { headers?: Record<string, string>; timeoutMs: number } {
  return headers ? { headers, timeoutMs } : { timeoutMs };
}

/** Map one ADX row via the field map → NormalizedQuote (null if no usable symbol). */
export function mapAdxRow(
  row: Record<string, unknown>,
  fm: AdxFieldMap,
): NormalizedQuote | null {
  const symRaw = getPath(row, fm.symbol);
  const ticker = typeof symRaw === "string" ? symRaw.trim() : symRaw != null ? String(symRaw).trim() : "";
  if (ticker === "") return null;

  const last = adxNumber(getPath(row, fm.last));
  const prevClose = adxNumber(getPath(row, fm.prevClose));
  let change = adxNumber(getPath(row, fm.change));
  let changePct = adxNumber(getPath(row, fm.changePct));
  if (change === null && last !== null && prevClose !== null) {
    change = round(last - prevClose, 6);
  }
  if (changePct === null && last !== null && prevClose !== null && prevClose !== 0) {
    changePct = round(((last - prevClose) / prevClose) * 100, 4);
  }

  return {
    venue: VENUE,
    ticker,
    last,
    change,
    changePct,
    open: adxNumber(getPath(row, fm.open)),
    high: adxNumber(getPath(row, fm.high)),
    low: adxNumber(getPath(row, fm.low)),
    volume: adxNumber(getPath(row, fm.volume)),
    asOf: adxAsOfToUtc(getPath(row, fm.asOf), fm.asOfKind ?? "iso"),
    bid: adxNumber(getPath(row, fm.bid)),
    ask: adxNumber(getPath(row, fm.ask)),
  };
}

/**
 * Pure parser. Reads the field map from snapshot.meta.fieldMap (worker copies it from the source
 * row), falling back to DEFAULT_FIELD_MAP. Locates the rows array by fm.rowsPath. Throws on
 * non-JSON / missing rows array (hard drift → parse-harness status='error').
 */
export function parseAdxQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  const text = snapshot.body.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `ADX quotes parse: snapshot ${snapshot.snapshotId} not valid JSON: ${(err as Error).message}`,
    );
  }
  const metaMap = (snapshot.meta?.fieldMap as Partial<AdxFieldMap> | undefined) ?? {};
  const fm: AdxFieldMap = { ...DEFAULT_FIELD_MAP, ...metaMap };

  const rowsRaw = getPath(doc, fm.rowsPath ?? "data");
  if (!Array.isArray(rowsRaw)) {
    throw new Error(
      `ADX quotes parse: snapshot ${snapshot.snapshotId} has no rows array at path '${fm.rowsPath ?? "data"}'`,
    );
  }
  const rows: NormalizedQuote[] = [];
  for (const raw of rowsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const q = mapAdxRow(raw as Record<string, unknown>, fm);
    if (q !== null) rows.push(q);
  }
  return { rows, parserVersion: ADX_QUOTES_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// fetch(): browser context. On the FIRST run the action URL is discovered via network_capture
// (endpointConfig.actionDiscovery.extract === 'network_capture', matched against
// responseUrlPattern) and BrowserClient.bootstrap returns the resolved URL. The fieldMap from the
// source config is copied onto FetchResult.meta so the pure parser has it.
// ---------------------------------------------------------------------------

async function fetchAdxBoard(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, logger, now } = ctx;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!discovery) {
    throw new Error(
      `ADX quotes fetch: source ${source.id} missing endpoint_config.actionDiscovery (network_capture) — cannot discover the board XHR`,
    );
  }
  const boot = await browser.bootstrap(discovery);
  logger.info("ADX board: resolved runtime board URL", { sourceId: source.id });
  // BrowserClient.get owns the WAF-challenge retry + typed FetchError on persistent failure.
  const resp = await browser.get(boot.resolvedUrl, browserOpts(source.endpointConfig.headers));

  const fieldMap =
    (source.endpointConfig as unknown as { fieldMap?: AdxFieldMap }).fieldMap ?? DEFAULT_FIELD_MAP;

  return [
    {
      url: resp.url,
      contentType: resp.headers["content-type"] ?? "application/json",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", fieldMap },
    },
  ];
}

export const adxQuotes: TaskSpec<NormalizedQuote> = {
  dataType: "quotes",
  parserVersion: ADX_QUOTES_PARSER_VERSION,
  fetch: fetchAdxBoard,
  parse: parseAdxQuotes,
};

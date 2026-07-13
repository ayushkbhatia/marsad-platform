// ingestion/src/adapters/tdwl/quotes.ts
//
// TDWL (Saudi Exchange / Tadawul) quotes TaskSpec — Main market + Nomu (parallel market).
//
// Transport: http_bootstrap (Playwright request-context). saudiexchange.sa is Akamai-WAF'd and
// returns 403 to any plain HTTP client (curl/undici) regardless of UA — confirmed in
// docs/architecture/P1-recon-findings.md. It loads under a real headless Chromium even from a
// datacenter IP. So fetch() uses ctx.browser (BrowserClient), NEVER ctx.http.
//
// Confirmed data path (recon §"TDWL — confirmed working data path"):
//   1. BrowserClient.bootstrap() navigates the market-watch entry page → seats Akamai _abck/bm_sz
//      cookies, then scrapes the datatable's AJAX action URL from the page at runtime (the
//      NJgetMainNomucMarketDetails action id + portal PUID are portal-generated → NEVER hardcoded;
//      they live in ingest.sources.endpoint_config.actionDiscovery and are resolved at run time).
//   2. context.request.get(resolvedUrl) fetches the full-market JSON through the SAME browser
//      context so the TLS/JA3 fingerprint matches the cookies (undici replay re-challenges — 01
//      Revisions #3). Response is clean JSON but arrives content-type text/html — parse anyway.
//   3. Snapshot-first: the raw JSON bytes are stored to ingest.raw_snapshots BEFORE parsing (the
//      snapshot store is invoked by the worker handler; fetch() only returns raw FetchResult[]).
//
// parse() is PURE: snapshot bytes in → NormalizedQuote[] out. No I/O, no Date.now(), no fetch.
// Golden-tested against ingestion/fixtures/tdwl/market-details.sample.json.
//
// CONFIG OVER CODE (CONTRACT §0.6). The confirmed TDWL board response only pins a handful of field
// names (acrynomName, lastTradePrice, bid/askPrice, transactionDate, lastUpdatetime — see
// P1-recon-findings.md). The OHLC / volume / change keys below are UNVERIFIED guesses baked into the
// hand-built shape fixture; the real portal may use different names (openPrice, volume, changeRatio,
// …). So — exactly like the ADX quotes parser — the field mapping is DRIVEN BY A CONFIG fieldMap:
// DEFAULT_FIELD_MAP holds the current best-guess names, and the source's
// endpoint_config.fieldMap (copied onto snapshot.meta.fieldMap by the fetcher/worker) OVERRIDES any
// of them. A post-VPS-capture field-name correction is then an ingest.sources DATA edit, not a code
// deploy. Only acrynomName→ticker is effectively required (a row without a symbol is dropped).

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from "../../core/types.js";

const VENUE: VenueCode = "TDWL";

/** Bump ⇒ old snapshots become replay-eligible (CONTRACT §10). */
export const TDWL_QUOTES_PARSER_VERSION = 1;

/**
 * Maps TDWL's actual board field names → NormalizedQuote fields. Each value is the source key on a
 * TDWL board row. Filled from the captured golden and stored in
 * ingest.sources.endpoint_config.fieldMap; travels to the pure parser on snapshot.meta.fieldMap.
 * `ticker` is the only field that matters for the natural key; every other key is optional and
 * normalizes to null when absent. Correcting a renamed portal field is a data edit, not a deploy.
 */
export interface TdwlFieldMap {
  ticker: string; // → ticker (required natural key)
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
  asOf?: string; // primary as_of source (per-row last-trade wall-clock, AST)
  asOfFallback?: string; // secondary as_of source (board update wall-clock, AST)
}

/**
 * Current best-guess TDWL field names — the exact keys the hand-built shape fixture uses. These are
 * the DEFAULTS; the live golden captured on the VPS overrides any that turn out wrong via the source
 * row's endpoint_config.fieldMap. (acrynomName/lastTradePrice/bidPrice/askPrice/transactionDate/
 * lastUpdatetime are recon-confirmed; the OHLC/volume/change keys are unverified guesses.)
 */
export const DEFAULT_FIELD_MAP: TdwlFieldMap = {
  ticker: "acrynomName",
  last: "lastTradePrice",
  change: "change",
  changePct: "changePercent",
  open: "openingPrice",
  high: "highPrice",
  low: "lowPrice",
  prevClose: "previousClosePrice",
  volume: "volumeTraded",
  bid: "bidPrice",
  ask: "askPrice",
  asOf: "transactionDate",
  asOfFallback: "lastUpdatetime",
};

// ---------------------------------------------------------------------------
// Response shape (recon §TDWL, fixtures/tdwl/README.md field map). All numeric
// fields may be absent/null on halted or never-traded rows. Field names are the
// EXACT portal names — do not rename.
// ---------------------------------------------------------------------------

interface TdwlMarketRow {
  sectorName?: string | null;
  sectorRef?: string | null;
  companyRef?: number | string | null; // numeric ticker (e.g. 2030). Alt key.
  acrynomName?: string | null; // symbol, e.g. "SARCO" → ticker
  lastTradePrice?: number | string | null;
  lastTradePriceModified?: string | null;
  lastTradeQuantity?: number | string | null;
  lastUpdatetime?: string | null; // "Jul 13, 2026 4:00:00 PM" (AST)
  transactionDate?: string | null; // "Jul 13, 2026 3:18:51 PM" (AST) — last print time
  askPrice?: number | string | null;
  askQuantity?: number | string | null;
  bidPrice?: number | string | null;
  bidQuantity?: number | string | null;
  openingPrice?: number | string | null;
  highPrice?: number | string | null;
  lowPrice?: number | string | null;
  previousClosePrice?: number | string | null;
  change?: number | string | null;
  changePercent?: number | string | null;
  volumeTraded?: number | string | null;
  valueTraded?: number | string | null;
  noOfTrades?: number | string | null;
}

interface TdwlMarketResponse {
  data?: TdwlMarketRow[] | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by main + Nomu; exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * Parse a TDWL numeric field. The board sends numbers, but modified/string variants
 * carry thousands separators ("2,841,220") and stray currency/percent glyphs. Returns
 * null for absent / blank / non-finite values (never NaN — the DB columns are nullable).
 */
export function parseTdwlNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s%]/g, "").replace(/[^0-9eE.+-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === "+" || cleaned === ".") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * TDWL prints times in Riyadh local (AST = UTC+3) as "MMM D, YYYY h:mm:ss AM/PM" with no zone
 * suffix. Convert to an ISO-8601 UTC instant. Pure — no Date.now(); parses the literal only.
 * Returns null on unparseable input (the writer falls back to captured_at for as_of if needed).
 */
export function parseTdwlTimestampToUtc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  // "Jul 13, 2026 3:18:51 PM" — allow 1-2 digit day/hour, optional seconds.
  const m = s.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i,
  );
  if (!m) return null;
  const [, monRaw, dayRaw, yearRaw, hourRaw, minRaw, secRaw, mer] = m;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[monRaw!.slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  let hour = Number(hourRaw);
  const min = Number(minRaw);
  const sec = secRaw ? Number(secRaw) : 0;
  const meridiem = mer!.toUpperCase();
  if (hour < 1 || hour > 12) return null;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  // AST is UTC+3 with no DST → subtract 3h to get UTC. Use Date.UTC on the local wall time,
  // then subtract the offset in ms. Deterministic and TZ-independent of the host.
  const AST_OFFSET_MS = 3 * 60 * 60 * 1000;
  const utcMs = Date.UTC(year, mon, day, hour, min, sec) - AST_OFFSET_MS;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

/** Read a field off a board row by the name the fieldMap assigns (undefined if unmapped/absent). */
function field(row: Record<string, unknown>, key: string | undefined): unknown {
  if (!key) return undefined;
  return row[key];
}

/**
 * Map one TDWL board row → NormalizedQuote via the field map. Rows with no usable symbol are dropped
 * by the caller. change/changePct are taken from the board when present, else derived from last vs
 * prevClose (fieldMap.prevClose → compute change if the board omits it). Field names come ENTIRELY
 * from `fm` (config over code): a renamed portal field is corrected by editing the source row's
 * endpoint_config.fieldMap, never by redeploying this parser. `fm` defaults to DEFAULT_FIELD_MAP.
 */
export function mapTdwlRow(
  row: Record<string, unknown>,
  fm: TdwlFieldMap = DEFAULT_FIELD_MAP,
): NormalizedQuote | null {
  const symRaw = field(row, fm.ticker);
  const ticker = typeof symRaw === "string" ? symRaw.trim() : symRaw != null ? String(symRaw).trim() : "";
  if (ticker === "") return null; // no natural key → cannot resolve security_id downstream

  const last = parseTdwlNumber(field(row, fm.last));
  const prevClose = parseTdwlNumber(field(row, fm.prevClose));

  let change = parseTdwlNumber(field(row, fm.change));
  let changePct = parseTdwlNumber(field(row, fm.changePct));
  if (change === null && last !== null && prevClose !== null) {
    change = round(last - prevClose, 6);
  }
  if (changePct === null && last !== null && prevClose !== null && prevClose !== 0) {
    changePct = round(((last - prevClose) / prevClose) * 100, 4);
  }

  // as_of = exchange delayed print time. Prefer the per-row last-trade time, fall back to the
  // board update time. Both are AST wall-clock; convert to UTC. null ⇒ writer uses captured_at.
  const asOf =
    parseTdwlTimestampToUtc(field(row, fm.asOf)) ??
    parseTdwlTimestampToUtc(field(row, fm.asOfFallback)) ??
    "";

  return {
    venue: VENUE,
    ticker,
    last,
    change,
    changePct,
    open: parseTdwlNumber(field(row, fm.open)),
    high: parseTdwlNumber(field(row, fm.high)),
    low: parseTdwlNumber(field(row, fm.low)),
    volume: parseTdwlNumber(field(row, fm.volume)),
    asOf,
    bid: parseTdwlNumber(field(row, fm.bid)),
    ask: parseTdwlNumber(field(row, fm.ask)),
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Pure parser: verbatim snapshot bytes → NormalizedQuote[]. Shared by main-market and Nomu
 * (identical response shape). Zero rows on a CHANGED snapshot ⇒ the harness flags PARSE_DRIFT.
 * Throws on non-JSON / wrong-shape bytes so the harness records status='error' (a hard drift),
 * distinct from an empty-but-valid board.
 */
export function parseTdwlQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  const text = snapshot.body.toString("utf8");
  let doc: TdwlMarketResponse;
  try {
    doc = JSON.parse(text) as TdwlMarketResponse;
  } catch (err) {
    throw new Error(
      `TDWL quotes parse: snapshot ${snapshot.snapshotId} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.data)) {
    throw new Error(
      `TDWL quotes parse: snapshot ${snapshot.snapshotId} missing top-level {data:[...]} array`,
    );
  }
  // Field mapping is config-driven: overlay the source's fieldMap (carried on snapshot.meta by the
  // fetcher/worker) onto the defaults, so a field-name correction is a data edit, not a deploy.
  const metaMap = (snapshot.meta?.fieldMap as Partial<TdwlFieldMap> | undefined) ?? {};
  const fm: TdwlFieldMap = { ...DEFAULT_FIELD_MAP, ...metaMap };
  const rows: NormalizedQuote[] = [];
  for (const raw of doc.data) {
    if (raw === null || typeof raw !== "object") continue;
    const q = mapTdwlRow(raw as Record<string, unknown>, fm);
    if (q !== null) rows.push(q);
  }
  return { rows, parserVersion: TDWL_QUOTES_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// fetch(): impure/transport. Uses the BrowserClient bootstrap → request path. The action
// discovery config (navigateUrl, extract mode, responseUrlPattern) comes ENTIRELY from
// source.endpointConfig.actionDiscovery — never hardcoded here. Same code serves the Main
// market and the Nomu sibling; they differ only by the ingest.sources row (endpoint_config).
// ---------------------------------------------------------------------------

async function fetchTdwlBoard(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, logger, now } = ctx;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!discovery) {
    throw new Error(
      `TDWL quotes fetch: source ${source.id} has no endpoint_config.actionDiscovery — cannot resolve the portal action URL`,
    );
  }

  // Seat Akamai cookies + scrape the runtime action URL (PUID + NJgetMainNomucMarketDetails).
  // BrowserClient.bootstrap navigates the page, reads the datatable AJAX config, and returns the
  // resolved action URL. The action id/PUID is NEVER hardcoded — it lives only in the page + the
  // source's actionDiscovery shape.
  const boot = await browser.bootstrap(discovery);
  logger.info("TDWL board: resolved runtime action URL", {
    sourceId: source.id,
    dataType: source.dataType,
  });

  // Fetch the JSON through the SAME browser context (fingerprint-matched). BrowserClient.get owns
  // the WAF-challenge retry + one free re-bootstrap and THROWS a typed FetchError on a persistent
  // 401/403/5xx/4xx (CONTRACT §10) — the adapter does not inspect status codes itself.
  const resp = await browser.get(boot.resolvedUrl, browserOpts(source.endpointConfig.headers));

  // Copy the source's fieldMap onto FetchResult.meta so the PURE parser has the mapping without
  // re-reading ingest.sources. Post-VPS field-name corrections live in endpoint_config.fieldMap.
  const fieldMap =
    (source.endpointConfig as unknown as { fieldMap?: TdwlFieldMap }).fieldMap ?? DEFAULT_FIELD_MAP;

  return [
    {
      url: resp.url,
      // TDWL sends text/html for JSON — keep verbatim (CONTRACT §2 FetchResult.contentType note).
      contentType: resp.headers["content-type"] ?? "text/html",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", cookiesSeated: boot.cookies.length > 0, fieldMap },
    },
  ];
}

/** Build FetchOptions without an explicit `undefined` headers key (exactOptionalPropertyTypes). */
export function browserOpts(
  headers: Record<string, string> | undefined,
  timeoutMs = 20_000,
): { headers?: Record<string, string>; timeoutMs: number } {
  return headers ? { headers, timeoutMs } : { timeoutMs };
}

// ---------------------------------------------------------------------------
// TaskSpec exports. Main market and Nomu share the SAME parser and fetch mechanism; they are
// distinct ingest.sources rows (different endpoint_config.actionDiscovery action id), so the
// adapter exposes one quotes task and the Nomu row simply points its own source at it. Both are
// surfaced for clarity and for the adapter's `quotes` slot + a named Nomu export.
// ---------------------------------------------------------------------------

export const tdwlQuotes: TaskSpec<NormalizedQuote> = {
  dataType: "quotes",
  parserVersion: TDWL_QUOTES_PARSER_VERSION,
  fetch: fetchTdwlBoard,
  parse: parseTdwlQuotes,
};

/**
 * Nomu (parallel market) variant. Identical shape/parser — the ONLY difference is the
 * ingest.sources row it is driven by (its endpoint_config.actionDiscovery resolves the Nomu
 * sibling action instead of the main-market action). Kept as a separate export so the seed /
 * worker can wire a Nomu source to a clearly-named task.
 */
export const tdwlNomuQuotes: TaskSpec<NormalizedQuote> = {
  dataType: "quotes",
  parserVersion: TDWL_QUOTES_PARSER_VERSION,
  fetch: fetchTdwlBoard,
  parse: parseTdwlQuotes,
};

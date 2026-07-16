/**
 * FROZEN CONTRACT SURFACE — ingestion/src/core/types.ts
 *
 * Every interface here is imported by other P1 modules (adapters, worker
 * handlers, lake). Names, fields, and DB-column mappings are frozen per
 * ingestion/CONTRACT.md §2–§9. Do not rename or reshape without tech-lead
 * sign-off in CONTRACT.md first.
 *
 * Grounded in the live applied DDL:
 *   supabase/migrations/20260713000005_prices.sql  (ingest.*, public prices)
 *   supabase/migrations/20260713000004_lake.sql    (lake.*)
 *   supabase/migrations/20260713000002_iam.sql     (iam.principals handles)
 */

// ---------------------------------------------------------------------------
// §2 Adapter contract
// ---------------------------------------------------------------------------

export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

/** Matches ingest.sources.data_type values used in the seed (§8). */
export type DataType =
  | 'quotes'
  | 'indices'
  | 'filings_list'
  | 'filing_detail'
  | 'financials'
  | 'dividends'
  | 'ipo'
  | 'calendar'
  | 'eod_bulletin'
  | 'ohlcv_backfill';

/** ingest.sources.transport CHECK: 'http' | 'http_bootstrap' | 'headless'. */
export type Transport = 'http' | 'http_bootstrap' | 'headless';

/** ingest.sources.robots_status CHECK. */
export type RobotsStatus = 'allowed' | 'disallowed' | 'override';

/**
 * Per-source proxy IP policy (P1.7a framework practice). See EndpointConfig.proxy_mode.
 *   'rotate' — fresh exit IP per request (default; defeats per-IP rate limits like Yahoo 429).
 *   'sticky' — same exit IP for a bounded burst (cookie/IP-affinity flows, e.g. BHB WAF).
 */
export type ProxyMode = 'rotate' | 'sticky';

/** One ingest.sources row, loaded by core/registry.loadSource(). Columns EXACT (0005). */
export interface SourceRecord {
  id: number; // ingest.sources.id (bigint)
  venue: VenueCode; // ingest.sources.venue → public.venues.code
  dataType: DataType; // ingest.sources.data_type
  entryUrl: string; // ingest.sources.entry_url (human-auditable page of record)
  endpointConfig: EndpointConfig; // ingest.sources.endpoint_config (jsonb)
  normalizeRules: NormalizeRule[]; // ingest.sources.normalize_rules (jsonb; default [])
  transport: Transport; // ingest.sources.transport
  robotsStatus: RobotsStatus; // ingest.sources.robots_status
  active: boolean; // ingest.sources.active
  lastContentHash: string | null; // ingest.sources.last_content_hash (single-URL sources)
}

/**
 * endpoint_config jsonb shape. For http_bootstrap/headless, `actionDiscovery`
 * tells the BrowserClient how to scrape the runtime action id/PUID from the
 * page at runtime (never hardcoded).
 */
export interface EndpointConfig {
  method?: 'GET' | 'POST';
  /** Request body for POST sources, sent verbatim (e.g. DFM's /dapi/fetch board
   *  command envelope). Only consulted when method === 'POST'. */
  body?: string;
  /** Per-source fetch timeout override (ms); default 20_000 in the fetcher. Raise
   *  for slow origins — e.g. QE's MarketWatch.txt intermittently takes >15s, which
   *  silently timed out the native board and dropped QE onto the Yahoo fallback. */
  timeoutMs?: number;
  urlTemplate?: string; // may contain {epochMs}, {page}, {symbol} placeholders
  headers?: Record<string, string>;
  pagination?: { param: string; start: number; pageSize?: number };
  actionDiscovery?: {
    navigateUrl: string; // page to load to seat cookies
    // how to obtain the real XHR URL at runtime:
    //   datatable_ajax   — scrape the datatable's ajax action URL from the page
    //   network_capture  — passively wait for the page to fire the matching XHR
    //   direct           — seat cookies only; the caller fetches its own known
    //                      urlTemplate in-context (e.g. a fixed apigateway URL +
    //                      apikey header, where the page never auto-fires it)
    extract: 'datatable_ajax' | 'network_capture' | 'direct';
    responseUrlPattern?: string; // regex the captured response URL must match
  };
  /**
   * When true, this source egresses through the configured outbound proxy
   * (IPRoyal GCC residential — creds read from env, NEVER hardcoded here). Set on
   * BHB sources whose official origin is IP-geofenced/Akamai-blocked from the
   * plain VPS IP (0020_bhb_proxy) and on Yahoo sources that are 429 rate-blocked
   * from the VPS IP under volume (0027_yahoo_proxy_rotate). TDWL uses the Mubasher
   * aggregator and needs no proxy. Absent/false ⇒ direct egress. See core/proxy.ts.
   */
  use_proxy?: boolean;
  /**
   * Per-source proxy IP policy (framework practice, P1.7a). Only consulted when
   * use_proxy is true. Defaults to 'rotate' when absent.
   *   - 'rotate' — a FRESH exit IP per request (IPRoyal's default residential
   *      rotation). This defeats per-IP rate counters (Yahoo 429): each request in
   *      a ~200-symbol backfill sweep exits a different IP so the counter never
   *      accumulates. Use for high-volume, stateless fetch (Yahoo quotes/backfill).
   *   - 'sticky' — the SAME exit IP for a bounded burst, via an IPRoyal
   *      `_session-<id>_lifetime-<n>m` selector appended to the password. Use only
   *      for stateful flows needing cookie/IP affinity across requests (e.g. a WAF
   *      challenge cookie that is IP-bound, as on BHB's Radware path).
   */
  proxy_mode?: ProxyMode;
  // 'csv' added for the Mubasher ADX/MSX/BHB historical OHLCV backfill (headerless daily-bar CSV).
  responseKind: 'json' | 'html' | 'txt_json' | 'xlsx' | 'pdf' | 'csv';
}

/**
 * normalize_rules: strip volatile bytes (server timestamps, CSRF/viewstate,
 * request ids) BEFORE hashing, so unchanged content dedupes. Applied in order;
 * JSON is key-sorted first.
 */
export interface NormalizeRule {
  pattern: string;
  replacement: string;
  flags?: string;
}

/** Result of a single fetch — RAW, never parsed. Fed straight into SnapshotStore.put(). */
export interface FetchResult {
  externalId?: string; // announcement id etc. → raw_snapshots.external_id / seen_items
  url: string; // exact URL fetched (provenance) → raw_snapshots.url
  contentType: string; // → raw_snapshots.content_type (TDWL sends text/html for JSON — keep verbatim)
  httpStatus: number; // → raw_snapshots.http_status
  body: Buffer; // raw bytes, verbatim (pre-normalize)
  fetchedAt: string; // ISO-8601 UTC; → raw_snapshots.fetched_at
  meta?: Record<string, unknown>; // e.g. { page, symbol, lang: 'en' } → raw_snapshots.meta
}

/** What a pure parser receives — the STORED snapshot (never a live fetch). */
export interface StoredSnapshot {
  snapshotId: number; // ingest.raw_snapshots.id
  sourceId: number; // ingest.raw_snapshots.source_id
  venue: VenueCode;
  dataType: DataType;
  contentType: string;
  externalId: string | null;
  body: Buffer; // the verbatim bytes (from Storage or inline)
  fetchedAt: string; // ISO-8601 UTC
  meta: Record<string, unknown>;
}

export interface ParseResult<T> {
  rows: T[]; // zero rows on a CHANGED snapshot ⇒ PARSE_DRIFT (§10)
  parserVersion: number; // must equal TaskSpec.parserVersion
}

/** A data-type task on one venue. fetch = impure/transport; parse = PURE/replayable. */
export interface TaskSpec<T> {
  dataType: DataType;
  parserVersion: number; // bump ⇒ old snapshots become replay-eligible (§10)
  fetch(ctx: FetchContext): Promise<FetchResult[]>;
  parse(snapshot: StoredSnapshot): ParseResult<T>; // PURE. No I/O. No Date.now(). No fetch.
}

export type AgentAccount =
  | 'DATA-TDWL'
  | 'DATA-DFM'
  | 'DATA-ADX'
  | 'DATA-QE'
  | 'DATA-MSX'
  | 'DATA-BHB'
  | 'DATA-FILINGS';

export interface VenueAdapter {
  venue: VenueCode;
  /** iam.principals.handle of the owning DATA agent (LIVE seed uses per-venue accounts). */
  agentAccount: AgentAccount; // filings_list/filing_detail attribute to DATA-FILINGS
  quotes?: TaskSpec<NormalizedQuote>;
  indices?: TaskSpec<NormalizedIndexLevel>;
  filingsList?: TaskSpec<NormalizedFilingRef>;
  filingDetail?: TaskSpec<NormalizedFiling>;
  dividends?: TaskSpec<NormalizedDividend>;
  eodBulletin?: TaskSpec<NormalizedOhlcv>;
  ipo?: TaskSpec<NormalizedIpoEvent>;
  financials?: TaskSpec<NormalizedStatementRow>;
  // extend per §8 as sources are added; unset = venue does not serve that type in v1.
}

// ---------------------------------------------------------------------------
// §3 Transport clients
// ---------------------------------------------------------------------------

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number; // default 20_000
  conditional?: { etag?: string; lastModified?: string }; // If-None-Match / If-Modified-Since
}

export interface RawResponse {
  url: string; // final URL after redirects
  status: number;
  headers: Record<string, string>;
  body: Buffer; // empty on 304
  fromCache304: boolean;
}

/** Shared transport surface. Both clients honor the per-host ≤1 req/s token bucket + robots. */
export interface Transporter {
  get(url: string, opts?: FetchOptions): Promise<RawResponse>;
  request(url: string, opts: FetchOptions): Promise<RawResponse>;
}

/** Plain fetch (undici). QE/MSX/BHB steady-state, and any venue that proves unchallenged. */
export type HttpClient = Transporter;

/**
 * Playwright persistent request-context. TDWL/ADX (Akamai/Incapsula WAF) + DFM
 * if challenged. bootstrap() seats cookies by navigating a page, then discovers
 * the runtime action URL; get() issues context.request.get() so the TLS/JA3
 * fingerprint MATCHES the cookies (undici replay re-challenges — 01 Rev #3).
 */
export interface BrowserClient extends Transporter {
  bootstrap(
    cfg: EndpointConfig['actionDiscovery'],
  ): Promise<{ resolvedUrl: string | null; cookies: string }>; // resolvedUrl null for extract:'direct'
  refreshIfChallenged(status: number): Promise<void>; // 401/403/challenge ⇒ re-bootstrap, one free retry
  /** Release the singleton Chromium — called on worker drain. */
  close(): Promise<void>;
}

export interface Logger {
  info(m: string, x?: object): void;
  warn(m: string, x?: object): void;
  error(m: string, x?: object): void;
  child(x: object): Logger;
}

/** Everything a TaskSpec.fetch() gets. Never gives parse() I/O — parse() takes only a snapshot. */
export interface FetchContext {
  source: SourceRecord;
  http: HttpClient; // use when transport === 'http'
  browser: BrowserClient; // use when transport === 'http_bootstrap' | 'headless'
  logger: Logger;
  now(): string; // ISO UTC — injected so fetch is testable; parse NEVER calls this
  /**
   * Optional STREAMING sink (P1.7a). When the runtime provides it, a fetch() that
   * produces many independent results (the Yahoo ≥2y OHLCV backfill: one GET per
   * symbol) may push each FetchResult here AS IT LANDS instead of buffering the whole
   * venue sweep into the returned array. The runtime snapshots + parses + stages each
   * pushed result immediately, so bars accrue progressively and a mid-sweep crash
   * keeps everything already persisted (fetch is idempotent — snapshot dedup + staging
   * upsert make a re-run safe). A streaming fetch pushes here and returns [] (nothing
   * left to process); a non-streaming fetch ignores this and returns its array as
   * before. PURE parse is unaffected — this is a transport-side seam only.
   */
  onFetched?(f: FetchResult): Promise<void>;
}

// ---------------------------------------------------------------------------
// §4 SnapshotStore + ParseRunRecorder
// ---------------------------------------------------------------------------

export interface PutSnapshotInput {
  source: SourceRecord;
  fetched: FetchResult;
  agentPrincipalId: string; // iam.principals.id of the venue DATA agent (lake.snapshots.fetched_by)
}

export interface PutSnapshotResult {
  snapshotId: number; // ingest.raw_snapshots.id
  lakeSnapshotId: number; // lake.snapshots.id (the lineage anchor for parse runs)
  sha256: string; // hex digest of NORMALIZED body
  deduped: boolean; // true ⇒ content unchanged: heartbeat only, no parse enqueued
  storagePath: string | null; // 'lake-raw' key when body was uploaded (large blob)
  bytesStored: number;
}

export interface SnapshotStore {
  put(input: PutSnapshotInput): Promise<PutSnapshotResult>;
  load(snapshotId: number): Promise<StoredSnapshot>; // for parse-harness + replay
}

export interface ParseRunRecorder {
  record(input: {
    snapshotId: number; // ingest.raw_snapshots.id
    parserVersion: number; // int
    status: 'ok' | 'error' | 'drift_zero_rows';
    rowsEmitted: number | null;
    error?: string | null;
  }): Promise<number>; // ingest.parse_runs.id
}

// ---------------------------------------------------------------------------
// §6 Normalized row shapes
// ---------------------------------------------------------------------------

/** §6.1 → public.quotes_latest / public.quotes_intraday (0005) */
export interface NormalizedQuote {
  venue: VenueCode;
  ticker: string; // resolve → public.securities.id via (venue_code, ticker)
  last: number | null; // → quotes_latest.last            numeric(18,6)
  change: number | null; // → quotes_latest.change          numeric(18,6)
  changePct: number | null; // → quotes_latest.change_pct      numeric(9,4)
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null; // → quotes_latest.volume          numeric(20,0)
  vwap?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
  asOf: string; // exchange delayed print time (UTC) → quotes_latest.as_of
  // captured_at, delay_minutes(=15), snapshot_id, tick_dir are set by the writer.
  bid?: number | null;
  ask?: number | null; // kept in staging payload; not persisted to quotes_latest
}

/** §6.2 → public.index_levels (0005) */
export interface NormalizedIndexLevel {
  indexCode: string; // → index_levels.index_code (TASI, DFMGI, FADGI, QSI, MSX30, BAX)
  level: number; // → level        numeric(18,4)  NOT NULL
  change?: number | null;
  changePct?: number | null; // numeric(9,4)
  dayHigh?: number | null;
  dayLow?: number | null;
  valueTraded?: number | null; // numeric(20,2)
  asOf: string; // → as_of  timestamptz (PK part with index_code)
}

/** §6.3 → public.ohlcv_daily (0005) — EOD source of record */
export interface NormalizedOhlcv {
  venue: VenueCode;
  ticker: string; // → security_id
  tradeDate: string; // 'YYYY-MM-DD' → ohlcv_daily.trade_date (PK part)
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number; // → ohlcv_daily.close  numeric(18,6) NOT NULL
  volume?: number | null;
  valueTraded?: number | null;
}

/**
 * §6.5 / 07 §P1.7b — one financial-statement PERIOD flattened for staging + projection.
 * The statement normalizer (lake/statement-normalizer.ts) emits NormalizedPeriod, which
 * carries NO identity (venue/ticker); a producing adapter enriches each period with
 * venue+ticker+basis via flattenStatements() so the PURE staging mapper (runtime.mapStatement)
 * can build a resolvable FILING.FINANCIALS natural_key and a projection-ready object payload
 * WITHOUT a DB handle. These payload keys are EXACTLY what lake.fn_financial_statement_project
 * reads (migration 20260716095100): venue/ticker → security_id, statementType/basis/periodKind/
 * fiscalPeriod/periodEnd/currency → the serving columns, lineItems → the §3.1 primitive jsonb.
 * The line_items vocabulary is the §3.1 canonical primitive keys (PRIMITIVE_KEYS in
 * statement-normalizer.ts) — a source that carries none of them stages nothing.
 */
export interface NormalizedStatementRow {
  venue: VenueCode;
  ticker: string; // → resolves public.securities.id at projection time (venue+ticker unique)
  statementType: 'income' | 'balance' | 'cashflow';
  basis: 'consolidated' | 'standalone';
  periodKind: 'quarter' | 'annual' | 'ttm';
  fiscalPeriod: string; // 'FY2023' | '2023-Q4' | 'TTM-2025-12-31'
  periodEnd: string; // 'YYYY-MM-DD'
  currency: string; // char(3)
  lineItems: Record<string, number | null>; // the §3.1 primitive keys
  segments?: Record<string, unknown> | null;
}

/** §6.4 filings_list poll (list-diff on external_id) */
export interface NormalizedFilingRef {
  venue: VenueCode;
  externalId: string; // announcement id, e.g. 'CG-1-2026-4471' → seen_items
  sourceRef: string; // → public.filings.source_ref (unique w/ venue_code)
  title: string;
  filedAt: string; // → filings.title / filed_at
  detailUrl: string;
  pdfUrl?: string; // enqueue filing_detail at priority 1
  formCode?: string;
}

/** §6.4 filing_detail — feeds public.filings + lake object */
export interface NormalizedFiling {
  venue: VenueCode;
  externalId: string;
  sourceRef: string;
  securityTicker?: string | null; // null for market-wide notices
  formCode?: string;
  filingType:
    | 'DIVIDEND'
    | 'CAPEX'
    | 'RESULTS'
    | 'RATING'
    | 'GOVERNANCE'
    | 'OPS'
    | 'CONTRACT'
    | 'PROSPECTUS'
    | 'OTHER';
  title: string;
  filedAt: string; // → public.filings columns of the same name
  fullTextEn?: string; // → filings.full_text (machine-extracted EN)
  extractedFacts?: Record<string, unknown>; // → filings.extracted_facts (jsonb)
  pdfStoragePath?: string; // → filings.pdf_en_path (Storage bucket 'filings')
}

/** §6.4 → public.dividends via lake object */
export interface NormalizedDividend {
  venue: VenueCode;
  ticker: string;
  divType: 'FINAL' | 'INTERIM' | 'SPECIAL'; // → dividends.div_type
  fiscalRef?: string | null;
  dps: number; // → dividends.dps numeric(12,6)
  currency: string; // → dividends.currency char(3)
  exDate?: string | null;
  recordDate?: string | null;
  payDate?: string | null;
  verification: 'registrar' | 'disclosure'; // → dividends.verification (default 'disclosure')
}

/** §6.4 → public.ipo_offers / ipo_timeline_events via lake object */
export interface NormalizedIpoEvent {
  venue: VenueCode;
  companyName: string;
  stage:
    | 'intention'
    | 'draft_prospectus'
    | 'filing'
    | 'bookbuilding'
    | 'retail_open'
    | 'allocation'
    | 'listed';
  priceRangeLow?: number | null;
  priceRangeHigh?: number | null;
  finalPrice?: number | null;
  coverageInst?: number | null;
  coverageRetail?: number | null;
  isPriceSensitive?: boolean; // price-range/date changes ⇒ human-confirm gate (33b)
}

// ---------------------------------------------------------------------------
// §6.5 Staging emit — the ingestion→lake handoff
// ---------------------------------------------------------------------------

export interface StagingRow<T> {
  objectType: string; // 'QUOTE.LAST','DISCLOSURE.DPS','DIVIDEND.EXDATE','FILING.FINANCIALS',…
  naturalKey: string; // deterministic, e.g. 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1'
  venue: VenueCode;
  sourceId: number; // ingest.sources.id
  snapshotId: number; // ingest.raw_snapshots.id (lineage)
  externalId: string | null;
  sourceRank: number; // primary-wins ordering: registrar=10, exchange=20, press=90
  payload: T; // the normalized shape from §6.1–6.4
  numericValue?: number | null; // fast-path scalar → lake.objects.numeric_value + datapoint fan-out
  unit?: string | null;
  effectiveDate?: string | null; // business date → lake.objects.effective_date
  priceSensitive?: boolean; // → lake.objects.price_sensitive (dividends/IPO/results)
  extractedAt: string; // ISO UTC
}

export interface StagingEmitter {
  emit<T>(rows: StagingRow<T>[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// §7 CrossCheck service
// ---------------------------------------------------------------------------

export interface CrossCheckInput {
  naturalKey: string;
  objectType: string;
}

export interface CrossCheckResult {
  objectId: string; // lake.objects.id (uuid)
  state: 'PENDING' | 'VERIFIED' | 'CONFLICT';
  revision: number;
}

export interface CrossCheck {
  resolve(input: CrossCheckInput): Promise<CrossCheckResult>;
}

// ---------------------------------------------------------------------------
// §9 pgmq job envelope + worker handler names
// ---------------------------------------------------------------------------

export type HandlerName =
  | 'quote_poll'
  | 'eod_sweep'
  | 'filings_poll'
  | 'cross_check'
  | 'key_ratios_recompute';

export type JobEnvelope<P = Record<string, unknown>> = {
  handler: HandlerName;
} & P;

export interface QuotePollPayload {
  handler: 'quote_poll';
  sourceId: number;
}
export interface EodSweepPayload {
  handler: 'eod_sweep';
  venue: VenueCode;
  tradeDate: string;
}
export interface FilingsPollPayload {
  handler: 'filings_poll';
  sourceId: number;
}
export interface CrossCheckPayload {
  handler: 'cross_check';
  naturalKey: string;
  objectType: string;
}
export interface KeyRatiosPayload {
  handler: 'key_ratios_recompute';
  securityIds?: number[];
}

/** The five pgmq queues (worker canon; consumer.ts). */
export const QUEUE_NAMES = [
  'q_ingest',
  'q_pipeline',
  'q_dispatch',
  'q_email',
  'q_maintenance',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// ---------------------------------------------------------------------------
// §10 Failure taxonomy
// ---------------------------------------------------------------------------

/** Per-fetch error classes driving consecutive_failures + fetch_log.error (§10). */
export type FetchErrorClass =
  | 'NETWORK'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'WAF_CHALLENGE'
  | 'PARSE_DRIFT';

export class FetchError extends Error {
  readonly errorClass: FetchErrorClass;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    errorClass: FetchErrorClass,
    message: string,
    opts?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'FetchError';
    this.errorClass = errorClass;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

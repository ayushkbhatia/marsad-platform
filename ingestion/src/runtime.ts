/**
 * createIngestionRuntime — the ONE factory the worker imports from `marsad-ingestion`
 * (worker/src/handlers/runtime-wiring.ts, CONTRACT §1). It assembles the framework
 * (registry, transport clients, snapshot store, parse-harness), the adapters map, and the
 * lake services (staging emit, cross-check, key-ratios) against the worker's DB pool + env,
 * and returns an object satisfying the worker's IngestionRuntime interface
 * (worker/src/handlers/ingestion-runtime.ts).
 *
 * The worker owns orchestration (claim work, set app.principal_id, enqueue follow-ups) and
 * calls the methods below. All heavy lifting (transport, hashing, parse, lake writes) lives
 * here and in ingestion/src/{core,lake,adapters}.
 *
 * ── Staging seam (CLOSED) ────────────────────────────────────────────────────────────────
 * `runTask` runs the full fetch → snapshot-first → pure-parse → parse_runs → STAGING path. The
 * final step — mapping a parser's NormalizedQuote / NormalizedOhlcv / NormalizedFilingRef /
 * NormalizedFiling rows into lineage-bearing lake StagingRows (natural-key derivation, source_rank,
 * numeric_value, price_sensitive per CONTRACT §6.5) — is implemented below in the PURE
 * `mapRowsToStaging` seam. runTask now emits real staging rows; cross-check consumes them per
 * natural_key and applies the 2-source rule. The lake.staging_rows table itself is created by
 * supabase/migrations/20260713000018_lake_staging_rows.sql (the frozen DDL in
 * lake/staging-schema.ts). NOTE: BHB EOD bulletin decode is still config-pending until the first
 * VPS xlsx capture (see the adapter note) — orthogonal to this seam.
 */

import { createHash } from 'node:crypto';
import type { Sql } from './core/db.js';
import { loadConfig, type IngestionConfig } from './core/config.js';
import {
  FILING_PDF_RESOLVERS,
  filingStorageKey,
  pdfExtFor,
  isPdfResponse,
  type FilingPdfResolver,
} from './adapters/filings-detail.js';
import { createHttpClient, makeCurlTransport } from './core/fetcher.js';
import { createBrowserClient } from './core/browser.js';
import { createPlaywrightDriver } from './core/playwright-driver.js';
import { createStorageUploader, type StorageUploader } from './core/storage.js';
import { createSnapshotStore, createParseRunRecorder } from './core/snapshot.js';
import { runParse } from './core/parse-harness.js';
import {
  loadSource,
  loadSourcesForVenue,
  agentAccountFor,
  resolvePrincipalId,
} from './core/registry.js';
import { ADAPTERS } from './adapters/index.js';
import { yahooTasks, toYahooSymbol } from './adapters/yahoo/index.js';
import { mubasherTasks } from './adapters/mubasher/index.js';
import { msxHistory } from './adapters/msx/index.js';
import { bhbOhlcvBackfill } from './adapters/bhb/index.js';
import { resolveProxyForSource, proxyToUrl, type ProxyConfig } from './core/proxy.js';
import { LakeStagingEmitter } from './lake/staging.js';
import { LakeCrossCheck } from './lake/cross-check.js';
import { KeyRatiosRecompute } from './lake/key-ratios.js';
import { ScoresRecompute } from './lake/scores.js';
import { contentHash } from './lake/canonical.js';
import type {
  SourceRecord,
  VenueCode,
  DataType,
  AgentAccount,
  TaskSpec,
  FetchResult,
  FetchContext,
  EndpointConfig,
  HttpClient,
  BrowserClient,
  Logger,
  SnapshotStore,
  ParseRunRecorder,
  StagingRow,
  CrossCheck,
  NormalizedQuote,
  NormalizedIndexLevel,
  NormalizedOhlcv,
  NormalizedFilingRef,
  NormalizedFiling,
  NormalizedDividend,
  NormalizedIpoEvent,
  NormalizedStatementRow,
  NormalizedProfile,
  StatementType,
  StatementPresentationRow,
} from './core/types.js';

// ── The narrow runtime surface the worker handlers call (mirrors
//    worker/src/handlers/ingestion-runtime.ts; structurally identical). ────────────────────

export interface StagedKey {
  naturalKey: string;
  objectType: string;
}

/**
 * One drain target for the filing_detail chain: an announcement the filings_list poll parsed, with
 * the URLs the detail fetch needs. Recorded (for genuinely-new ids) as an ingest.seen_items row and
 * later drained by the filings_detail_poll handler. `ticker` is unset by the list feed (0037 note) —
 * reserved for a later security-resolution pass.
 */
export interface FilingDetailTarget {
  externalId: string;
  detailUrl: string | null;
  pdfUrl: string | null;
  title: string | null;
  filedAt: string | null;
  ticker?: string | null;
}

/** Result of downloading + storing one filing PDF (fetchFilingPdfs). */
export interface FilingPdfResult {
  externalId: string;
  ok: boolean;
  storageKey?: string;
  sha256?: string;
  contentType?: string;
  bytes?: number;
  error?: string;
}

export interface RunTaskResult {
  changed: boolean;
  snapshotId: number | null;
  rowsEmitted: number;
  stagedKeys: StagedKey[];
  newExternalIds: string[];
  /**
   * Every NormalizedFilingRef the parse produced this run (filings_list tasks only; empty otherwise).
   * The gap-#3 fix: `newExternalIds` came from fetch-level FetchResult.externalId, which is always
   * empty for a single list-page fetch, so no detail was ever enqueued. The list-diff against
   * ingest.seen_items now runs off THESE parsed refs (the handler passes them to enqueueFilingDetails,
   * whose ON CONFLICT DO NOTHING returns the genuinely-new ones).
   */
  filingRefs: FilingDetailTarget[];
  parserVersion: number;
}

export interface IngestionRuntime {
  loadSource(sourceId: number): Promise<SourceRecord>;
  agentAccountForSource(source: SourceRecord): AgentAccount;
  runTask(input: {
    source: SourceRecord;
    task: TaskSpec<unknown>;
    agentPrincipalId: string;
    tradeDate?: string;
  }): Promise<RunTaskResult>;
  tasksForSource(source: SourceRecord): TaskSpec<unknown>[];
  eodSourcesForVenue(venue: VenueCode): Promise<SourceRecord[]>;
  filingDetailSourceId(venue: VenueCode): Promise<number | null>;
  /**
   * Download + store the PDFs for a batch of filing_detail targets (the drain chunk). Seats WAF
   * cookies once per batch (not per item), fetches each PDF (direct pdfUrl, or detail-page → resolver
   * → PDF), stores it in the 'filings' Storage bucket content-addressed by sha256, and returns the
   * storage key + sha per target. Does NO DB write — the worker handler owns the public.filings +
   * ops.filing_extract_queue + seen_items writes in its identity tx (mirrors the runTask/handler split).
   */
  fetchFilingPdfs(input: {
    source: SourceRecord;
    targets: FilingDetailTarget[];
    agentPrincipalId: string;
  }): Promise<FilingPdfResult[]>;
  crossCheck: CrossCheck;
  pipelinePrincipalId(): Promise<string>;
  recomputeKeyRatios(securityIds?: number[]): Promise<{ rowsWritten: number }>;
  runScoreBatch(securityIds?: number[]): Promise<{ scored: number }>;
  countStagingSources(naturalKey: string, objectType: string): Promise<number>;
}

export interface CreateIngestionRuntimeDeps {
  /** The worker's shared postgres.js pool (marsad_worker role). */
  sql: Sql;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  workerId: string;
}

/** Minimal console-backed Logger; the worker's structured logger can replace this later. */
const consoleLogger: Logger = {
  info() {},
  warn(m, x) {
    console.warn(`[ingestion] ${m}`, x ?? '');
  },
  error(m, x) {
    console.error(`[ingestion] ${m}`, x ?? '');
  },
  child() {
    return consoleLogger;
  },
};

/**
 * The alt-provider discriminant seeded on ingest.sources.endpoint_config. A source with an alt
 * provider resolves to an aggregator TaskSpec bundle (aggregators own NO VenueAdapter and are NOT
 * VenueAdapter keys) instead of the primary (venue,data_type) adapter. Read via a local cast so
 * the frozen EndpointConfig surface (core/types.ts) stays untouched — the field is optional and
 * only aggregator rows carry it, so primary sources are byte-identical to the pre-provider path.
 *   'yahoo'             — Yahoo Finance quotes cross-check + ≥2y OHLCV backfill for TDWL/QE/DFM (0021/0022).
 *   'mubasher_csv'      — Mubasher historical-CSV ≥2y OHLCV backfill for ADX (0033); reusable for any
 *                         venue Mubasher publishes a per-ticker historical CSV for (e.g. TDWL later).
 *                         BHB has NO Mubasher CSV — it stays the coverage-gap venue (07 §5 D-src-4).
 *   'msx-summary'       — MSX's own native summary-report.aspx/List JSON full-OHLCV daily backfill
 *                         (~23y, real O/H/L/C + volume). Supersedes the retired close-only
 *                         company-chart-data.aspx source. MSX has a first-class history endpoint, so
 *                         it does NOT ride Mubasher.
 *   'bhb_webapi'        — BHB's own webapi GetTabularDataWithDateRangeFilter/DataExportCompanyProfile
 *                         per-security EOD-CLOSE-history backfill (20260715101500). BHB has no Mubasher
 *                         CSV; its webapi (CF-gated, IP-geoblocked → sticky proxy) is a first-class
 *                         history endpoint. EOD CLOSE ONLY (owner requirement) — open/high/low/vol null.
 */
type AltProvider = 'yahoo' | 'mubasher_csv' | 'msx-summary' | 'bhb_webapi' | 'mubasher_profile';
function providerOf(source: SourceRecord): AltProvider | undefined {
  const p = (source.endpointConfig as unknown as { provider?: unknown }).provider;
  return p === 'yahoo' || p === 'mubasher_csv' || p === 'msx-summary' || p === 'bhb_webapi' || p === 'mubasher_profile'
    ? p
    : undefined;
}

/**
 * True for a CHUNKED ONE-SHOT enrichment — coverage-guarded (injects only un-stamped securities),
 * self-chaining while a full chunk remains, and DORMANT once complete: the provider-routed ohlcv_backfill
 * drain, OR the securities_profile scrape (any provider — Mubasher aggregator or native ADX/MSX). These
 * share the coverage-complete skip + self-chain in runTask.
 */
function isChunkedOneShot(source: SourceRecord): boolean {
  if (source.dataType === 'securities_profile') return true;
  return source.dataType === 'ohlcv_backfill' && providerOf(source) !== undefined;
}

/**
 * Provider-aware resolution (CONTRACT §8 routing extension). A source whose endpoint_config
 * carries an alt provider is served by that aggregator's TaskSpecs, NOT by the (venue,data_type)
 * ADAPTERS lookup — Yahoo/Mubasher are cross-venue aggregators and are intentionally absent from the
 * frozen ADAPTERS map. For 'yahoo': quotes → yahooTasks.quotes (the 2nd cross-check source);
 * ohlcv_backfill → yahooTasks.ohlcvBackfill (the ≥2y daily drain). For 'mubasher_csv':
 * ohlcv_backfill → mubasherTasks.ohlcvCsv (the ADX/MSX/BHB ≥2y CSV drain). Any other data_type on
 * an aggregator row yields no task (returns []) rather than mis-dispatching. Returns undefined for
 * non-provider (primary) sources so the caller falls through to ADAPTERS unchanged.
 */
function tasksForProvider(source: SourceRecord): TaskSpec<unknown>[] | undefined {
  const provider = providerOf(source);
  if (provider === undefined) return undefined;
  if (provider === 'yahoo') {
    if (source.dataType === 'quotes') return [yahooTasks.quotes as TaskSpec<unknown>];
    if (source.dataType === 'ohlcv_backfill') return [yahooTasks.ohlcvBackfill as TaskSpec<unknown>];
    return [];
  }
  if (provider === 'mubasher_csv') {
    if (source.dataType === 'ohlcv_backfill') return [mubasherTasks.ohlcvCsv as TaskSpec<unknown>];
    return [];
  }
  if (provider === 'mubasher_profile') {
    // Mubasher-backed TDWL securities-profile scrape (sector/isin/shares_outstanding), DEF-SECTOR-DATA.
    if (source.dataType === 'securities_profile') return [mubasherTasks.profile as TaskSpec<unknown>];
    return [];
  }
  if (provider === 'msx-summary') {
    if (source.dataType === 'ohlcv_backfill') return [msxHistory as TaskSpec<unknown>];
    return [];
  }
  // provider === 'bhb_webapi' — BHB's own webapi EOD-close-history backfill (DataExportCompanyProfile).
  if (source.dataType === 'ohlcv_backfill') return [bhbOhlcvBackfill as TaskSpec<unknown>];
  return [];
}

/**
 * Load the venue's active securities from public.securities and project them to Yahoo chart
 * symbols (our raw ticker + the venue suffix, via toYahooSymbol). This is the runtime side of the
 * Yahoo symbol-list wiring the adapter flagged (adapters/yahoo/quotes.ts header): the frozen
 * FetchContext gives fetch() no DB handle, so fetch() reads endpoint_config.symbols — and the
 * runtime populates that list from public.securities here (config over code, CONTRACT §0.6), so
 * the symbol universe tracks the live securities master with no redeploy. Non-Yahoo venues
 * (toYahooSymbol → null) and blank tickers are dropped. Order is stable (ticker asc) so the
 * per-cycle request order — and thus the ≤300 req/day/host budget rotation — is deterministic.
 */
/**
 * Listed raw tickers for a venue, ticker-asc. When `unbackfilledOnly`, EXCLUDE securities already
 * backfilled (securities.ohlcv_backfilled_at is set) — this is the coverage guard that lets the ≥2y
 * backfill GRACEFULLY STOP: once every listed security is stamped the list is empty, which runTask
 * reads as "coverage complete → skip the fetch".
 *
 * WHY a sticky flag, not a bar-depth/day threshold: the backfill fetch is ATOMIC — one range=2y GET
 * returns the provider's ENTIRE available window (≈2y for a mature stock, or a young listing's full
 * short history). So a security that has been backfilled ONCE already holds as much history as the
 * provider (Yahoo/Mubasher/MSX) will ever give — "as feasible per provider". The objectifier stamps
 * ohlcv_backfilled_at the moment it lands a security's backfill bars (migration 0041), so no arbitrary
 * day-count is needed and a genuinely young stock is not re-fetched forever.
 *
 * `unbackfilledOnly` is false for live sources (quotes) so those are NEVER coverage-filtered — they
 * must poll the whole universe every cycle. Only the ohlcv_backfill data_type passes true.
 */
/**
 * Max securities an ohlcv_backfill run injects per pass. Deep history (Mubasher gives 20–33y for
 * TDWL/DFM/QE, decades for ADX) means one venue's full sweep is a MARATHON runTask — which, before
 * chunking, held the ingest poller (its Promise.all barrier) and outlived the 15-min stuck-job reaper
 * (double-runs). Capping the injected set makes each backfill job SHORT (finishes in a few minutes);
 * the coverage guard stamps the chunk done, so the next scheduled pass picks up the next chunk, and
 * once a venue is fully seeded the injected set is empty and runTask skips. Frequent backfill cadence
 * (migration) churns the chunks; the continuous-lane poller interleaves them with quotes/filings.
 */
const BACKFILL_CHUNK_SIZE = 25;

/**
 * The per-security coverage stamp a CHUNKED ONE-SHOT data_type drains against (graceful stop). null =
 * not a chunked one-shot (poll the whole universe every cycle — quotes). ohlcv_backfill idles on
 * ohlcv_backfilled_at (0041); securities_profile idles on profile_scraped_at (20260716110000). Both
 * inject only un-stamped securities, chunked, so re-runs fetch only the missing names and the task
 * goes DORMANT (coverage-complete skip in runTask) once every listed security is stamped.
 */
type CoverageColumn = 'ohlcv_backfilled_at' | 'profile_scraped_at' | null;

function coverageColumnFor(dataType: DataType): CoverageColumn {
  if (dataType === 'ohlcv_backfill') return 'ohlcv_backfilled_at';
  if (dataType === 'securities_profile') return 'profile_scraped_at';
  return null;
}

/**
 * Listed raw tickers for a venue, ticker-asc. `coverage` selects the graceful-stop column: an
 * un-stamped-only chunked query (ohlcv_backfilled_at / profile_scraped_at) for a chunked one-shot, or
 * the full listed universe (null) for live sources (quotes) that must poll everything every cycle. The
 * column is a fixed whitelist branched here (never a dynamic identifier) so there is no injection seam.
 */
async function listedTickersForVenue(
  sql: Sql,
  venue: VenueCode,
  coverage: CoverageColumn,
): Promise<string[]> {
  let rows: Array<{ ticker: string }>;
  if (coverage === 'ohlcv_backfilled_at') {
    rows = await sql<{ ticker: string }[]>`
        select s.ticker from public.securities s
         where s.venue_code = ${venue} and s.status = 'listed' and s.ohlcv_backfilled_at is null
         order by s.ticker asc limit ${BACKFILL_CHUNK_SIZE}`;
  } else if (coverage === 'profile_scraped_at') {
    rows = await sql<{ ticker: string }[]>`
        select s.ticker from public.securities s
         where s.venue_code = ${venue} and s.status = 'listed' and s.profile_scraped_at is null
         order by s.ticker asc limit ${BACKFILL_CHUNK_SIZE}`;
  } else {
    rows = await sql<{ ticker: string }[]>`
        select s.ticker from public.securities s
         where s.venue_code = ${venue} and s.status = 'listed'
         order by s.ticker asc`;
  }
  return rows
    .map((r) => r.ticker)
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

export async function yahooSymbolsForVenue(
  sql: Sql,
  venue: VenueCode,
  unbackfilledOnly = false,
): Promise<string[]> {
  const tickers = await listedTickersForVenue(sql, venue, unbackfilledOnly ? 'ohlcv_backfilled_at' : null);
  const out: string[] = [];
  for (const ticker of tickers) {
    const sym = toYahooSymbol(venue, ticker);
    if (sym) out.push(sym);
  }
  return out;
}

/**
 * For a Yahoo provider source, return a source whose endpoint_config.symbols is populated from
 * public.securities (unless the row already carries an explicit symbols list — a Desk override
 * wins, config over code). Non-Yahoo or already-listed sources are returned unchanged (no clone,
 * no query). The clone is shallow but replaces endpointConfig with a new object so the cached
 * SourceRecord the caller holds is never mutated.
 */
export async function withYahooSymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (providerOf(source) !== 'yahoo') return source;
  const cfg = source.endpointConfig as unknown as { symbols?: unknown };
  const already = Array.isArray(cfg.symbols) && cfg.symbols.length > 0;
  if (already) return source;
  const symbols = await yahooSymbolsForVenue(sql, source.venue, source.dataType === 'ohlcv_backfill');
  // ALWAYS set the (possibly empty) list — an empty ohlcv_backfill list is the "coverage complete"
  // signal runTask skips on. A quotes list is never coverage-filtered, so it is empty only when the
  // venue has no Yahoo-mapped securities (the pre-existing base-URL fallback, unchanged).
  return {
    ...source,
    endpointConfig: { ...source.endpointConfig, symbols } as SourceRecord['endpointConfig'],
  };
}

/**
 * For a Mubasher-CSV provider source, populate endpoint_config.symbols with the venue's RAW listed
 * tickers from public.securities — NO Yahoo suffix (the Mubasher stock-page slug IS our raw ticker,
 * e.g. ADX FAB/ALDAR/ADNOCGAS). This is the ADX/MSX/BHB analogue of withYahooSymbols: the frozen
 * FetchContext gives fetch() no DB handle, so the adapter reads endpoint_config.symbols and the
 * runtime populates it here (config over code, CONTRACT §0.6) so the symbol universe tracks the live
 * securities master with no redeploy. Order is stable (ticker asc) for a deterministic per-cycle
 * request order. No-op (returns source unchanged, no clone) for non-Mubasher-CSV sources, for rows
 * that already carry an explicit Desk-set symbols list, or when the venue has no listed securities.
 */
export async function withMubasherCsvSymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (providerOf(source) !== 'mubasher_csv') return source;
  const cfg = source.endpointConfig as unknown as { symbols?: unknown };
  const already = Array.isArray(cfg.symbols) && cfg.symbols.length > 0;
  if (already) return source;
  const symbols = await listedTickersForVenue(sql, source.venue, coverageColumnFor(source.dataType));
  // ALWAYS set the (possibly empty) list — an empty ohlcv_backfill list is the "coverage complete"
  // signal runTask skips on (graceful backfill stop once the venue is fully seeded).
  return {
    ...source,
    endpointConfig: { ...source.endpointConfig, symbols } as SourceRecord['endpointConfig'],
  };
}

/**
 * For an MSX-summary provider source, populate endpoint_config.symbols with the venue's RAW listed
 * MSX tickers from public.securities — NO suffix (the summary-report.aspx/List POST body takes our
 * raw ticker as Symbol, e.g. BKMB/OQGN). This is the MSX analogue of withYahooSymbols/withMubasherCsvSymbols:
 * the frozen FetchContext gives fetch() no DB handle, so the adapter reads endpoint_config.symbols and
 * the runtime populates it here (config over code, CONTRACT §0.6) so the symbol universe tracks the
 * live securities master with no redeploy. Order is stable (ticker asc) for a deterministic per-cycle
 * request order. No-op (returns source unchanged, no clone) for non-MSX-history sources, for rows that
 * already carry an explicit Desk-set symbols list, or when the venue has no listed securities.
 */
export async function withMsxHistorySymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (providerOf(source) !== 'msx-summary') return source;
  const cfg = source.endpointConfig as unknown as { symbols?: unknown };
  const already = Array.isArray(cfg.symbols) && cfg.symbols.length > 0;
  if (already) return source;
  const symbols = await listedTickersForVenue(sql, source.venue, coverageColumnFor(source.dataType));
  // ALWAYS set the (possibly empty) list — an empty ohlcv_backfill list is the "coverage complete"
  // signal runTask skips on (graceful backfill stop once the venue is fully seeded).
  return {
    ...source,
    endpointConfig: { ...source.endpointConfig, symbols } as SourceRecord['endpointConfig'],
  };
}

/**
 * For a BHB-webapi provider source, populate endpoint_config.symbols with the venue's RAW listed BHB
 * tickers from public.securities — NO suffix (DataExportCompanyProfile's parameterValue={symbol} takes
 * our raw ticker, e.g. GFH/BBK/BEYON). This is the BHB analogue of withMsxHistorySymbols /
 * withMubasherCsvSymbols: the frozen FetchContext gives fetch() no DB handle, so the adapter reads
 * endpoint_config.symbols and the runtime populates it here (config over code, CONTRACT §0.6) so the
 * symbol universe tracks the live securities master with no redeploy. Order is stable (ticker asc) for a
 * deterministic per-cycle request order. No-op (returns source unchanged, no clone) for non-BHB-webapi
 * sources, for rows that already carry an explicit Desk-set symbols list, or when the venue has no
 * listed securities.
 */
export async function withBhbWebapiSymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (providerOf(source) !== 'bhb_webapi') return source;
  const cfg = source.endpointConfig as unknown as { symbols?: unknown };
  const already = Array.isArray(cfg.symbols) && cfg.symbols.length > 0;
  if (already) return source;
  const symbols = await listedTickersForVenue(sql, source.venue, coverageColumnFor(source.dataType));
  // ALWAYS set the (possibly empty) list — an empty ohlcv_backfill list is the "coverage complete"
  // signal runTask skips on (graceful backfill stop once the venue is fully seeded).
  return {
    ...source,
    endpointConfig: { ...source.endpointConfig, symbols } as SourceRecord['endpointConfig'],
  };
}

/**
 * For a securities_profile source (any provider — the Mubasher-profile aggregator OR a native ADX/MSX
 * profile adapter), populate endpoint_config.symbols with the venue's RAW listed tickers that are NOT
 * yet profiled (profile_scraped_at IS NULL), chunked to BACKFILL_CHUNK_SIZE. This is the profile
 * analogue of withMubasherCsvSymbols: the frozen FetchContext gives fetch() no DB handle, so the adapter
 * reads endpoint_config.symbols and the runtime populates it here (config over code, CONTRACT §0.6) so
 * the symbol universe tracks the live securities master with no redeploy. ALWAYS sets the (possibly
 * empty) list — an empty list is the "coverage complete" signal runTask skips on (graceful one-shot
 * stop once every listed security is profiled). No-op (returns source unchanged, no clone) for a row
 * that already carries an explicit Desk-set symbols list.
 */
export async function withProfileSymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (source.dataType !== 'securities_profile') return source;
  const cfg = source.endpointConfig as unknown as { symbols?: unknown };
  const already = Array.isArray(cfg.symbols) && cfg.symbols.length > 0;
  if (already) return source;
  const symbols = await listedTickersForVenue(sql, source.venue, 'profile_scraped_at');
  return {
    ...source,
    endpointConfig: { ...source.endpointConfig, symbols } as SourceRecord['endpointConfig'],
  };
}

/**
 * Symbol-injection dispatcher. Routes a source to its symbol-list populator before fetch:
 * securities_profile sources (any provider) get un-profiled RAW listed tickers (withProfileSymbols);
 * Yahoo sources get suffixed Yahoo chart symbols (withYahooSymbols); Mubasher-CSV/MSX-summary/BHB-webapi
 * sources get RAW listed tickers; every other (primary) source is returned unchanged. This is the single
 * call runTask makes so a new aggregator/one-shot only adds one branch here.
 */
export async function withInjectedSymbols(sql: Sql, source: SourceRecord): Promise<SourceRecord> {
  if (source.dataType === 'securities_profile') return withProfileSymbols(sql, source);
  const provider = providerOf(source);
  if (provider === 'yahoo') return withYahooSymbols(sql, source);
  if (provider === 'mubasher_csv') return withMubasherCsvSymbols(sql, source);
  if (provider === 'msx-summary') return withMsxHistorySymbols(sql, source);
  if (provider === 'bhb_webapi') return withBhbWebapiSymbols(sql, source);
  return source;
}

/**
 * Resolve the TaskSpec(s) that serve a source — the single source of truth for
 * IngestionRuntime.tasksForSource (the method delegates here). PURE: no I/O, so it is unit-tested
 * directly (runtime.test.ts) without constructing the DB-backed runtime.
 *
 * Order matters: the provider branch is consulted FIRST. A source with endpoint_config
 * provider='yahoo' resolves to the Yahoo aggregator task and NEVER to the primary (venue,data_type)
 * adapter; every primary source (no provider) falls through to the unchanged ADAPTERS lookup, so
 * DFM/MSX/QE/etc. resolution is byte-identical to the pre-provider behaviour.
 */
export function resolveTasksForSource(source: SourceRecord): TaskSpec<unknown>[] {
  const provided = tasksForProvider(source);
  if (provided !== undefined) return provided;

  const adapter = ADAPTERS[source.venue];
  if (!adapter) return [];
  return tasksForDataType(adapter, source.dataType);
}

/**
 * Map the data_type of a source to the adapter TaskSpec(s) that serve it (CONTRACT §8:
 * indices are folded into the quotes task; filing_detail is enqueued event-driven).
 */
function tasksForDataType(adapter: (typeof ADAPTERS)[VenueCode], dataType: DataType): TaskSpec<unknown>[] {
  const out: TaskSpec<unknown>[] = [];
  switch (dataType) {
    case 'quotes':
    case 'indices':
      if (adapter.quotes) out.push(adapter.quotes as TaskSpec<unknown>);
      if (adapter.indices) out.push(adapter.indices as TaskSpec<unknown>);
      break;
    case 'filings_list':
      if (adapter.filingsList) out.push(adapter.filingsList as TaskSpec<unknown>);
      break;
    case 'filing_detail':
      if (adapter.filingDetail) out.push(adapter.filingDetail as TaskSpec<unknown>);
      break;
    case 'eod_bulletin':
      if (adapter.eodBulletin) out.push(adapter.eodBulletin as TaskSpec<unknown>);
      break;
    case 'dividends':
      if (adapter.dividends) out.push(adapter.dividends as TaskSpec<unknown>);
      break;
    case 'ipo':
      if (adapter.ipo) out.push(adapter.ipo as TaskSpec<unknown>);
      break;
    case 'financials':
      // Per-security financial statements (07 §P1.7b). A venue mounts a financials
      // TaskSpec whose parse() emits NormalizedStatementRow[]; the staging mapper lands
      // them as FILING.FINANCIALS → cross_check → fn_financial_statement_project. No
      // adapter mounts it on main yet (the persist contract ships ahead of a producer).
      if (adapter.financials) out.push(adapter.financials as TaskSpec<unknown>);
      break;
    case 'securities_profile':
      // Per-security profile scrape (sector/isin/shares_outstanding), DEF-SECTOR-DATA (07 §3.3/
      // §P1.7e-I). A venue mounts a securitiesProfile TaskSpec (ADX/MSX native) whose parse() emits
      // NormalizedProfile[]; the staging mapper lands them as PROFILE.SECURITY → cross_check →
      // fn_security_profile_project. TDWL rides the mubasher_profile PROVIDER instead (above).
      if (adapter.securitiesProfile) out.push(adapter.securitiesProfile as TaskSpec<unknown>);
      break;
    default:
      break;
  }
  return out;
}

// ── staging mapper (CONTRACT §6.5) ─────────────────────────────────────────────────────────
//
// Turn a parser's Normalized* rows into lineage-bearing lake StagingRows. PURE: no I/O, no clock
// (extractedAt is derived from the snapshot's business timestamps already carried on the row, never
// Date.now()). The natural_key is deterministic and colon-delimited `OBJECT_TYPE:VENUE:…` so a
// re-parse of the same snapshot yields byte-identical keys (CONTRACT §6.5 example
// `DIVIDEND.EXDATE:TDWL:7010:2026-INT1`); content_hash is the sha256 of the canonicalized payload
// (reusing lake/canonical.contentHash — the SAME helper LakeStagingEmitter re-derives on insert, so
// idempotency on (source_id, external_id, content_hash) holds end to end).
//
// source_rank (CONTRACT §6.5: registrar=10, exchange=20, press=90). ingest.sources carries no rank
// column and SourceRecord no rank field, so rank is derived from the source archetype: every v1
// source is the venue exchange's own site → EXCHANGE_RANK (20). A dividend row that self-declares
// `verification: 'registrar'` is ranked as a registrar (10) — the one payload-driven exception the
// contract names. See the P1 build report / assumptions note.

/** CONTRACT §6.5 primary-wins ranks. Lower wins. */
const REGISTRAR_RANK = 10;
const EXCHANGE_RANK = 20;

/** The exchange-site archetype rank for a v1 source, overridden only by a self-declared registrar. */
function sourceRankFor(_source: SourceRecord): number {
  return EXCHANGE_RANK;
}

/** ISO date (YYYY-MM-DD) portion of an ISO-8601 timestamp; identity for a bare date. */
function dateOnly(iso: string): string {
  const t = iso.indexOf('T');
  return t === -1 ? iso : iso.slice(0, t);
}

function mapQuote(
  source: SourceRecord,
  snapshotId: number,
  q: NormalizedQuote,
  snapshotExtractedAtIso: string,
): StagingRow<NormalizedQuote> {
  // A quote board may carry no per-row print time (the ADX securityBoards feed has no timestamp field);
  // fall back to the snapshot fetch time so the row still has a business time for both the natural-key
  // session and extractedAt. Boards that DO self-timestamp (DFM/QE) keep their own asOf.
  const asOf = q.asOf || snapshotExtractedAtIso;
  const session = dateOnly(asOf);
  return {
    objectType: 'QUOTE.LAST',
    naturalKey: `QUOTE.LAST:${q.venue}:${q.ticker}:${session}`,
    venue: q.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null, // quote boards have no per-row id → dedupe by (source_id, NULL, content_hash)
    sourceRank: sourceRankFor(source),
    payload: q,
    numericValue: q.last ?? null,
    unit: null,
    effectiveDate: session,
    priceSensitive: false,
    extractedAt: asOf,
  };
}

function mapIndex(source: SourceRecord, snapshotId: number, i: NormalizedIndexLevel, venue: VenueCode): StagingRow<NormalizedIndexLevel> {
  const session = dateOnly(i.asOf);
  return {
    objectType: 'INDEX.LEVEL',
    naturalKey: `INDEX.LEVEL:${venue}:${i.indexCode}:${session}`,
    venue,
    sourceId: source.id,
    snapshotId,
    externalId: null,
    sourceRank: sourceRankFor(source),
    payload: i,
    numericValue: i.level,
    unit: null,
    effectiveDate: session,
    priceSensitive: false,
    extractedAt: i.asOf,
  };
}

function mapOhlcv(source: SourceRecord, snapshotId: number, o: NormalizedOhlcv, extractedAt: string): StagingRow<NormalizedOhlcv> {
  return {
    objectType: 'OHLCV.CLOSE',
    naturalKey: `OHLCV.CLOSE:${o.venue}:${o.ticker}:${o.tradeDate}`,
    venue: o.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null, // EOD bulletin rows have no per-row id; identity is (venue, ticker, tradeDate)
    sourceRank: sourceRankFor(source),
    payload: o,
    numericValue: o.close,
    unit: null,
    effectiveDate: o.tradeDate,
    priceSensitive: false,
    extractedAt,
  };
}

function mapFilingRef(source: SourceRecord, snapshotId: number, f: NormalizedFilingRef): StagingRow<NormalizedFilingRef> {
  return {
    objectType: 'FILING.REF',
    naturalKey: `FILING.REF:${f.venue}:${f.externalId}`,
    venue: f.venue,
    sourceId: source.id,
    snapshotId,
    externalId: f.externalId,
    sourceRank: sourceRankFor(source),
    payload: f,
    numericValue: null,
    unit: null,
    effectiveDate: dateOnly(f.filedAt),
    priceSensitive: false,
    extractedAt: f.filedAt,
  };
}

/** filingType families that move the stock ⇒ human-confirm gate (33b) before VERIFIED. */
const PRICE_SENSITIVE_FILINGS = new Set<NormalizedFiling['filingType']>([
  'DIVIDEND',
  'RESULTS',
  'CAPEX',
  'RATING',
  'CONTRACT',
  'PROSPECTUS',
]);

function mapFiling(source: SourceRecord, snapshotId: number, f: NormalizedFiling): StagingRow<NormalizedFiling> {
  return {
    objectType: `FILING.${f.filingType}`,
    naturalKey: `FILING:${f.venue}:${f.externalId}`,
    venue: f.venue,
    sourceId: source.id,
    snapshotId,
    externalId: f.externalId,
    sourceRank: sourceRankFor(source),
    payload: f,
    numericValue: null,
    unit: null,
    effectiveDate: dateOnly(f.filedAt),
    priceSensitive: PRICE_SENSITIVE_FILINGS.has(f.filingType),
    extractedAt: f.filedAt,
  };
}

function mapDividend(source: SourceRecord, snapshotId: number, d: NormalizedDividend, extractedAt: string): StagingRow<NormalizedDividend> {
  const fiscal = d.fiscalRef ?? 'NA';
  return {
    objectType: 'DIVIDEND.DPS',
    naturalKey: `DIVIDEND.DPS:${d.venue}:${d.ticker}:${d.divType}:${fiscal}`,
    venue: d.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null,
    // A registrar-verified dividend is the one payload-driven registrar-rank source (CONTRACT §6.5).
    sourceRank: d.verification === 'registrar' ? REGISTRAR_RANK : sourceRankFor(source),
    payload: d,
    numericValue: d.dps,
    unit: d.currency,
    effectiveDate: d.exDate ?? null,
    priceSensitive: true, // dividends are always a 33b human-confirm fact
    extractedAt,
  };
}

function mapIpo(source: SourceRecord, snapshotId: number, e: NormalizedIpoEvent, extractedAt: string): StagingRow<NormalizedIpoEvent> {
  return {
    objectType: 'IPO.EVENT',
    naturalKey: `IPO.EVENT:${e.venue}:${e.companyName}:${e.stage}`,
    venue: e.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null,
    sourceRank: sourceRankFor(source),
    payload: e,
    numericValue: e.finalPrice ?? e.priceRangeHigh ?? null,
    unit: null,
    effectiveDate: null,
    priceSensitive: e.isPriceSensitive ?? true,
    extractedAt,
  };
}

/**
 * The FILING.FINANCIALS object payload — the WIRE contract lake.fn_financials_project reads
 * (migration 20260716120000). SNAKE_CASE keys to match the projection (and the live Tadawul-XBRL
 * producer's already-shipped contract): `statement_type`/`line_items`/`period_kind`/… — NOT the
 * camelCase NormalizedStatementRow field names. venue+ticker are carried so the projection can
 * resolve security_id when the object doesn't already carry one. Pure financial content only (no
 * clock/snapshot id) so the content_hash is stable ⇒ dedup + restatement detection are correct.
 */
interface FinancialsObjectPayload {
  venue: string;
  ticker: string;
  statement_type: StatementType;
  basis: 'consolidated' | 'standalone';
  period_kind: 'quarter' | 'annual' | 'ttm';
  fiscal_period: string;
  period_end: string;
  currency: string;
  line_items: Record<string, number | null>;
  segments?: Record<string, unknown> | null;
  /** Printed labels in document order (Phase A) → financial_statements.presentation. */
  presentation?: StatementPresentationRow[];
}

function mapStatement(
  source: SourceRecord,
  snapshotId: number,
  s: NormalizedStatementRow,
  extractedAt: string,
): StagingRow<FinancialsObjectPayload> {
  const basis = s.basis ?? 'consolidated';
  const payload: FinancialsObjectPayload = {
    venue: s.venue,
    ticker: s.ticker,
    statement_type: s.statementType,
    basis,
    period_kind: s.periodKind,
    fiscal_period: s.fiscalPeriod,
    period_end: s.periodEnd,
    currency: s.currency,
    line_items: s.lineItems,
    ...(s.segments != null ? { segments: s.segments } : {}),
    ...(s.presentation != null && s.presentation.length > 0 ? { presentation: s.presentation } : {}),
  };
  return {
    objectType: 'FILING.FINANCIALS',
    // One object per (venue, ticker, statement_type, basis, fiscal_period). A RESTATEMENT
    // re-stages the SAME key with new numbers → a fresh content_hash → cross_check supersedes
    // the prior object → lake.fn_financials_project archives the old version and bumps version
    // (07 §P1.7b). is_estimate is not in the key: scraped facts are always the non-estimate row;
    // desk estimates are a separate write path.
    naturalKey: `FILING.FINANCIALS:${s.venue}:${s.ticker}:${s.statementType}:${basis}:${s.fiscalPeriod}`,
    venue: s.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null, // no per-row id; dedupe on (source_id, NULL, content_hash)
    sourceRank: sourceRankFor(source),
    payload,
    numericValue: null, // a statement period is a bag of line items, not one scalar
    unit: s.currency,
    effectiveDate: s.periodEnd,
    // NOT 33b price-sensitive: statements are bulk quantitative facts the ratio job consumes
    // unattended — a 2nd source promotes them to VERIFIED without a human-confirm gate (unlike
    // dividends/IPO price fields). Single-source lands PENDING and still projects (like filings).
    priceSensitive: false,
    extractedAt,
  };
}

function mapProfile(
  source: SourceRecord,
  snapshotId: number,
  p: NormalizedProfile,
  extractedAt: string,
  logger: Logger,
): StagingRow<NormalizedProfile> {
  // An unmappable venue sector falls back to the 'unknown' key — LOG it here (parse() is pure, so the
  // "logged fallback, never silently 'unknown'" discipline is enforced at the map step, where the
  // logger lives). Only warn when there WAS a raw string we failed to classify (rawSector present); a
  // profile with no sector field at all is not a mapping miss. The raw string is also preserved on
  // p.rawSector + the persisted object payload for audit (distinguishable from a never-scraped 'unknown'
  // by securities.profile_scraped_at).
  if (p.sector === 'unknown' && p.rawSector) {
    logger.warn('profile.sector_unmapped', { venue: p.venue, ticker: p.ticker, rawSector: p.rawSector });
  }
  return {
    objectType: 'PROFILE.SECURITY',
    // One object per (venue, ticker). A profile refresh (shares change / late ISIN) re-stages the SAME
    // key with new content → fresh content_hash → cross_check supersedes → fn_security_profile_project
    // updates the securities row in place (20260716110000).
    naturalKey: `PROFILE.SECURITY:${p.venue}:${p.ticker}`,
    venue: p.venue,
    sourceId: source.id,
    snapshotId,
    externalId: null, // one profile per (venue,ticker); dedupe on (source_id, NULL, content_hash)
    sourceRank: sourceRankFor(source),
    payload: p,
    numericValue: null, // a profile is a bag of identity fields, not one scalar
    unit: null,
    effectiveDate: null,
    // NOT price-sensitive: identity facts the ratio/Score engines consume unattended — single-source
    // lands PENDING and still projects (like FILING.FINANCIALS / FILING.REF), no 33b human gate.
    priceSensitive: false,
    extractedAt,
  };
}

/**
 * Map a parser's Normalized* rows → lake StagingRows (CONTRACT §6.5). PURE. Dispatches on the row
 * SHAPE (not just source.dataType, since a `quotes` source runs both the quotes and indices tasks),
 * so a single call always maps one homogeneous batch. `extractedAt` for self-timestamped rows comes
 * from the row's own business time; for the (v1-unused) dividend/IPO shapes it comes from the
 * snapshot fetch time the caller passes in. Unknown shapes are logged once and dropped, never
 * fabricated.
 *
 * Exported for unit testing (staging-map.test.ts): natural_key stability, source_rank propagation,
 * and content_hash determinism/idempotency are load-bearing for cross-check correctness.
 */
export function mapRowsToStaging(
  source: SourceRecord,
  _task: TaskSpec<unknown>,
  snapshotId: number,
  rows: unknown[],
  logger: Logger,
  snapshotExtractedAtIso: string,
): StagingRow<unknown>[] {
  if (rows.length === 0) return [];

  const out: StagingRow<unknown>[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (isQuote(row)) {
      out.push(mapQuote(source, snapshotId, raw as NormalizedQuote, snapshotExtractedAtIso));
    } else if (isIndex(row)) {
      out.push(mapIndex(source, snapshotId, raw as NormalizedIndexLevel, source.venue));
    } else if (isOhlcv(row)) {
      out.push(mapOhlcv(source, snapshotId, raw as NormalizedOhlcv, snapshotExtractedAtIso));
    } else if (isFilingRef(row)) {
      out.push(mapFilingRef(source, snapshotId, raw as NormalizedFilingRef));
    } else if (isFiling(row)) {
      out.push(mapFiling(source, snapshotId, raw as NormalizedFiling));
    } else if (isDividend(row)) {
      out.push(mapDividend(source, snapshotId, raw as NormalizedDividend, snapshotExtractedAtIso));
    } else if (isIpo(row)) {
      out.push(mapIpo(source, snapshotId, raw as NormalizedIpoEvent, snapshotExtractedAtIso));
    } else if (isStatement(row)) {
      out.push(mapStatement(source, snapshotId, raw as NormalizedStatementRow, snapshotExtractedAtIso));
    } else if (isProfile(row)) {
      out.push(mapProfile(source, snapshotId, raw as NormalizedProfile, snapshotExtractedAtIso, logger));
    } else {
      logger.warn('mapRowsToStaging: unrecognized normalized row shape — dropped', {
        dataType: source.dataType,
        venue: source.venue,
        keys: Object.keys(row).slice(0, 8),
      });
    }
  }
  return out;
}

// ── row-shape discriminators (structural; the Normalized* shapes are disjoint on these fields) ──
function has(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}
function isQuote(row: Record<string, unknown>): boolean {
  return has(row, 'ticker') && has(row, 'last') && has(row, 'asOf');
}
function isIndex(row: Record<string, unknown>): boolean {
  return has(row, 'indexCode') && has(row, 'level');
}
function isOhlcv(row: Record<string, unknown>): boolean {
  return has(row, 'ticker') && has(row, 'tradeDate') && has(row, 'close');
}
function isFilingRef(row: Record<string, unknown>): boolean {
  // filings_list ref: carries the list navigation fields (detailUrl) a detail record never has.
  return has(row, 'externalId') && has(row, 'sourceRef') && has(row, 'detailUrl');
}
function isFiling(row: Record<string, unknown>): boolean {
  // filing_detail: the substantive filingType enum, and NOT a list ref (no detailUrl).
  return has(row, 'externalId') && has(row, 'filingType') && !has(row, 'detailUrl');
}
function isDividend(row: Record<string, unknown>): boolean {
  return has(row, 'ticker') && has(row, 'dps') && has(row, 'divType');
}
function isIpo(row: Record<string, unknown>): boolean {
  return has(row, 'companyName') && has(row, 'stage');
}
function isStatement(row: Record<string, unknown>): boolean {
  // financials: the per-period NormalizedStatementRow (07 §P1.7b). statementType + lineItems
  // + fiscalPeriod are unique to it among the Normalized* shapes (disjoint discriminant).
  return has(row, 'statementType') && has(row, 'lineItems') && has(row, 'fiscalPeriod');
}
function isProfile(row: Record<string, unknown>): boolean {
  // securities_profile: the NormalizedProfile identity row (DEF-SECTOR-DATA). rawSector is unique to
  // it among the Normalized* shapes (disjoint discriminant); sharesOutstanding pins it further.
  return has(row, 'ticker') && has(row, 'rawSector') && has(row, 'sharesOutstanding');
}

/**
 * Download one filing PDF and store it in the 'filings' bucket, content-addressed by sha256. PURE of
 * DB — takes the injected transport client + uploader. Resolution order:
 *   1. direct pdfUrl → GET; keep it only if it IS a PDF (content-type or %PDF- magic); a resolver may
 *      salvage a mislabeled response, else it's a clean failure (never store a login/error page as a PDF).
 *   2. no pdfUrl → GET detailUrl; if that is the PDF, use it; else a venue resolver extracts the PDF
 *      href from the detail page and we GET that; no resolver / no link ⇒ clean 'nopdf' failure.
 * Returns ok:false (never throws for an expected miss) so the drain marks the item terminal, not poison.
 */
async function downloadFilingPdf(
  client: HttpClient | BrowserClient,
  uploader: StorageUploader,
  resolver: FilingPdfResolver | undefined,
  venue: VenueCode,
  t: FilingDetailTarget,
  headers: Record<string, string> | undefined,
): Promise<FilingPdfResult> {
  const getOpts = headers ? { headers } : {};
  let bytes: Buffer | null = null;
  let contentType = '';

  const salvage = async (body: Buffer, ct: string): Promise<{ b: Buffer; ct: string } | null> => {
    if (!resolver) return null;
    const u = resolver.extractPdfUrl(body, ct);
    if (!u) return null;
    const r = await client.get(u, getOpts);
    return { b: r.body, ct: r.headers['content-type'] ?? 'application/pdf' };
  };

  if (t.pdfUrl) {
    const r = await client.get(t.pdfUrl, getOpts);
    const ct = r.headers['content-type'] ?? '';
    if (isPdfResponse(ct, r.body)) {
      bytes = r.body;
      contentType = ct || 'application/pdf';
    } else {
      const s = await salvage(r.body, ct);
      if (!s) return { externalId: t.externalId, ok: false, error: `pdfUrl did not return a PDF (${ct || 'no content-type'})` };
      bytes = s.b;
      contentType = s.ct;
    }
  } else if (t.detailUrl) {
    const r = await client.get(t.detailUrl, getOpts);
    const ct = r.headers['content-type'] ?? '';
    if (isPdfResponse(ct, r.body)) {
      bytes = r.body;
      contentType = ct || 'application/pdf';
    } else {
      const s = await salvage(r.body, ct);
      if (!s) return { externalId: t.externalId, ok: false, error: 'no pdf link on detail page' };
      bytes = s.b;
      contentType = s.ct;
    }
  } else {
    return { externalId: t.externalId, ok: false, error: 'target has no detailUrl/pdfUrl' };
  }

  if (!bytes || bytes.length === 0) {
    return { externalId: t.externalId, ok: false, error: 'empty body' };
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ext = pdfExtFor(contentType);
  const key = filingStorageKey(venue, t.ticker ?? null, sha, ext);
  await uploader.upload(key, bytes, contentType || 'application/pdf');
  return {
    externalId: t.externalId,
    ok: true,
    storageKey: key,
    sha256: sha,
    contentType,
    bytes: bytes.length,
  };
}

export function createIngestionRuntime(deps: CreateIngestionRuntimeDeps): IngestionRuntime {
  const { sql } = deps;

  // Config: prefer the worker-supplied env overrides, fall back to the ingestion loader for
  // the tuning knobs (budget, rate limit, inline threshold, bucket).
  const base: IngestionConfig = safeLoadConfig(deps);

  const logger = consoleLogger;

  // Transport clients (shared across tasks; both honor the per-host ≤1 req/s bucket).
  // The DIRECT (no-proxy) http client — the common case (most venues need no proxy).
  const http: HttpClient = createHttpClient({
    ratePerSec: base.perHostRateLimitPerSec,
    budgetPerHostPerDay: base.requestBudgetPerHostPerDay,
    globalConcurrency: base.globalConcurrency,
    defaultTimeoutMs: base.defaultTimeoutMs,
    logger,
  });

  // Per-source PROXIED http clients (P1.7a). A source whose endpoint_config.use_proxy
  // is true (Yahoo 429-rotation, BHB WAF) must egress through the IPRoyal proxy —
  // otherwise 0027/0020 are inert and the request leaks from the bare VPS IP (Yahoo
  // 429 / BHB 403). resolveProxyForSource reads use_proxy + proxy_mode and encodes the
  // rotate/sticky policy into the returned config; makeProxiedTransport (inside
  // createHttpClient) then opens a fresh tunnel/request for 'rotate' or reuses one for
  // 'sticky'. Cached by proxy URI + throttle profile so 'rotate' and 'sticky' variants,
  // distinct geo passwords, AND the high-throughput ohlcv_backfill profile each get their
  // own client + rate-limit buckets. A flagged
  // source with NO proxy configured in env falls back to the direct client and logs a
  // loud warning rather than silently leaking — the worker treats a missing-but-required
  // proxy as non-fatal here (the eventual 429/403 surfaces via the normal failure path).
  const httpClientCache = new Map<string, HttpClient>();
  function httpClientForSource(source: SourceRecord): HttpClient {
    // The ohlcv_backfill drain gets its own throttle profile (P1.7a): high concurrency +
    // rate + per-host budget, because it rotates a fresh exit IP per request (the origin
    // never attributes the burst to one client) and the whole ≥2y universe must clear in
    // one sweep. Every other data_type keeps the polite ≤1 req/s, 300/day profile.
    const isBackfill = source.dataType === 'ohlcv_backfill';
    const concurrency = isBackfill ? base.backfillConcurrency : base.globalConcurrency;
    const ratePerSec = isBackfill ? base.backfillRatePerSec : base.perHostRateLimitPerSec;
    const budget = isBackfill ? base.backfillBudgetPerHostPerDay : base.requestBudgetPerHostPerDay;

    // Opt-in curl transport (endpoint_config.use_curl): some origins RESET undici's TLS handshake from
    // the VPS IP but accept curl's (QE's Akamai on the live board). DIRECT only — a use_curl source must
    // not also be use_proxy (curl+proxy is unwired); if both are set, curl wins and egresses direct.
    if ((source.endpointConfig as { use_curl?: unknown }).use_curl === true) {
      const key = `curl|c${concurrency}|r${ratePerSec}`;
      let client = httpClientCache.get(key);
      if (!client) {
        client = createHttpClient({
          ratePerSec,
          budgetPerHostPerDay: budget,
          globalConcurrency: concurrency,
          defaultTimeoutMs: base.defaultTimeoutMs,
          logger,
          transport: makeCurlTransport(),
        });
        httpClientCache.set(key, client);
      }
      return client;
    }

    let proxy: ProxyConfig | undefined;
    try {
      proxy = resolveProxyForSource(source);
    } catch {
      proxy = undefined;
    }
    if (!proxy) {
      if ((source.endpointConfig as { use_proxy?: unknown }).use_proxy === true) {
        logger.warn('source flagged use_proxy but no proxy resolved — egressing DIRECT', {
          venue: source.venue,
          dataType: source.dataType,
          sourceId: source.id,
        });
      }
      // Common case: a non-backfill DIRECT source reuses the shared polite client. A
      // DIRECT backfill (unflagged / misconfigured) still gets its own high-throughput
      // client so behaviour is predictable — it will 429 against the bare IP, but that is
      // an operator misconfig the warning above already surfaces, not a silent throttle.
      if (!isBackfill) return http;
    }
    // Cache key carries the throttle profile so the backfill client is never conflated
    // with the quote client for the same proxy URI (both rotate through the same IPRoyal
    // gateway but must not share one rate-limit bucket).
    const key = proxy
      ? `${proxyToUrl(proxy)}|${proxy.mode ?? 'rotate'}|c${concurrency}|r${ratePerSec}`
      : `direct|c${concurrency}|r${ratePerSec}`;
    let client = httpClientCache.get(key);
    if (!client) {
      client = createHttpClient({
        ratePerSec,
        budgetPerHostPerDay: budget,
        globalConcurrency: concurrency,
        defaultTimeoutMs: base.defaultTimeoutMs,
        logger,
        ...(proxy ? { proxy } : {}),
      });
      httpClientCache.set(key, client);
    }
    return client;
  }

  const browser: BrowserClient = createBrowserClient({
    driver: createPlaywrightDriver(),
    ratePerSec: base.perHostRateLimitPerSec,
    budgetPerHostPerDay: base.requestBudgetPerHostPerDay,
    globalConcurrency: base.globalConcurrency,
    defaultTimeoutMs: base.defaultTimeoutMs,
    logger,
  });

  // Storage uploader (large-blob path) — only constructible when the service-role key + URL
  // are present. Absent ⇒ snapshot store keeps everything inline (fine for small boards).
  let uploader: StorageUploader | undefined;
  if (base.supabaseUrl && base.supabaseServiceRoleKey) {
    uploader = createStorageUploader({
      supabaseUrl: base.supabaseUrl,
      serviceRoleKey: base.supabaseServiceRoleKey,
      bucket: base.rawBucket,
      logger,
    });
  }

  // Second uploader for the PUBLIC 'filings' bucket — where filing PDFs are served from (295 objects
  // live, layout {venue}/{ticker}/…). Distinct from the private lake-raw snapshot store. Absent when
  // the service-role key is missing (local/tests) — fetchFilingPdfs then returns a clean error, never
  // silently drops the artifact.
  let filingsUploader: StorageUploader | undefined;
  if (base.supabaseUrl && base.supabaseServiceRoleKey) {
    filingsUploader = createStorageUploader({
      supabaseUrl: base.supabaseUrl,
      serviceRoleKey: base.supabaseServiceRoleKey,
      bucket: 'filings',
      logger,
    });
  }

  const snapshotStore: SnapshotStore = createSnapshotStore({ sql, config: base, uploader, logger });
  const parseRecorder: ParseRunRecorder = createParseRunRecorder(sql);
  const stagingEmitter = new LakeStagingEmitter(sql as never, logger);
  const crossCheck = new LakeCrossCheck(sql as never, { logger });
  const keyRatios = new KeyRatiosRecompute(sql as never, { logger });
  const scores = new ScoresRecompute(sql as never, { logger });

  const principalCache = new Map<string, string>();
  async function principalIdFor(handle: string): Promise<string> {
    const cached = principalCache.get(handle);
    if (cached) return cached;
    const id = await resolvePrincipalId(sql, handle);
    principalCache.set(handle, id);
    return id;
  }

  const runtime: IngestionRuntime = {
    loadSource(sourceId) {
      return loadSource(sql, sourceId);
    },

    agentAccountForSource(source) {
      return agentAccountFor(source.venue, source.dataType);
    },

    tasksForSource(source) {
      return resolveTasksForSource(source);
    },

    async eodSourcesForVenue(venue) {
      return loadSourcesForVenue(sql, venue, { activeOnly: true, dataType: 'eod_bulletin' });
    },

    async filingDetailSourceId(venue) {
      const rows = await loadSourcesForVenue(sql, venue, {
        activeOnly: true,
        dataType: 'filing_detail',
      });
      return rows.length > 0 ? rows[0]!.id : null;
    },

    async fetchFilingPdfs({ source, targets, agentPrincipalId }) {
      void agentPrincipalId; // no lake write here — DB linkage is the worker handler's identity tx.
      const results: FilingPdfResult[] = [];
      if (targets.length === 0) return results;
      if (!filingsUploader) {
        for (const t of targets) {
          results.push({
            externalId: t.externalId,
            ok: false,
            error: 'filings Storage uploader unconfigured (no service-role key)',
          });
        }
        return results;
      }

      const useBrowser = source.transport === 'http_bootstrap' || source.transport === 'headless';
      const client: HttpClient | BrowserClient = useBrowser ? browser : httpClientForSource(source);
      const cfg = source.endpointConfig as unknown as {
        actionDiscovery?: EndpointConfig['actionDiscovery'];
        headers?: Record<string, string>;
      };
      // WAF venues (TDWL/ADX): seat cookies ONCE per drain so the in-context PDF GETs pass Akamai.
      // A bootstrap failure is non-fatal — BrowserClient.get() self-seats via its one-free-retry on a
      // 401/403 (core/browser.ts), so we only lose the pre-seat optimization.
      if (useBrowser && cfg.actionDiscovery) {
        try {
          await browser.bootstrap(cfg.actionDiscovery);
        } catch (err) {
          logger.warn('filing_detail bootstrap failed (continuing; get() self-retries)', {
            venue: source.venue,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const resolver = FILING_PDF_RESOLVERS[source.venue];
      // Sequential drain: the transport's per-host ≤1 req/s bucket already paces this; the handler
      // caps the chunk size so a burst of new announcements never starves quote lanes.
      for (const t of targets) {
        try {
          results.push(
            await downloadFilingPdf(client, filingsUploader, resolver, source.venue, t, cfg.headers),
          );
        } catch (err) {
          results.push({
            externalId: t.externalId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    },

    crossCheck,

    async pipelinePrincipalId() {
      // Cross-check / pipeline stages run AS the SYSTEM agent (no dedicated cross-check
      // principal in the live iam seed — see lake/cross-check.ts).
      return principalIdFor('SYSTEM');
    },

    async recomputeKeyRatios(securityIds) {
      const summary = await keyRatios.run(securityIds);
      return { rowsWritten: summary.rowsWritten };
    },

    async runScoreBatch(securityIds) {
      // The Marsad Score batch (07 §3.6): re-rank the eligible universe off fresh
      // key_ratios into public.scores / score_history / score_events + COMPUTED.SCORE
      // lake objects. Freshness-gate aborts (StaleKeyRatiosError) and empty-universe
      // (scored:0) are handled inside the service; both surface honestly to the handler.
      const summary = await scores.run(securityIds);
      return { scored: summary.scored };
    },

    async countStagingSources(naturalKey, objectType) {
      const rows = await sql<{ n: string }[]>`
        select count(distinct source_id)::text as n
          from lake.staging_rows
         where natural_key = ${naturalKey} and object_type = ${objectType}
      `;
      return rows.length > 0 ? Number(rows[0]!.n) : 0;
    },

    async runTask({ source: rawSource, task, agentPrincipalId, tradeDate }) {
      // Aggregator provider sources are per-symbol: populate endpoint_config.symbols from
      // public.securities before fetch (the adapter's fetch() has no DB handle). withInjectedSymbols
      // routes Yahoo → suffixed chart symbols, Mubasher-CSV → RAW listed tickers. No-op for primary
      // sources and for aggregator rows that already carry an explicit Desk-set symbol list.
      const source = await withInjectedSymbols(sql, rawSource);

      // Graceful one-shot stop (coverage guard): a CHUNKED ONE-SHOT (ohlcv_backfill or
      // securities_profile) whose injected symbol set came back EMPTY means every listed security for
      // the venue is already covered (listedTickersForVenue filtered them all out on the coverage
      // stamp). Skip the fetch entirely — the daily schedule keeps ticking and heart-beating, but does
      // no work until a new listing (or a profile refresh) drops a security back below coverage. Scoped
      // to chunked one-shots so live quote polling is never affected.
      if (isChunkedOneShot(rawSource)) {
        const injected = (source.endpointConfig as unknown as { symbols?: unknown }).symbols;
        if (Array.isArray(injected) && injected.length === 0) {
          logger?.info?.('chunked one-shot coverage complete — skipping fetch', {
            venue: source.venue,
            dataType: rawSource.dataType,
          });
          return {
            changed: false,
            snapshotId: null,
            rowsEmitted: 0,
            stagedKeys: [],
            newExternalIds: [],
            filingRefs: [],
            parserVersion: task.parserVersion,
          };
        }
      }

      // Per-source egress: a use_proxy source (Yahoo 429-rotation via 0027, BHB WAF via
      // 0020) gets the IPRoyal-proxied http client; everything else the direct one. This
      // is the seam that makes 0027/0020 actually take effect — without it the proxy
      // policy in endpoint_config is inert and Yahoo/BHB egress the bare VPS IP.
      const sourceHttp = httpClientForSource(source);

      let changed = false;
      let lastSnapshotId: number | null = null;
      let rowsEmitted = 0;
      const stagedKeys: StagedKey[] = [];
      const newExternalIds: string[] = [];
      const filingRefs: FilingDetailTarget[] = [];
      let parserVersion = task.parserVersion;

      // Process ONE fetched result end-to-end: snapshot-first → pure parse → map → stage.
      // Shared by BOTH the streaming sink (ctx.onFetched, per-symbol as it lands — the Yahoo
      // backfill) and the classic returned-array loop below, so staging + cross-check
      // semantics are byte-identical whichever path a task takes. Idempotent: snapshot dedup
      // skips unchanged bytes and staging upserts on (source_id, external_id, content_hash),
      // so a re-run or a crash mid-sweep is safe. Accumulator mutations are single-statement
      // (no await between read and write) so they are safe under the sink's bounded concurrency.
      const processOne = async (f: FetchResult): Promise<void> => {
        // 1. Snapshot-first: store raw bytes (dedup on normalized hash).
        const put = await snapshotStore.put({ source, fetched: f, agentPrincipalId });
        if (put.deduped) return; // unchanged: heartbeat only, no parse.
        changed = true;
        lastSnapshotId = put.snapshotId;
        if (f.externalId) newExternalIds.push(f.externalId);

        // 2. Pure parse against the STORED snapshot.
        const stored = await snapshotStore.load(put.snapshotId);
        const parsed = await runParse(task, stored, { recorder: parseRecorder, logger });
        parserVersion = parsed.parserVersion;
        if (parsed.status !== 'ok') return; // error / drift_zero_rows: no staging.

        // 3. Map → lake staging (CONTRACT §6.5). Self-timestamped rows (quotes/OHLCV/filings)
        //    stamp extractedAt from their own business time; rows without one fall back to the
        //    snapshot's fetch time.
        const staging = mapRowsToStaging(source, task, put.snapshotId, parsed.rows, logger, stored.fetchedAt);
        if (staging.length > 0) {
          await stagingEmitter.emit(staging);
          rowsEmitted += staging.length;
          for (const r of staging) stagedKeys.push({ naturalKey: r.naturalKey, objectType: r.objectType });
        }

        // 4. filings_list only: surface every parsed NormalizedFilingRef so the handler can list-diff
        //    it against ingest.seen_items and enqueue detail fetches for the genuinely-new ids (gap #3).
        //    Uses the SAME structural discriminator the staging mapper uses (isFilingRef), so a row is a
        //    detail target iff it staged as FILING.REF.
        if (source.dataType === 'filings_list') {
          for (const raw of parsed.rows as unknown[]) {
            const row = raw as Record<string, unknown>;
            if (!isFilingRef(row)) continue;
            filingRefs.push({
              externalId: String(row.externalId),
              detailUrl: typeof row.detailUrl === 'string' && row.detailUrl !== '' ? row.detailUrl : null,
              pdfUrl: typeof row.pdfUrl === 'string' && row.pdfUrl !== '' ? row.pdfUrl : null,
              title: typeof row.title === 'string' ? row.title : null,
              filedAt: typeof row.filedAt === 'string' ? row.filedAt : null,
            });
          }
        }
      };

      const ctx: FetchContext = {
        source,
        http: sourceHttp,
        browser,
        logger,
        now: () => new Date().toISOString(),
        // Streaming seam (P1.7a): a many-result fetch (the ≥2y OHLCV backfill: one GET per
        // symbol) pushes each result here as it lands so bars accrue progressively and a
        // mid-sweep crash keeps everything already staged. It then returns [] (nothing left
        // to process). Every other adapter ignores this and returns its array, processed below.
        onFetched: processOne,
      };

      const fetched: FetchResult[] = await task.fetch(ctx);
      for (const f of fetched) {
        await processOne(f);
      }

      // Self-chained chunking for CHUNKED ONE-SHOTS. listedTickersForVenue caps the injected set to
      // BACKFILL_CHUNK_SIZE, so a FULL chunk means more un-covered securities remain for this venue.
      // Enqueue the NEXT chunk after a cooldown, long enough for the stamp of THIS chunk to land so the
      // next injection is fresh (no re-fetch race); self-limiting: a short chunk (venue nearly done) does
      // not chain, and a fully-covered venue never injects (the coverage-complete skip above returns
      // first). The cooldown differs by budget:
      //   • ohlcv_backfill — 3 min: it runs on the high-throughput backfill request budget (thousands/
      //     day/host) and the objectifier (0041) stamps within that window.
      //   • securities_profile — 180 min: it shares the NORMAL 300 req/day/host budget WITH live quotes
      //     (Mubasher host also serves TDWL quotes), so ~25 GETs/chunk × 8 chunks/day ≈ 200/day keeps
      //     well under the cap; and the sweep→cross_check→projection stamp lands far inside 180 min.
      // Each chunk job stays short (≤25 GETs) so it never head-of-line-blocks the continuous-lane poller
      // nor outlives the 15-min stuck reaper.
      if (isChunkedOneShot(rawSource)) {
        const injected = (source.endpointConfig as unknown as { symbols?: unknown }).symbols;
        if (Array.isArray(injected) && injected.length >= BACKFILL_CHUNK_SIZE) {
          const delayMinutes = rawSource.dataType === 'securities_profile' ? 180 : 3;
          await sql`
            insert into ingest.job_queue (source_id, run_after, priority, status)
            values (${rawSource.id}, now() + make_interval(mins => ${delayMinutes}), 5, 'queued')
          `;
        }
      }

      void tradeDate; // consumed by the staging mapper (EOD trade_date stamping) once wired.
      return { changed, snapshotId: lastSnapshotId, rowsEmitted, stagedKeys, newExternalIds, filingRefs, parserVersion };
    },
  };

  return runtime;
}

/**
 * Build an IngestionConfig from the worker-supplied deps, tolerating the case where
 * SUPABASE_DB_URL is not in this process's env (the worker owns the pool, not the URL). We
 * only need the URL for the standalone loadConfig() path; when the worker passes its own sql
 * pool we synthesize a config and read the tuning knobs from process.env directly.
 */
function safeLoadConfig(deps: CreateIngestionRuntimeDeps): IngestionConfig {
  try {
    const cfg = loadConfig();
    return {
      ...cfg,
      supabaseUrl: deps.supabaseUrl ?? cfg.supabaseUrl,
      supabaseServiceRoleKey: deps.supabaseServiceRoleKey ?? cfg.supabaseServiceRoleKey,
      workerId: deps.workerId || cfg.workerId,
    };
  } catch {
    // No SUPABASE_DB_URL in env (worker owns the pool). Synthesize a config.
    const env = process.env;
    return {
      dbUrl: '',
      supabaseUrl: deps.supabaseUrl,
      supabaseServiceRoleKey: deps.supabaseServiceRoleKey,
      workerId: deps.workerId || 'ingestion',
      requestBudgetPerHostPerDay: intFromEnv(env.INGEST_REQ_BUDGET_PER_HOST_DAY, 300),
      perHostRateLimitPerSec: floatFromEnv(env.INGEST_PER_HOST_RPS, 1),
      globalConcurrency: intFromEnv(env.INGEST_GLOBAL_CONCURRENCY, 4),
      backfillConcurrency: intFromEnv(env.INGEST_BACKFILL_CONCURRENCY, 10),
      backfillRatePerSec: floatFromEnv(env.INGEST_BACKFILL_RPS, 8),
      backfillBudgetPerHostPerDay: intFromEnv(env.INGEST_BACKFILL_REQ_BUDGET, 5_000),
      defaultTimeoutMs: intFromEnv(env.INGEST_DEFAULT_TIMEOUT_MS, 20_000),
      inlineMaxBytes: intFromEnv(env.INGEST_INLINE_MAX_BYTES, 32_768),
      rawBucket: env.INGEST_RAW_BUCKET || 'lake-raw',
    };
  }
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function floatFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

import type { Sql } from './core/db.js';
import { loadConfig, type IngestionConfig } from './core/config.js';
import { createHttpClient } from './core/fetcher.js';
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
import { LakeStagingEmitter } from './lake/staging.js';
import { LakeCrossCheck } from './lake/cross-check.js';
import { KeyRatiosRecompute } from './lake/key-ratios.js';
import { contentHash } from './lake/canonical.js';
import type {
  SourceRecord,
  VenueCode,
  DataType,
  AgentAccount,
  TaskSpec,
  FetchResult,
  FetchContext,
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
} from './core/types.js';

// ── The narrow runtime surface the worker handlers call (mirrors
//    worker/src/handlers/ingestion-runtime.ts; structurally identical). ────────────────────

export interface StagedKey {
  naturalKey: string;
  objectType: string;
}

export interface RunTaskResult {
  changed: boolean;
  snapshotId: number | null;
  rowsEmitted: number;
  stagedKeys: StagedKey[];
  newExternalIds: string[];
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
  crossCheck: CrossCheck;
  pipelinePrincipalId(): Promise<string>;
  recomputeKeyRatios(securityIds?: number[]): Promise<{ rowsWritten: number }>;
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

function mapQuote(source: SourceRecord, snapshotId: number, q: NormalizedQuote): StagingRow<NormalizedQuote> {
  const session = dateOnly(q.asOf);
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
    extractedAt: q.asOf,
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
      out.push(mapQuote(source, snapshotId, raw as NormalizedQuote));
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

export function createIngestionRuntime(deps: CreateIngestionRuntimeDeps): IngestionRuntime {
  const { sql } = deps;

  // Config: prefer the worker-supplied env overrides, fall back to the ingestion loader for
  // the tuning knobs (budget, rate limit, inline threshold, bucket).
  const base: IngestionConfig = safeLoadConfig(deps);

  const logger = consoleLogger;

  // Transport clients (shared across tasks; both honor the per-host ≤1 req/s bucket).
  const http: HttpClient = createHttpClient({
    ratePerSec: base.perHostRateLimitPerSec,
    budgetPerHostPerDay: base.requestBudgetPerHostPerDay,
    globalConcurrency: base.globalConcurrency,
    defaultTimeoutMs: base.defaultTimeoutMs,
    logger,
  });

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

  const snapshotStore: SnapshotStore = createSnapshotStore({ sql, config: base, uploader, logger });
  const parseRecorder: ParseRunRecorder = createParseRunRecorder(sql);
  const stagingEmitter = new LakeStagingEmitter(sql as never, logger);
  const crossCheck = new LakeCrossCheck(sql as never, { logger });
  const keyRatios = new KeyRatiosRecompute(sql as never, { logger });

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
      const adapter = ADAPTERS[source.venue];
      if (!adapter) return [];
      return tasksForDataType(adapter, source.dataType);
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

    async countStagingSources(naturalKey, objectType) {
      const rows = await sql<{ n: string }[]>`
        select count(distinct source_id)::text as n
          from lake.staging_rows
         where natural_key = ${naturalKey} and object_type = ${objectType}
      `;
      return rows.length > 0 ? Number(rows[0]!.n) : 0;
    },

    async runTask({ source, task, agentPrincipalId, tradeDate }) {
      const client = source.transport === 'http' ? http : browser;
      const ctx: FetchContext = {
        source,
        http,
        browser,
        logger,
        now: () => new Date().toISOString(),
      };
      void client; // transport is picked inside the adapter via ctx.http/ctx.browser

      const fetched: FetchResult[] = await task.fetch(ctx);

      let changed = false;
      let lastSnapshotId: number | null = null;
      let rowsEmitted = 0;
      const stagedKeys: StagedKey[] = [];
      const newExternalIds: string[] = [];
      let parserVersion = task.parserVersion;

      for (const f of fetched) {
        // 1. Snapshot-first: store raw bytes (dedup on normalized hash).
        const put = await snapshotStore.put({ source, fetched: f, agentPrincipalId });
        if (put.deduped) continue; // unchanged: heartbeat only, no parse.
        changed = true;
        lastSnapshotId = put.snapshotId;
        if (f.externalId) newExternalIds.push(f.externalId);

        // 2. Pure parse against the STORED snapshot.
        const stored = await snapshotStore.load(put.snapshotId);
        const parsed = await runParse(task, stored, { recorder: parseRecorder, logger });
        parserVersion = parsed.parserVersion;
        if (parsed.status !== 'ok') continue; // error / drift_zero_rows: no staging.

        // 3. Map → lake staging (CONTRACT §6.5). Self-timestamped rows (quotes/OHLCV/filings)
        //    stamp extractedAt from their own business time; rows without one fall back to the
        //    snapshot's fetch time.
        const staging = mapRowsToStaging(source, task, put.snapshotId, parsed.rows, logger, stored.fetchedAt);
        if (staging.length > 0) {
          await stagingEmitter.emit(staging);
          rowsEmitted += staging.length;
          for (const r of staging) stagedKeys.push({ naturalKey: r.naturalKey, objectType: r.objectType });
        }
      }

      void tradeDate; // consumed by the staging mapper (EOD trade_date stamping) once wired.
      return { changed, snapshotId: lastSnapshotId, rowsEmitted, stagedKeys, newExternalIds, parserVersion };
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

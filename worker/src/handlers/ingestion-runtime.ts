/**
 * The ingestion runtime seam.
 *
 * The heavy lifting for P1 ingestion (transport clients, snapshot store,
 * parse-harness, adapters, cross-check, staging) lives in the standalone
 * `marsad-ingestion` package (`ingestion/`), which runs on this same VPS worker
 * process. The worker's job is orchestration only: claim work, set identity,
 * drive fetch→snapshot→parse→stage, and record heartbeats. Per the CONTRACT
 * (§9) "Keep handlers thin; logic lives in ingestion/".
 *
 * This module declares the *narrow* surface the handlers depend on. At runtime
 * the concrete implementations are supplied by `createIngestionRuntime()` in
 * `./runtime-wiring.ts`, which imports them from `marsad-ingestion`. Declaring
 * the seam here (rather than importing the package directly into every handler)
 * keeps the handlers unit-testable with fakes and decouples this module's build
 * from the ingestion package's build graph.
 *
 * The type names below mirror the frozen CONTRACT §2–§9 surface exactly; the
 * concrete objects that satisfy them ARE the contract's `SourceRecord`,
 * `VenueAdapter`, `SnapshotStore`, etc.
 */

// --- frozen contract mirrors (CONTRACT §2) ---------------------------------

export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

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

export type Transport = 'http' | 'http_bootstrap' | 'headless';

export type AgentAccount =
  | 'DATA-TDWL'
  | 'DATA-DFM'
  | 'DATA-ADX'
  | 'DATA-QE'
  | 'DATA-MSX'
  | 'DATA-BHB'
  | 'DATA-FILINGS';

/** One ingest.sources row (CONTRACT §2). Only the fields handlers read/branch on. */
export interface SourceRecord {
  id: number;
  venue: VenueCode;
  dataType: DataType;
  entryUrl: string;
  transport: Transport;
  active: boolean;
  lastContentHash: string | null;
  // endpoint_config / normalize_rules are consumed inside the ingestion runtime,
  // not the handlers, so they are opaque here.
  [k: string]: unknown;
}

/** Raw fetch result, verbatim, pre-parse (CONTRACT §2). */
export interface FetchResult {
  externalId?: string;
  url: string;
  contentType: string;
  httpStatus: number;
  body: Buffer;
  fetchedAt: string;
  meta?: Record<string, unknown>;
}

/** A stored, immutable snapshot — the pure input to parse() (CONTRACT §2). */
export interface StoredSnapshot {
  snapshotId: number;
  sourceId: number;
  venue: VenueCode;
  dataType: DataType;
  contentType: string;
  externalId: string | null;
  body: Buffer;
  fetchedAt: string;
  meta: Record<string, unknown>;
}

export interface ParseResult<T> {
  rows: T[];
  parserVersion: number;
}

/** A data-type task on one venue (CONTRACT §2). fetch is impure, parse is pure. */
export interface TaskSpec<T = unknown> {
  dataType: DataType;
  parserVersion: number;
  fetch(ctx: FetchContext): Promise<FetchResult[]>;
  parse(snapshot: StoredSnapshot): ParseResult<T>;
}

export interface VenueAdapter {
  venue: VenueCode;
  agentAccount: AgentAccount;
  quotes?: TaskSpec;
  indices?: TaskSpec;
  filingsList?: TaskSpec;
  filingDetail?: TaskSpec;
  dividends?: TaskSpec;
  eodBulletin?: TaskSpec;
  ipo?: TaskSpec;
}

/** Everything a TaskSpec.fetch() receives (CONTRACT §3). */
export interface FetchContext {
  source: SourceRecord;
  http: unknown; // HttpClient — opaque to the worker
  browser: unknown; // BrowserClient — opaque to the worker
  logger: unknown; // ingestion Logger — built by the runtime
  now(): string;
}

/** SnapshotStore.put() result (CONTRACT §4). */
export interface PutSnapshotResult {
  snapshotId: number;
  lakeSnapshotId: number;
  sha256: string;
  deduped: boolean;
  storagePath: string | null;
  bytesStored: number;
}

export interface PutSnapshotInput {
  source: SourceRecord;
  fetched: FetchResult;
  agentPrincipalId: string;
}

export interface SnapshotStore {
  put(input: PutSnapshotInput): Promise<PutSnapshotResult>;
  load(snapshotId: number): Promise<StoredSnapshot>;
}

/** ingest.parse_runs recorder (CONTRACT §4). */
export interface ParseRunRecorder {
  record(input: {
    snapshotId: number;
    parserVersion: number;
    status: 'ok' | 'error' | 'drift_zero_rows';
    rowsEmitted: number | null;
    error?: string | null;
  }): Promise<number>;
}

/** Idempotent ingestion→lake staging emit (CONTRACT §6.5). */
export interface StagingRow<T = unknown> {
  objectType: string;
  naturalKey: string;
  venue: VenueCode;
  sourceId: number;
  snapshotId: number;
  externalId: string | null;
  sourceRank: number;
  payload: T;
  numericValue?: number | null;
  unit?: string | null;
  effectiveDate?: string | null;
  priceSensitive?: boolean;
  extractedAt: string;
}

export interface StagingEmitter {
  emit<T>(rows: StagingRow<T>[]): Promise<void>;
}

/** CrossCheck service (CONTRACT §7). */
export interface CrossCheckInput {
  naturalKey: string;
  objectType: string;
}
export interface CrossCheckResult {
  objectId: string;
  state: 'PENDING' | 'VERIFIED' | 'CONFLICT';
  revision: number;
}
export interface CrossCheck {
  resolve(input: CrossCheckInput): Promise<CrossCheckResult>;
}

/**
 * A staging row the ingestion mapper produced but which carries a stable
 * (naturalKey, objectType) the handler can turn into a `cross_check` job when a
 * second source is present. The full StagingRow is emitted by the runtime; the
 * handler only needs the cross-check coordinates back to enqueue follow-up work.
 */
export interface StagedKey {
  naturalKey: string;
  objectType: string;
}

/**
 * Result of running one TaskSpec end to end (fetch → snapshot → parse → stage)
 * for a single source, produced by the ingestion runtime's pipeline. Handlers
 * consume this to decide follow-up enqueues; they never touch transport/parse.
 */
export interface RunTaskResult {
  /** false ⇒ content unchanged; snapshot deduped, no parse ran (heartbeat only). */
  changed: boolean;
  /** snapshot id when a new snapshot was stored, else null (deduped runs). */
  snapshotId: number | null;
  /** typed staging rows emitted (already persisted idempotently by the runtime). */
  rowsEmitted: number;
  /** cross-check coordinates for every distinct object the parse produced. */
  stagedKeys: StagedKey[];
  /** new external_ids seen this run (filings list-diff → filing_detail follow-up). */
  newExternalIds: string[];
  /** parser version that ran (for logging / parse_runs). */
  parserVersion: number;
}

/** How many independent sources currently stage a given natural key. */
export interface SourceCountByKey {
  (naturalKey: string, objectType: string): Promise<number>;
}

/**
 * The ingestion runtime handed to every handler. `runTask` is the whole
 * fetch→snapshot→parse→stage pipeline for one (source, task) pair, implemented
 * in `ingestion/src/core` + `ingestion/src/lake`. The worker supplies identity,
 * the DB connection, and follow-up enqueues.
 */
export interface IngestionRuntime {
  /** Resolve an ingest.sources row into a typed SourceRecord (registry.loadSource). */
  loadSource(sourceId: number): Promise<SourceRecord>;

  /** The DATA agent principal handle that owns work for a source. */
  agentAccountForSource(source: SourceRecord): AgentAccount;

  /**
   * Run one venue TaskSpec end to end for a source:
   *   fetch (via the transport picked from source.transport)
   *   → SnapshotStore.put (normalize→hash→dedup→store)
   *   → if changed: parse-harness (pure parse + zod) → StagingEmitter.emit
   *   → record ingest.parse_runs + ingest.fetch_log.
   * Returns what the handler needs for follow-up (cross-check / filing_detail).
   *
   * `tradeDate` (YYYY-MM-DD) is passed for EOD runs so bulletin parsers/staging
   * stamp the correct trade_date; omitted for intraday polls.
   */
  runTask(input: {
    source: SourceRecord;
    task: TaskSpec;
    agentPrincipalId: string;
    tradeDate?: string;
  }): Promise<RunTaskResult>;

  /** Pick the adapter TaskSpec for a source's data_type (e.g. quotes+indices). */
  tasksForSource(source: SourceRecord): TaskSpec[];

  /** The eod_bulletin (+ any final-board) sources for a venue, for eod_sweep. */
  eodSourcesForVenue(venue: VenueCode): Promise<SourceRecord[]>;

  /**
   * The ingest.sources.id of a venue's filing_detail source, or null when the
   * venue has none configured. Used by filings_poll to enqueue detail fetches.
   */
  filingDetailSourceId(venue: VenueCode): Promise<number | null>;

  /** CrossCheck.resolve for the cross_check handler (CONTRACT §7). */
  crossCheck: CrossCheck;

  /**
   * The principal id the cross-check / pipeline stages run AS (the cross-check
   * agent whose id becomes lake.objects.verified_by, CONTRACT §7). Owned by the
   * runtime so the handler never hardcodes a principal outside its surface.
   */
  pipelinePrincipalId(): Promise<string>;

  /** Nightly key_ratios rebuild off VERIFIED lake objects (CONTRACT §9). */
  recomputeKeyRatios(securityIds?: number[]): Promise<{ rowsWritten: number }>;

  /**
   * The Marsad Score batch (07 §3.6 P1.7c): re-rank the eligible universe off
   * fresh key_ratios into public.scores / score_history / score_events. Optional
   * securityIds narrows the batch; omitted ⇒ full universe.
   */
  runScoreBatch(securityIds?: number[]): Promise<{ scored: number }>;

  /** How many independent staging sources exist for a natural key (2-source rule). */
  countStagingSources: SourceCountByKey;
}

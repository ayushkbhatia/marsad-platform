# Marsad P1 Ingestion — FROZEN CONTRACT (v1)

> **This is the single source of truth every P1 builder imports.** Names, signatures, DB columns,
> queue names, and the seed spec below are **frozen** — other modules depend on them. Change here
> first (with tech-lead sign-off), then in code. Freeze date 2026-07-13.
>
> Grounded in the **live applied DDL** (`supabase/migrations/20260713000004_lake.sql`,
> `…000005_prices.sql`, `…000007_datapoints_scores.sql`, `…000002_iam.sql`,
> `…000003_market_reference.sql`), the worker conventions (`worker/src/consumer.ts`,
> `worker/src/handlers/index.ts`, `worker/src/db.ts`), `docs/architecture/01-ingestion.md`, and
> `docs/architecture/P1-recon-findings.md`. Where the 01 doc and the applied DDL disagree, **the
> applied DDL wins** and the divergence is called out inline.

## 0. Ground rules (LOCKED — restated so no builder can miss them)

1. **Scrape-only + DELAYED.** Never claim, imply, or produce realtime. Every quote is ≥15-min
   delayed at source; our poll latency stacks on top. `delay_minutes` defaults 15 everywhere.
2. **All 6 venues:** `TDWL DFM ADX QE MSX BHB`. (`BK` Kuwait exists in `public.venues` but
   `is_active = false` — no ingestion.)
3. **Cheapest run cost.** One Hetzner CX22 + existing Supabase. Playwright only for WAF bootstrap.
   No proxies, no scraping SaaS, no per-request APIs, zero LLM in the hot path.
4. **English only.** Ingest EN; record `lang: 'en'`. AR siblings are future parser versions.
5. **Snapshot-first, immutably.** Every fetch stores raw bytes to `ingest.raw_snapshots` (large
   blobs → Storage `lake-raw`) **before** any parse. Parsers are **pure functions of a stored
   snapshot** and replayable against `ingestion/fixtures/`.
6. **Config over code.** URLs, XHR templates, cadences, normalize rules live in `ingest.sources` /
   `ingest.schedules`. Adapters hold parsing logic + endpoint *shapes* only — **never hardcode a
   URL or a portal action id**.

## 1. Module boundaries (frozen import surface)

New package `ingestion/` (own `package.json` + `tsconfig.json`; git-tracked; excluded from Vercel
via `.vercelignore` and from root `tsc` via root `tsconfig.json` `exclude`). Adapters/scrapers run
on the VPS **worker/** and are invoked through pgmq handlers.

```
ingestion/
  src/
    core/                 # transport-agnostic framework — no venue code
      types.ts            # ALL interfaces in §2–§6 (the frozen surface)
      fetcher.ts          # HttpClient (undici): rate limit, retries, conditional GET, robots
      browser.ts          # BrowserClient (Playwright persistent request-context; cookie bootstrap)
      snapshot.ts         # SnapshotStore.put(): normalize→hash→dedup→store; ParseRunRecorder
      parse-harness.ts    # runs a pure parse() against a StoredSnapshot; records ingest.parse_runs
      scheduler.ts        # (reference) — enqueue is SQL (ingest.enqueue_due_jobs); §5
      registry.ts         # loadSource(): reads an ingest.sources row → SourceRecord
    adapters/
      types.ts            # re-exports VenueAdapter/TaskSpec from core/types (convenience)
      tdwl/ dfm/ adx/ qe/ msx/ bhb/   # one dir per venue; files: quotes.ts, filings.ts, eod.ts, …
      index.ts            # ADAPTERS: Record<VenueCode, VenueAdapter>
    lake/
      cross-check.ts      # CrossCheck service (§7): 2-source rule → VERIFIED lake.objects
      staging.ts          # idempotent staging-row emit (the ingestion→lake handoff, §6.4)
    freshness/
      (SQL-owned)         # ingest.sweep_feed_status() is the writer; no TS here beyond types
    config/
      sources.seed.ts     # the §8 seed spec, materialized as the ONE sources-seed migration input
  fixtures/               # real venue bytes (see fixtures/README.md)
  CONTRACT.md             # this file
```

Worker-side (in `worker/src/handlers/`, registered via `registerHandler`): the five handler
functions in §9 import adapters + core from `ingestion/`.

## 2. Adapter contract (`ingestion/src/core/types.ts`)

```ts
export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

// Matches ingest.sources.data_type values used in the seed (§8).
export type DataType =
  | 'quotes' | 'indices'
  | 'filings_list' | 'filing_detail'
  | 'financials' | 'dividends' | 'ipo' | 'calendar'
  | 'eod_bulletin' | 'ohlcv_backfill';

// ingest.sources.transport CHECK: 'http' | 'http_bootstrap' | 'headless'.
export type Transport = 'http' | 'http_bootstrap' | 'headless';

/** One ingest.sources row, loaded by core/registry.loadSource(). Columns are EXACT (0005). */
export interface SourceRecord {
  id: number;                       // ingest.sources.id (bigint)
  venue: VenueCode;                 // ingest.sources.venue → public.venues.code
  dataType: DataType;               // ingest.sources.data_type
  entryUrl: string;                 // ingest.sources.entry_url (human-auditable page of record)
  endpointConfig: EndpointConfig;   // ingest.sources.endpoint_config (jsonb)
  normalizeRules: NormalizeRule[];  // ingest.sources.normalize_rules (jsonb; default [])
  transport: Transport;             // ingest.sources.transport
  robotsStatus: 'allowed' | 'disallowed' | 'override';  // ingest.sources.robots_status
  active: boolean;                  // ingest.sources.active
  lastContentHash: string | null;   // ingest.sources.last_content_hash (single-URL sources only)
}

/** endpoint_config jsonb shape. For http_bootstrap/headless, `actionDiscovery` tells the
 *  BrowserClient how to scrape the runtime action id/PUID from the page (never hardcoded). */
export interface EndpointConfig {
  method?: 'GET' | 'POST';
  urlTemplate?: string;             // may contain {epochMs}, {page}, {symbol} placeholders
  headers?: Record<string, string>;
  pagination?: { param: string; start: number; pageSize?: number };
  actionDiscovery?: {               // TDWL/DFM/ADX WAF path
    navigateUrl: string;            // page to load to seat cookies
    extract: 'datatable_ajax' | 'network_capture';  // how to obtain the real XHR URL at runtime
    responseUrlPattern?: string;    // regex the captured response URL must match
  };
  responseKind: 'json' | 'html' | 'txt_json' | 'xlsx' | 'pdf';
}

/** normalize_rules: strip volatile bytes (server timestamps, CSRF/viewstate, request ids)
 *  BEFORE hashing, so unchanged content dedupes. Applied in order; JSON is key-sorted first. */
export interface NormalizeRule { pattern: string; replacement: string; flags?: string; }

/** Result of a single fetch — RAW, never parsed. Fed straight into SnapshotStore.put(). */
export interface FetchResult {
  externalId?: string;              // announcement id etc. → raw_snapshots.external_id / seen_items
  url: string;                      // exact URL fetched (provenance) → raw_snapshots.url
  contentType: string;              // → raw_snapshots.content_type (TDWL sends text/html for JSON — keep verbatim)
  httpStatus: number;               // → raw_snapshots.http_status
  body: Buffer;                     // raw bytes, verbatim (pre-normalize)
  fetchedAt: string;                // ISO-8601 UTC; → raw_snapshots.fetched_at
  meta?: Record<string, unknown>;   // e.g. { page, symbol, lang: 'en' } → raw_snapshots.meta
}

/** What a pure parser receives — the STORED snapshot (never a live fetch). */
export interface StoredSnapshot {
  snapshotId: number;               // ingest.raw_snapshots.id
  sourceId: number;                 // ingest.raw_snapshots.source_id
  venue: VenueCode;
  dataType: DataType;
  contentType: string;
  externalId: string | null;
  body: Buffer;                     // the verbatim bytes (from Storage or inline)
  fetchedAt: string;                // ISO-8601 UTC
  meta: Record<string, unknown>;
}

export interface ParseResult<T> {
  rows: T[];                        // zero rows on a CHANGED snapshot ⇒ PARSE_DRIFT (§10)
  parserVersion: number;            // must equal TaskSpec.parserVersion
}

/** A data-type task on one venue. fetch = impure/transport; parse = PURE/replayable. */
export interface TaskSpec<T> {
  dataType: DataType;
  parserVersion: number;            // bump ⇒ old snapshots become replay-eligible (§10)
  fetch(ctx: FetchContext): Promise<FetchResult[]>;
  parse(snapshot: StoredSnapshot): ParseResult<T>;   // PURE. No I/O. No Date.now(). No fetch.
}

export interface VenueAdapter {
  venue: VenueCode;
  /** iam.principals.handle of the owning DATA agent (LIVE seed uses per-venue accounts). */
  agentAccount:
    | 'DATA-TDWL' | 'DATA-DFM' | 'DATA-ADX' | 'DATA-QE' | 'DATA-MSX' | 'DATA-BHB'
    | 'DATA-FILINGS';               // filings_list/filing_detail tasks attribute to DATA-FILINGS
  quotes?:      TaskSpec<NormalizedQuote>;
  indices?:     TaskSpec<NormalizedIndexLevel>;
  filingsList?: TaskSpec<NormalizedFilingRef>;
  filingDetail?:TaskSpec<NormalizedFiling>;
  dividends?:   TaskSpec<NormalizedDividend>;
  eodBulletin?: TaskSpec<NormalizedOhlcv>;
  ipo?:         TaskSpec<NormalizedIpoEvent>;
  // extend per §8 as sources are added; unset = venue does not serve that type in v1.
}
```

> **Divergence note.** 01-ingestion.md §3.2 groups venues under `DATA-GULF`. The **live iam seed
> (`…000002_iam.sql`) has one DATA agent per venue** (`DATA-TDWL … DATA-BHB`) plus `DATA-FILINGS`.
> The contract follows the live seed. `agentAccount` resolves to `iam.principals.id` and is what
> `SnapshotStore.put` writes as `lake.snapshots.fetched_by` and the worker sets as
> `app.principal_id` before each job.

## 3. Transport clients (`FetchContext`, `HttpClient`, `BrowserClient`)

Both clients implement one interface so adapters are transport-agnostic. The scheduler/worker
picks the client from `SourceRecord.transport`.

```ts
export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;               // default 20_000
  conditional?: { etag?: string; lastModified?: string };  // If-None-Match / If-Modified-Since
}

export interface RawResponse {
  url: string;                      // final URL after redirects
  status: number;
  headers: Record<string, string>;
  body: Buffer;                     // empty on 304
  fromCache304: boolean;
}

/** Shared transport surface. Both clients honor the per-host ≤1 req/s token bucket + robots. */
export interface Transporter {
  get(url: string, opts?: FetchOptions): Promise<RawResponse>;
  request(url: string, opts: FetchOptions): Promise<RawResponse>;
}

/** Plain fetch (undici). QE/MSX/BHB steady-state, and any venue that proves unchallenged. */
export interface HttpClient extends Transporter {}

/** Playwright persistent request-context. TDWL/ADX (Akamai/Incapsula WAF) + DFM if challenged.
 *  bootstrap() seats cookies by navigating a page, then discovers the runtime action URL; get()
 *  issues context.request.get() so the TLS/JA3 fingerprint MATCHES the cookies (undici replay
 *  re-challenges — 01 Revisions #3). */
export interface BrowserClient extends Transporter {
  bootstrap(cfg: EndpointConfig['actionDiscovery']): Promise<{ resolvedUrl: string; cookies: string }>;
  refreshIfChallenged(status: number): Promise<void>;   // 401/403/challenge ⇒ re-bootstrap, one free retry
}

export interface Logger { info(m: string, x?: object): void; warn(m: string, x?: object): void;
  error(m: string, x?: object): void; child(x: object): Logger; }

/** Everything a TaskSpec.fetch() gets. Never gives parse() I/O — parse() takes only a snapshot. */
export interface FetchContext {
  source: SourceRecord;
  http: HttpClient;                 // use when transport === 'http'
  browser: BrowserClient;           // use when transport === 'http_bootstrap' | 'headless'
  logger: Logger;
  now(): string;                    // ISO UTC — injected so fetch is testable; parse NEVER calls this
}
```

## 4. SnapshotStore + ParseRunRecorder (`ingestion/src/core/snapshot.ts`)

Writes the **live** `ingest.raw_snapshots` index (0005) and, for lake lineage, `lake.snapshots`
(0004). Both exist; the ingestion index carries `source_id`/`content_hash`/`external_id` dedup, the
lake table is the content-addressed lineage anchor consumed by parse_runs → objects.

```ts
export interface PutSnapshotInput {
  source: SourceRecord;
  fetched: FetchResult;
  agentPrincipalId: string;         // iam.principals.id of the venue DATA agent (lake.snapshots.fetched_by)
}

export interface PutSnapshotResult {
  snapshotId: number;               // ingest.raw_snapshots.id
  lakeSnapshotId: number;           // lake.snapshots.id (the lineage anchor for parse runs)
  sha256: string;                   // hex digest of NORMALIZED body
  deduped: boolean;                 // true ⇒ content unchanged: heartbeat only, no parse enqueued
  storagePath: string | null;       // 'lake-raw' key when body was uploaded (large blob)
  bytesStored: number;
}

/** Contract:
 *  1. Apply source.normalizeRules (+ key-sort JSON) → normalized bytes → sha256.
 *  2. Single-URL sources: if sha256 === source.lastContentHash ⇒ deduped=true, write ONLY an
 *     ingest.fetch_log row (changed=false), do NOT store, do NOT parse. (Dominant off-hours case.)
 *  3. Changed: if gzipped size > INLINE_MAX (32768, matching lake.snapshots.body_inline rule)
 *     upload gzip to Storage 'lake-raw' at `{venue}/{data_type}/{yyyy}/{mm}/{dd}/{sha256}.{ext}.gz`;
 *     else keep inline in lake.snapshots.body_inline. Always insert ingest.raw_snapshots
 *     (storage_path NOT NULL there — for inline bodies use the lake.snapshots pointer key) and
 *     lake.snapshots (sha256 unique, ON CONFLICT (sha256) DO NOTHING = free dedupe).
 *  4. ingest.raw_snapshots insert is ON CONFLICT (source_id, content_hash, external_id) NULLS NOT
 *     DISTINCT DO NOTHING — an A→B→A flip conflicts silently (heartbeat, no double-emit).
 *  5. Update ingest.sources: last_content_hash, last_changed_at, last_success_at,
 *     consecutive_failures=0. Always write ingest.fetch_log (changed true/false, duration_ms). */
export interface SnapshotStore {
  put(input: PutSnapshotInput): Promise<PutSnapshotResult>;
  load(snapshotId: number): Promise<StoredSnapshot>;   // for parse-harness + replay
}

/** ingest.parse_runs recorder (0005: status ∈ 'ok'|'error'|'drift_zero_rows'). Distinct from
 *  lake.parse_runs (0004, richer, agent_id/parser_key) — this one is the ingestion-side ledger. */
export interface ParseRunRecorder {
  record(input: {
    snapshotId: number;             // ingest.raw_snapshots.id
    parserVersion: number;          // int
    status: 'ok' | 'error' | 'drift_zero_rows';
    rowsEmitted: number | null;
    error?: string | null;
  }): Promise<number>;              // ingest.parse_runs.id
}
```

Storage bucket `lake-raw` is already created (`ops.ensure_bucket('lake-raw', false)`; private).
Uploads use the service-role Storage key (bucket-write-only exception, per 01 §3.1).

## 5. Scheduler contract (SQL-owned; TS is a thin reference)

The scheduler **is** SQL and already applied (0005). Builders do **not** reimplement it; they seed
its inputs (§8) and the worker consumes its output.

- **Enqueue:** pg_cron `ingest-tick` (`*/5 * * * *`) calls **`ingest.enqueue_due_jobs()`** — for
  each active `ingest.schedules` row where `now() - last_enqueued_at >= cadence_minutes`, and
  (`session_only = false` OR **`ingest.venue_is_open(venue, now(), '10 min', '20 min')`**), it
  inserts an `ingest.job_queue` row (`run_after = now() + offset_minutes`) and stamps
  `last_enqueued_at`. Grace window −10/+20 min catches opening/closing auctions.
- **Session/holiday gate:** `ingest.venue_is_open(venue, at, grace_before, grace_after)` reads
  `public.venues.trading_days` (0=Sun…6=Sat), `public.market_holidays`, `public.market_sessions`.
  DFM/ADX are `{1,2,3,4,5}` (Mon–Fri); the rest `{0,1,2,3,4}` (Sun–Thu). Nothing may assume Sun–Thu.
- **Claim:** the VPS worker long-polls `ingest.job_queue` with `SELECT … FOR UPDATE SKIP LOCKED`
  (status `queued`→`running`, set `claimed_by`, `claimed_at`). On finish: `ok`/`failed`/
  `skipped_closed`, set `finished_at`. `ingest.requeue_stuck_jobs('15 minutes')` (cron
  `queue-reaper`) reclaims dead `running` rows.
- **Request-budget limiter:** enforced in `core/fetcher.ts` — per-host token bucket ≤1 req/s,
  global concurrency ≤4, staggered `offset_minutes`. Hard ceiling **≤300 requests/day/host**
  (recon exit criterion). The first relief lever is relaxing overnight filings cadence.
- **On every run:** write `ingest.fetch_log` (changed, duration_ms, http_status, error) and an
  `ops.job_heartbeats` upsert (`last_run_at`, `last_ok_at`/`last_error`, `consecutive_failures`).
  `ops.heartbeat_sentinel()` raises `ops.incidents` if a job goes silent > 2× its interval.
- **Freshness sweep:** pg_cron `feed-status-sweep` (`* * * * *`) calls
  **`ingest.sweep_feed_status()`** — the single writer of `public.venue_feed_status`. Thresholds at
  quotes cadence C=10min: ≤15min `live`, 15–30 `reconnecting`, 30–45 `delayed`, >45 `offline`,
  out-of-session `closed`. It never overwrites desk-set `halted`/`auction`.

## 6. Normalized row shapes (mapped to EXACT DB columns)

Parsers emit these. They are `lake`-staging inputs (§6.4), not direct table writes — the lake
verifies before anything reaches `public.*`. Column targets are named per the live DDL.

### 6.1 NormalizedQuote → `public.quotes_latest` / `public.quotes_intraday` (0005)
```ts
export interface NormalizedQuote {
  venue: VenueCode;
  ticker: string;                   // resolve → public.securities.id via (venue_code, ticker)
  last: number | null;              // → quotes_latest.last            numeric(18,6)
  change: number | null;            // → quotes_latest.change          numeric(18,6)
  changePct: number | null;         // → quotes_latest.change_pct      numeric(9,4)
  open: number | null;              // → quotes_latest.open
  high: number | null;              // → quotes_latest.high
  low: number | null;               // → quotes_latest.low
  volume: number | null;            // → quotes_latest.volume          numeric(20,0)
  vwap?: number | null;             // → quotes_latest.vwap
  week52High?: number | null;       // → quotes_latest.week52_high
  week52Low?: number | null;        // → quotes_latest.week52_low
  asOf: string;                     // exchange delayed print time (UTC) → quotes_latest.as_of
  // captured_at, delay_minutes(=15), snapshot_id, tick_dir are set by the writer, not the parser.
  bid?: number | null; ask?: number | null;  // kept in staging payload; not persisted to quotes_latest
}
```
QE field map (from `fixtures/qe/marketwatch.txt`, verbatim): `Symbol→ticker`, `LastPrice→last`,
`Change→change`, `PercentChange→changePct`, `OpenPrice→open`, `High→high`, `Low→low`,
`Volume→volume`, `W52High/W52Low→week52*`, `PrevClosing→(compute change)`. TDWL field map is in
`fixtures/tdwl/README.md`.

### 6.2 NormalizedIndexLevel → `public.index_levels` (0005)
```ts
export interface NormalizedIndexLevel {
  indexCode: string;                // → index_levels.index_code (TASI, DFMGI, FADGI, QSI, MSX30, BAX)
  level: number;                    // → level        numeric(18,4)  NOT NULL
  change?: number | null;           // → change
  changePct?: number | null;        // → change_pct   numeric(9,4)
  dayHigh?: number | null;          // → day_high
  dayLow?: number | null;           // → day_low
  valueTraded?: number | null;      // → value_traded numeric(20,2)
  asOf: string;                     // → as_of  timestamptz (PK part with index_code)
}
```

### 6.3 NormalizedOhlcv → `public.ohlcv_daily` (0005) — EOD source of record
```ts
export interface NormalizedOhlcv {
  venue: VenueCode; ticker: string; // → security_id
  tradeDate: string;                // 'YYYY-MM-DD' → ohlcv_daily.trade_date (PK part)
  open?: number | null; high?: number | null; low?: number | null;
  close: number;                    // → ohlcv_daily.close  numeric(18,6) NOT NULL
  volume?: number | null;           // → ohlcv_daily.volume        numeric(20,0)
  valueTraded?: number | null;      // → ohlcv_daily.value_traded   numeric(20,2)
}
```

### 6.4 Filings / Dividends / IPO — reference feeds (feed lake, not public directly)
```ts
export interface NormalizedFilingRef {   // from a filings_list poll (list-diff on external_id)
  venue: VenueCode; externalId: string;  // announcement id, e.g. 'CG-1-2026-4471' → seen_items
  sourceRef: string;                     // → public.filings.source_ref (unique w/ venue_code)
  title: string; filedAt: string;        // → filings.title / filed_at
  detailUrl: string; pdfUrl?: string;    // enqueue filing_detail at priority 1
  formCode?: string;
}
export interface NormalizedFiling {      // from filing_detail — feeds public.filings + lake object
  venue: VenueCode; externalId: string; sourceRef: string;
  securityTicker?: string | null;        // null for market-wide notices
  formCode?: string;
  filingType: 'DIVIDEND'|'CAPEX'|'RESULTS'|'RATING'|'GOVERNANCE'|'OPS'|'CONTRACT'|'PROSPECTUS'|'OTHER';
  title: string; filedAt: string;        // → public.filings columns of the same name
  fullTextEn?: string;                   // → filings.full_text (machine-extracted EN)
  extractedFacts?: Record<string, unknown>;  // → filings.extracted_facts (jsonb)
  pdfStoragePath?: string;               // → filings.pdf_en_path (Storage bucket 'filings')
}
export interface NormalizedDividend {    // → public.dividends via lake object
  venue: VenueCode; ticker: string;
  divType: 'FINAL'|'INTERIM'|'SPECIAL';  // → dividends.div_type
  fiscalRef?: string | null;             // → dividends.fiscal_ref
  dps: number; currency: string;         // → dividends.dps numeric(12,6) / currency char(3)
  exDate?: string|null; recordDate?: string|null; payDate?: string|null;
  verification: 'registrar'|'disclosure';// → dividends.verification (default 'disclosure')
}
export interface NormalizedIpoEvent {    // → public.ipo_offers / ipo_timeline_events via lake object
  venue: VenueCode; companyName: string;
  stage: 'intention'|'draft_prospectus'|'filing'|'bookbuilding'|'retail_open'|'allocation'|'listed';
  priceRangeLow?: number|null; priceRangeHigh?: number|null; finalPrice?: number|null;
  coverageInst?: number|null; coverageRetail?: number|null;
  isPriceSensitive?: boolean;            // price-range/date changes ⇒ human-confirm gate (33b)
}
```

### 6.5 Staging emit — the ingestion→lake handoff (`ingestion/src/lake/staging.ts`)
```ts
/** This domain guarantees typed, lineage-bearing, at-least-once staging rows with stable external
 *  IDs. Everything from cross-check to VERIFIED is the lake (§7). Each staging row carries
 *  (venue, source_id, snapshot_id, external_id, extracted_at). Idempotent on
 *  (source_id, external_id, content_hash) so retried jobs cannot double-emit. */
export interface StagingRow<T> {
  objectType: string;               // 'QUOTE.LAST','DISCLOSURE.DPS','DIVIDEND.EXDATE','FILING.FINANCIALS',…
  naturalKey: string;               // deterministic, e.g. 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1'
  venue: VenueCode;
  sourceId: number;                 // ingest.sources.id
  snapshotId: number;               // ingest.raw_snapshots.id (lineage)
  externalId: string | null;
  sourceRank: number;               // primary-wins ordering: registrar=10, exchange=20, press=90
  payload: T;                       // the normalized shape from §6.1–6.4
  numericValue?: number | null;     // fast-path scalar → lake.objects.numeric_value + datapoint fan-out
  unit?: string | null;
  effectiveDate?: string | null;    // business date → lake.objects.effective_date
  priceSensitive?: boolean;         // → lake.objects.price_sensitive (dividends/IPO/results)
  extractedAt: string;              // ISO UTC
}
export interface StagingEmitter { emit<T>(rows: StagingRow<T>[]): Promise<void>; }
```

## 7. CrossCheck service (`ingestion/src/lake/cross-check.ts`)

Consumes staging rows, applies the **2-source rule**, writes VERIFIED `lake.objects` using the
**supersede-then-insert** pattern the live DDL is built for (0004: `superseded_by` is
`DEFERRABLE INITIALLY DEFERRED`; the partial unique `objects_natural_key_live_uni` forbids two live
rows per key). Runs as the `cross_check` handler (§9) on `q_ingest`/`q_pipeline`.

```ts
export interface CrossCheckInput { naturalKey: string; objectType: string; }
export interface CrossCheckResult {
  objectId: string;                 // lake.objects.id (uuid)
  state: 'PENDING' | 'VERIFIED' | 'CONFLICT';
  revision: number;
}
export interface CrossCheck {
  /** For a natural_key, gather candidate staging rows and decide:
   *  - ≥2 independent sources AGREE (within tolerance) ⇒ insert/transition object → VERIFIED
   *    (verified_by = cross-check agent principal; if price_sensitive, state stays PENDING and a
   *     Desk item is raised — VERIFIED requires a HUMAN verifier, enforced by fn_object_state_guard).
   *  - sources DISAGREE ⇒ object → CONFLICT + a lake.object_conflicts row (candidates jsonb,
   *     policy 'primary_wins'); primary source (lowest source_rank) wins unless overridden.
   *  - single source ⇒ object stays PENDING.
   *  Value change on an already-VERIFIED key ⇒ NEW revision: pre-allocate new uuid, UPDATE old row
   *  SET superseded_by=<new> + state RETIRED, INSERT new revision, write lake.object_revisions
   *  (reason ∈ source_update|correction|human_override|conflict_resolution). All in ONE tx; the
   *  deferred FK resolves at COMMIT. VERIFIED numeric_value+metric_key ⇒ datapoint fan-out fires
   *  automatically (lake.fn_datapoint_fanout AFTER UPDATE trigger — do NOT write public.datapoints
   *  directly). */
  resolve(input: CrossCheckInput): Promise<CrossCheckResult>;
}
```
Tolerance: prices ±0.5% (R-04 convention); dates exact; enum/text exact. MSX ex-date discipline is
weak — dividend cross-check tolerates later registrar confirmation (leave PENDING, don't CONFLICT).

## 8. Seed spec — `ingest.sources` + `ingest.schedules` for all 6 venues

Materialized by the **one** builder assigned the sources-seed migration (the only writer allowed
under `supabase/migrations/`), sourced from `ingestion/src/config/sources.seed.ts`. Columns per
0005 DDL. `endpoint_config` holds the discovered URL/action shape; **URLs below are provenance
seeds — the real live path is pinned at build time and is editable from Desk without a deploy.**

Cadence law (01 §4.2): quotes 10 min session-only; indices share the quotes job; filings_list 5
min 04:00–19:00 UTC (30 min overnight); filing_detail event-driven priority 1; eod_bulletin at
close+30; dividends daily 15:00 UTC; ipo daily 05:00 UTC. Stagger `offset_minutes` TDWL+0 DFM+1
ADX+2 QE+3 MSX+4 BHB+5.

| venue | data_type | transport | entry_url (provenance) | endpoint_config note | cadence_min | session_only | parser key (adapter.task) |
|---|---|---|---|---|---|---|---|
| TDWL | quotes | http_bootstrap | `saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch` | actionDiscovery: navigate page, scrape `NJgetMainNomucMarketDetails` action+PUID; responseKind `json` (ct text/html) | 10 | true | tdwl.quotes |
| TDWL | filings_list | http_bootstrap | `saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news` | paginated JSON; external_id like `CG-1-2026-4471` | 5 | false | tdwl.filingsList |
| TDWL | eod_bulletin | http_bootstrap | market-reports XLSX archive page | responseKind `xlsx` | (close+30, via close-sweep row) | false | tdwl.eodBulletin |
| DFM | quotes | http_bootstrap | `marketwatch.dfm.ae/en` → `api2.dfm.ae/mw/v1/…` | pin `/mw/v1` market-watch route from SPA bundle; responseKind `json` | 10 | true | dfm.quotes |
| DFM | filings_list | http_bootstrap | `api2.dfm.ae/efsah/v1/…` (eFsah disclosures) | responseKind `json` | 5 | false | dfm.filingsList |
| DFM | eod_bulletin | http_bootstrap | DFM daily bulletin (XLSX/PDF) | responseKind `xlsx` | close-sweep | false | dfm.eodBulletin |
| ADX | quotes | http_bootstrap | `adx.ae` market watch (JSON services) | actionDiscovery: network_capture on VPS; responseKind `json` | 10 | true | adx.quotes |
| ADX | filings_list | http_bootstrap | ADX news & disclosures | responseKind `json` | 5 | false | adx.filingsList |
| ADX | eod_bulletin | http_bootstrap | ADX daily trading report | responseKind `xlsx` | close-sweep | false | adx.eodBulletin |
| QE | quotes | http | `qe.com.qa/pps/qse_files/MarketWatch.txt` | **confirmed** clean JSON board; responseKind `txt_json` | 10 | true | qe.quotes |
| QE | filings_list | http | `qe.com.qa` company news/announcements | HTML list; responseKind `html` | 5 | false | qe.filingsList |
| QE | eod_bulletin | http | QE daily bulletin archive (PDF/XLS) | responseKind `xlsx` | close-sweep | false | qe.eodBulletin |
| MSX | quotes | http_bootstrap | `msx.om` market watch (JSON behind SPA) + `snapshot.aspx?s=` | responseKind `json`/`html`; reCAPTCHA on some paths (not snapshot.aspx) | 10 | true | msx.quotes |
| MSX | filings_list | http_bootstrap | `msx.om/details.aspx?b1=News&t=News` (+ Disclosures/Circulars) | responseKind `html` | 5 | false | msx.filingsList |
| MSX | eod_bulletin | http | MSX daily/monthly bulletin archive | responseKind `xlsx` | close-sweep | false | msx.eodBulletin |
| BHB | quotes | http | `bahrainbourse.com/en` → `webapi.bahrainbourse.com/api/…` | pin market route from SPA bundle; responseKind `json` | 10 | true | bhb.quotes |
| BHB | eod_bulletin | http | `bahrainbourse.com/…/Daily-Trading-Summary.aspx` (XLSX) | **EOD gold source**; responseKind `xlsx` | close-sweep | false | bhb.eodBulletin |
| BHB | filings_list | http | BHB news & announcements | responseKind `html` | 5 | false | bhb.filingsList |

`schedules` rows: one per source, `cadence_minutes` from the table, `session_only` from the table,
`offset_minutes` per the stagger, `active = true`. Indices are folded into each venue's `quotes`
task (shared endpoint) — no separate schedule row unless a venue serves indices from a distinct
URL. Filing-detail is enqueued event-driven by the filings_list parser (priority 1), not scheduled.

## 9. pgmq job envelope + worker handler names

Worker canon (`worker/src/consumer.ts`): pgmq queues are exactly `q_ingest`, `q_pipeline`,
`q_dispatch`, `q_email`, `q_maintenance`. Every message body is a JSON object with a **`handler`**
key naming a registered handler; the rest is the payload. vt 600s, qty 1. Success ⇒
`pgmq.archive`; 5 failed deliveries ⇒ archive + `ops.incidents`.

> **`ingest.job_queue` is NOT a pgmq queue** — it is the cadence table `enqueue_due_jobs()` writes
> and the poller claims with `FOR UPDATE SKIP LOCKED` (0005; consumer.ts line comment). Scrape jobs
> flow through it. The pgmq handlers below are for the event-driven / cross-cutting stages.

```ts
export interface JobEnvelope<P = Record<string, unknown>> { handler: HandlerName; /* + payload */ } & P;

export type HandlerName =
  | 'quote_poll'            // q_ingest — run a venue quotes (+indices) TaskSpec; payload { sourceId }
  | 'eod_sweep'            // q_ingest — close+30 EOD bulletin + final board; payload { venue }
  | 'filings_poll'         // q_ingest — filings_list poll; new external_id ⇒ enqueue filing_detail
  | 'cross_check'          // q_pipeline — CrossCheck.resolve; payload { naturalKey, objectType }
  | 'key_ratios_recompute';// q_pipeline — nightly public.key_ratios rebuild off VERIFIED objects
```

Payloads (frozen):
```ts
export interface QuotePollPayload   { handler: 'quote_poll';   sourceId: number; }
export interface EodSweepPayload    { handler: 'eod_sweep';    venue: VenueCode; tradeDate: string; }
export interface FilingsPollPayload { handler: 'filings_poll'; sourceId: number; }
export interface CrossCheckPayload  { handler: 'cross_check';  naturalKey: string; objectType: string; }
export interface KeyRatiosPayload   { handler: 'key_ratios_recompute'; securityIds?: number[]; }
```
Each handler: set `app.principal_id` GUC (venue DATA agent, or DATA-FILINGS for filings) →
check `iam.agent_accounts.run_enabled` (kill switch) → run → snapshot-first → parse → emit staging
→ (for cross_check) verify. Every handler updates `ops.job_heartbeats` (consumer.ts does the
archive; handlers own their heartbeat + `ingest.fetch_log`). Registration:
`registerHandler('quote_poll', quotePoll)` etc. in `worker/src/handlers/`.

## 10. Failure taxonomy + replay (frozen semantics)

Per-fetch error classes drive `ingest.sources.consecutive_failures` + `ingest.fetch_log.error`:
`NETWORK`, `HTTP_5XX` (retry 5s→25s→120s ±30% jitter, 3 attempts), `HTTP_4XX` (endpoint moved — no
retry, straight to Desk error queue), `WAF_CHALLENGE` (BrowserClient.refreshIfChallenged + one free
retry), `PARSE_DRIFT` (fetch OK but parse emitted **zero rows on a CHANGED snapshot** or zod-failed
— `ingest.parse_runs.status='drift_zero_rows'`, no retry, Desk item). 429 honors `Retry-After`.
After 3 consecutive failed runs the scheduler doubles cadence (cap 4×) until a success.

**Replay:** parse is pure + snapshots immutable ⇒ bumping `TaskSpec.parserVersion` makes old
snapshots re-parse-eligible. `worker.ts --replay --source=… --since=…` reloads `StoredSnapshot`s
via `SnapshotStore.load` and re-emits staging; lake idempotency + revision pairs absorb the result.
Golden tests run every `parse()` against `ingestion/fixtures/` with **zero network**.

## 11. Frozen names other modules import (do not rename)

Interfaces: `VenueAdapter`, `TaskSpec<T>`, `FetchContext`, `FetchResult`, `StoredSnapshot`,
`ParseResult<T>`, `SourceRecord`, `EndpointConfig`, `NormalizeRule`, `HttpClient`, `BrowserClient`,
`Transporter`, `SnapshotStore`, `PutSnapshotResult`, `ParseRunRecorder`, `NormalizedQuote`,
`NormalizedIndexLevel`, `NormalizedOhlcv`, `NormalizedFiling`, `NormalizedFilingRef`,
`NormalizedDividend`, `NormalizedIpoEvent`, `StagingRow<T>`, `StagingEmitter`, `CrossCheck`,
`JobEnvelope`, `HandlerName`. Values: `ADAPTERS` (`Record<VenueCode, VenueAdapter>`), handler names
`quote_poll | eod_sweep | filings_poll | cross_check | key_ratios_recompute`, queue names
`q_ingest | q_pipeline | q_dispatch | q_email | q_maintenance`.

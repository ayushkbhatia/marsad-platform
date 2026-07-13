# P1 Ingestion — build & integration report (2026-07-13)

Integration lead pass over the P1 ingestion package (`ingestion/`) + the VPS worker wiring
(`worker/`). This report is **honest about what is validated against real captured bytes vs.
built-to-spec-pending-VPS**, and lists the exact remaining steps per P1 exit criterion.

## 1. Compile status

| Package | Command | Result |
|---|---|---|
| `ingestion/` | `npm install && npx tsc --noEmit` | **clean** (0 errors) |
| `ingestion/` | `npx tsc -p tsconfig.build.json` (emit → `dist/`) | **clean**; emits `dist/index.js` + `.d.ts`, `import('marsad-ingestion')` resolves |
| `worker/` | `npm install && npx tsc --noEmit` | **clean** (0 errors) against the **real** `marsad-ingestion` types (ambient stub deleted) |
| `worker/` | `npm run build` (emit → `dist/`) | **clean** |

Root `tsconfig.json` already excludes `ingestion` (and `worker`, `supabase`) so `next build`
on Vercel ignores it; `.vercelignore` already lists `ingestion/`. No change needed there.

## 2. Parser golden tests (zero network)

`cd ingestion && npm test` → **187 tests, 187 pass, 0 fail**. Worker handler tests: **30 pass**.

### Per-venue quote parser results — validated against REAL captured fixtures vs. shape-sample

| Venue | Quote parser test | Fixture | Verdict |
|---|---|---|---|
| **QE** | pass (parses full ~107-row board; spot-checks QNBK last=18.61, chg=0.28, vol=1,873,521) | `fixtures/qe/marketwatch.txt` (**real**, 132 KB, captured in sandbox) | **GREEN — real fixture** |
| **MSX** | pass (parses BKMB: last=0.397, open=0.4, vol=8,431,620, derived change −0.002) | `fixtures/msx/snapshot-BKMB.html` (**real**, 365 KB, captured in sandbox) | **GREEN — real fixture** |
| **DFM** | pass (parses board, derives change; bad body ⇒ 0 rows, no throw) | **inline shape-sample** (real board is behind `api2.dfm.ae/mw/v1`, WAF-blocked from sandbox) | to-spec — **needs real capture on VPS** |
| **BHB** | pass (parses webapi-shape board; EOD `mapBulletinRows` maps XLSX rows) | **inline shape-sample** (real board behind `webapi.bahrainbourse.com`) | to-spec — **needs real capture on VPS** |
| **TDWL** | pass (parses `NJgetMainNomucMarketDetails` shape) | `fixtures/tdwl/market-details.sample.json` (**2-row hand-built shape**, real endpoint shape from recon) | to-spec — **needs Playwright capture on VPS** |
| **ADX** | pass (parser codes to spec) | **none** (`fixtures/adx/` is README only — endpoint not yet discovered) | to-spec — **needs VPS endpoint discovery + capture** |

Bottom line: **QE and MSX quote parsers are validated against real captured venue bytes.**
DFM, BHB, TDWL parse a response *shape* that matches recon ground truth but has NOT been run
against a live full board. ADX has no fixture and no pinned endpoint yet.

The QE/MSX/DFM/BHB parsers all correctly return **zero rows on a malformed body** (the
`drift_zero_rows` / PARSE_DRIFT signal, CONTRACT §10) rather than throwing or fabricating a
quote — verified by test.

## 3. What was built / wired in this pass

The 7 module agents delivered `core/`, `adapters/`, `lake/`, `freshness/`, `config/` and the
worker handlers, all compiling and unit-tested. Two cross-module seams were **missing** and are
added here:

1. **`ingestion/src/adapters/index.ts` — the frozen `ADAPTERS` map** (`Record<VenueCode,
   VenueAdapter>`, CONTRACT §1/§11). Every venue adapter existed but nothing assembled them
   into the contract-required registry that consumers import.

2. **`ingestion/src/runtime.ts` + `ingestion/src/index.ts` — `createIngestionRuntime(deps)`**,
   the single factory the worker imports (`worker/src/handlers/runtime-wiring.ts`, CONTRACT §1).
   It assembles: registry (`loadSource`/`agentAccountFor`), transport clients
   (`createHttpClient` / `createBrowserClient` + Playwright driver), `SnapshotStore`,
   `ParseRunRecorder`, `LakeStagingEmitter`, `LakeCrossCheck`, `KeyRatiosRecompute`, and the
   `ADAPTERS` map into the worker's `IngestionRuntime` interface. `runTask` runs the real
   **fetch → snapshot-first → pure-parse → parse_runs** flow. **`countStagingSources`,
   `pipelinePrincipalId` (SYSTEM), `recomputeKeyRatios`, `filingDetailSourceId`,
   `eodSourcesForVenue`, `tasksForSource` are fully wired.**

3. **`package.json` `main`/`exports`/`types`/`files` + `tsconfig.build.json`** so the package
   emits real JS/`.d.ts` and `import('marsad-ingestion')` resolves at runtime (previously there
   was no entry point at all — the worker's `node dist/index.js` production path would have
   failed to resolve the package).

4. **Reconciled contract drift at the worker boundary.** The worker's narrow `IngestionRuntime`
   mirror widens `SourceRecord` with an index signature and treats transports as opaque, so the
   real package types are structurally near-identical but not directly assignable. Fixed the
   dynamic-import cast in `worker/src/handlers/runtime-wiring.ts` to route through `unknown`
   (the sanctioned bridge point, per that file's own docstring) and **deleted the now-redundant
   ambient stub `worker/src/handlers/marsad-ingestion.d.ts`** so the worker typechecks against
   the real published types.

5. `ingestion/.gitignore` (mirrors `worker/.gitignore`: `node_modules/`, `dist/`,
   `*.tsbuildinfo`, `.env`) so build artifacts are not committed.

### OPEN GAP (the one real blocker in the hot path)

`runTask`'s final step — mapping parser rows (`NormalizedQuote` / `NormalizedFilingRef` /
`NormalizedOhlcv`) into lineage-bearing lake `StagingRow`s (natural-key derivation, `source_rank`,
`numeric_value`, `price_sensitive`, per CONTRACT §6.5) — **was not delivered by any P1 module
owner.** No `mapRowsToStaging` / natural-key builder exists anywhere in the tree. Rather than
fabricate natural-key logic (it directly drives cross-check correctness — a wrong key silently
breaks the 2-source rule), the runtime exposes a single explicit seam `mapRowsToStaging()` that
currently **returns `[]` and logs a TODO**. Consequence: `runTask` reports `changed` /
`snapshotId` / parse status correctly and stores snapshots, but `rowsEmitted = 0` and
`stagedKeys = []` until this mapper is implemented. **This is the last seam before the pipeline
can verify anything end to end, and it is an owner-action item.**

## 4. Migration 0017 (`supabase/migrations/20260713000017_ingest_sources.sql`) — NOT applied

Per instructions, the human orchestrator applies migrations. Confirmed by reading only:

- **Parses as well-formed SQL**: 87/87 balanced parens, even single-quote count, 2 `INSERT`
  statements (sources + schedules), 2 terminating semicolons.
- **Columns match the live 0005 DDL exactly.** `ingest.sources` insert cols `(venue, data_type,
  entry_url, endpoint_config, normalize_rules, transport, robots_status, active)` all exist;
  `on conflict (venue, data_type, entry_url)` matches the table's `unique (venue, data_type,
  entry_url)`. `ingest.schedules` insert cols `(source_id, cadence_minutes, session_only,
  offset_minutes, active)` all exist. `transport` values are within the CHECK
  (`http`/`http_bootstrap`/`headless`); `robots_status` values within its CHECK.
- **Idempotent** (`ON CONFLICT DO NOTHING` for sources; `NOT EXISTS` guard for schedules).
- Seeds **18 (venue, data_type) pairs** = 6 venues × {quotes, filings_list, eod_bulletin}, with
  the CONTRACT §8 cadence law (quotes 10min session-only, filings 5min, eod 60min) and the
  TDWL+0…BHB+5 offset stagger. `ingestion/src/config/sources.seed.test.ts` **cross-validates the
  SQL migration against the TS mirror** (14 tests, all green) — the SQL and code agree on every
  pair, cadence, session flag, and offset.

## 5. Deps installed (no `npm install` was run outside `ingestion/` + `worker/`)

Locked in `ingestion/package-lock.json` by the one allowed `npm install`:

| Dep | Version | Role |
|---|---|---|
| `postgres` | 3.4.9 | marsad_worker DB client (runtime) |
| `undici` | 6.27.0 | HttpClient / StorageUploader transport (runtime, lazy) |
| `playwright` | 1.61.1 | BrowserClient for WAF venues (runtime, lazy) |
| `xlsx` | 0.18.5 | BHB EOD Daily-Trading-Summary XLSX decode (runtime, lazy) |
| `@types/node` | 22.x | dev |
| `tsx` | 4.23.1 | dev — runs `node --test` on `.ts` |
| `typescript` | 5.9.3 | dev |

`worker/` added no new dep in this pass — it already declared `"marsad-ingestion":
"file:../ingestion"` and `postgres`. `npm audit` flags 1 high-severity advisory in `xlsx`
(prototype-pollution / ReDoS, no upstream fix on npm); the lib is imported lazily inside a
try/catch and only touches EOD bytes, so exposure is limited, but note it for the owner.

**VPS provisioning still required (not runnable in this sandbox):**
- `cd ingestion && npm install && npm run build` (emits `dist/` the worker resolves in prod).
- `cd worker && npm install && npm run build`.
- `npx playwright install chromium` (the browser binary for the 2 WAF venues — `playwright`
  the npm package is installed, the Chromium binary is a separate download).

## 6. Local ingestion smoke test (no VPS, no live venues)

Everything below runs offline against the checked-in fixtures:

```bash
# 1. Typecheck both packages.
cd ingestion && npx tsc --noEmit
cd ../worker && npx tsc --noEmit

# 2. Parser goldens + framework + lake + worker-handler unit tests (zero network).
cd ../ingestion && npm test          # 187 pass
cd ../worker && node --import tsx --test "src/**/__tests__/*.test.ts"   # 30 pass

# 3. Confirm the package builds and the runtime factory resolves.
cd ../ingestion && npm run build
node --input-type=module -e "import('./dist/index.js').then(m => \
  console.log(typeof m.createIngestionRuntime, Object.keys(m.ADAPTERS)))"
# → function [ 'TDWL','DFM','ADX','QE','MSX','BHB' ]
```

A live fetch smoke test (QE/MSX plain-HTTP boards) needs egress to the venue hosts and a DB with
0017 applied; it is a VPS step (§7).

## 7. P1 exit-criteria readiness

| # | Exit criterion | Status | What's needed |
|---|---|---|---|
| 1 | Ingestion package compiles; excluded from Vercel + root tsc | **met-now** | — |
| 2 | Worker compiles against the real ingestion package | **met-now** | — (stub deleted, cast bridged) |
| 3 | Snapshot-first store writes `ingest.raw_snapshots` + `lake.snapshots` before parse | **met-now (code) / needs-VPS-runtime (live)** | run against the live DB (0017 + a real fetch) |
| 4 | Parsers are pure & replayable; goldens pass with zero network | **met-now** | — (187 green) |
| 5 | QE + MSX quote parsers validated against real captured bytes | **met-now** | — |
| 6 | DFM / BHB / TDWL / ADX parsers validated against **real live** boards | **needs-VPS-runtime** | first VPS fetch to capture real fixtures; ADX also needs endpoint discovery (network_capture) |
| 7 | TDWL/ADX WAF path works (Playwright request-context seats cookies, fetches AJAX JSON) | **needs-VPS-runtime** | `npx playwright install chromium`; run `bootstrap()` on VPS; pin TDWL action id/PUID & ADX JSON route at runtime |
| 8 | `ingest.sources`/`ingest.schedules` seeded for all 6 venues | **needs-owner-action** | orchestrator applies migration **0017** (validated, not applied) |
| 9 | Scheduler enqueues due jobs; worker claims & runs them | **needs-VPS-runtime** | pg_cron `ingest-tick` + worker poll loop against the live queue |
| 10 | End-to-end: fetch → snapshot → parse → **stage → cross-check → VERIFIED lake.objects** | **BLOCKED — needs-owner-action** | implement the **`mapRowsToStaging` per-data-type staging mapper** (CONTRACT §6.5); until then `runTask` emits 0 staging rows so cross-check has nothing to verify (§3 OPEN GAP) |
| 11 | Request budget ≤300/day/host; ≤1 req/s per host; concurrency ≤4 | **met-now (code) / needs-VPS-runtime (observed)** | limiter is enforced in `core/fetcher.ts` + config defaults; confirm under live load |
| 12 | Key-ratios nightly recompute off VERIFIED objects | **met-now (code) / needs-VPS-runtime (live)** | wired via `recomputeKeyRatios`; needs VERIFIED objects to exist, which depends on #10 |
| 13 | Delayed-data discipline (never realtime; delay_minutes=15) | **met-now** | enforced in contract/seed; parsers stamp `asOf`, writer sets delay |

### Single highest-priority owner action
Implement the **`mapRowsToStaging` staging mapper** (`ingestion/src/runtime.ts` seam →
`ingestion/src/lake/staging.ts` `StagingRow` shape, CONTRACT §6.5). It is the one missing link
between the (working, tested) parsers and the (working, tested) lake verification pipeline.
Everything else is either met now or a mechanical VPS-runtime step.

# Plan — Continuous lake enrichment: the researcher-agent fleet + derived-refresh agents

> **Self-contained handoff.** Paste into a fresh chat: *"ultracode — execute
> docs/plans/p17-continuous-enrichment-researchers.md."* Written 2026-07-14.
>
> **What this plan is:** the *operating architecture* that keeps the lake continuously current for every
> non-price data family — financial statements/fundamentals, ratios, filings, earnings, dividends,
> people/ownership — exactly the way **P1.7a** already does it for price (backfill + EOD accrual +
> 10-min intraday). It generalizes that proven two-feed pattern into a **per-family enrichment
> lifecycle** and fills the gap matrix.
>
> **What this plan is NOT:** a new scheduler, a new queue, a new pipeline, or a new agent framework.
> **All of that already exists and ships live.** A "researcher agent" here is a **config row +
> a parse adapter** on the existing machine; a "derived-research agent" is **a new handler** on the
> existing `pg_cron → q_maintenance → worker` pattern. If any step below reads like new plumbing, it is
> wrong — re-read §1.
>
> **Read alongside:** `07-lake-enrichment.md` (the field-by-field spec + Score methodology),
> `02-data-lake.md` (§4 lake.objects, §6 datapoints, §8 fundamentals/filings/earnings/dividends/
> ownership, §9 Score, "Missing entities"), `01-ingestion.md` (§4 scheduler/cadence law, §9 statement
> extraction), `ingestion/CONTRACT.md` (§2 DataType taxonomy, §5 scheduler, §6 normalized shapes, §8
> seed spec, §9 handlers), `00-master-plan.md` (P1/P3/P6/P7 ownership), `BUILD-STATUS.md` (§5 status, §7
> deferred ledger — this plan **absorbs** those rows, it does not restate them).

---

## 0. TL;DR

- The lake is fed by **two agent tiers**, both already implemented as principals with kill-switches,
  heartbeats, and hash-chained audit (see `iam.principals`, `ops.job_heartbeats`):
  1. **Field researchers** (`DATA-TDWL … DATA-BHB`, `DATA-FILINGS`) — fetch external sources into the
     lake as RAW `lake.objects`. Cadenced by **`ingest.schedules`** (the `enqueue_due_jobs` machine).
  2. **Derived-research / desk agents** (`SYSTEM` compute principal) — recompute VERIFIED lake objects
     into DERIVED public tables (`key_ratios`, `scores`, …) + `COMPUTED.*` lake objects for lineage.
     Cadenced by **`pg_cron → q_maintenance`** (the `nightly` / `score_batch` pattern).
  3. *(For context — OUT OF SCOPE here.)* A third tier, the **P3 newsroom editorial agents**, consumes
     VERIFIED objects to draft/publish. This plan is strictly **upstream** of P3 — it fills the lake; P3
     writes about it. Do not overlap ownership.
- Price (P1.7a) is the **worked example** of tier 1: a one-time **backfill** feed + an ongoing
  **accrual/refresh** feed. This plan applies the *same two-feed shape* to every other family, but with a
  family-appropriate refresh cadence (statements don't tick every 10 min — they change **when a company
  reports**, so their refresh is **event-driven on a results filing** + a weekly safety sweep).
- **Almost every table already exists and is empty**; the mechanism to fill it is 90% built. The work is:
  (a) a **parse adapter** per (venue × family), (b) a **seed row** in `ingest.sources`/`ingest.schedules`,
  (c) a **projection trigger** `lake.fn_<family>_project()` (copy `lake.fn_filing_project`), and (d) for
  derived families, a **refresh handler** on `q_maintenance`. Nothing else.

---

## 1. Reuse map — the machine that already exists (do NOT rebuild any of this)

Grounded in the live migrations + `worker/src/` + `ingestion/src/` (verified 2026-07-14):

| Concern | The existing mechanism (reuse verbatim) | Where |
|---|---|---|
| **When to run** | `pg_cron ingest_tick */5` → `ingest.enqueue_due_jobs()` scans `ingest.schedules` (`cadence_minutes`, `session_only`, `offset_minutes`) and inserts `ingest.job_queue` rows | `0005_prices.sql`, `0015_cron.sql` |
| **Session/holiday gate** | `ingest.venue_is_open(venue, at, '10 min','20 min')` over `venues.trading_days` + `market_holidays` + `market_sessions` (DFM/ADX Mon–Fri; rest Sun–Thu) | `0005_prices.sql` |
| **Claim/execute** | VPS worker long-polls `ingest.job_queue` `FOR UPDATE SKIP LOCKED`; `requeue_stuck_jobs('15 min')` reaps dead rows | `worker/src/ingest-poller.ts`, `consumer.ts` |
| **Fetch→store** | `TaskSpec.fetch` (impure, rotating IPRoyal proxy + BrowserClient for WAF) → `SnapshotStore.put` → `ingest.raw_snapshots` + `lake.snapshots` (sha256 dedup, immutable) | `ingestion/src/core/{fetcher,browser,snapshot}.ts` |
| **Parse (pure, replayable)** | `TaskSpec.parse(StoredSnapshot)` — no I/O, no `Date.now()`; `parserVersion` bump ⇒ replay old snapshots | `runtime.ts runParse`, CONTRACT §10 |
| **Stage → verify** | `mapRowsToStaging` → `lake.staging_rows` → `crosscheck_sweep` (pg_cron) → `cross_check` handler (`q_pipeline`) → `lake.objects` (PENDING single-source / VERIFIED 2-source), supersede-then-insert revisions | `ingestion/src/lake/{staging,cross-check}.ts`, `0026/0030` |
| **Project lake → public** | `AFTER INSERT/UPDATE` trigger on `lake.objects` guarded by `object_type`: `lake.fn_quote_project` (0031), `fn_ohlcv_daily_project` (0028), `fn_filing_project` (0034). **This is the template for every new family.** | migrations |
| **Derived refresh** | `pg_cron → pgmq q_maintenance {task:…}` → worker handler (consumer aliases `task`→`handler`). Live: `nightly` (02:00 GST → `key_ratios` recompute), `score_batch` (04:00 GST). Pattern: recompute-from-VERIFIED + write `COMPUTED.*` object. | `0015_cron.sql`, `worker/src/handlers/{nightly,score-batch,key-ratios-recompute}.ts` |
| **Identity/kill-switch/audit** | each job sets `app.principal_id` (venue `DATA-*` or `SYSTEM`), checks `iam.agent_accounts.run_enabled`, heartbeats `ops.job_heartbeats`; `heartbeat_sentinel` raises `ops.incidents` on silence | `handlers/identity.ts`, CONTRACT §9 |

**DataType taxonomy already defined** (`ingestion/src/core/types.ts`, CONTRACT §2): `quotes, indices,
filings_list, filing_detail, financials, dividends, ipo, calendar, eod_bulletin, ohlcv_backfill`.
`financials` and `dividends` are already in the union; `dividends`/`ipo` already have runtime switch cases
+ `VenueAdapter` slots. **New families we must add to the union: `ownership`, `people`** (and a
`financials` `VenueAdapter` slot + runtime case, which the interface lacks today).

---

## 2. The generalized per-family enrichment lifecycle (the P1.7a pattern, generalized)

Every data family gets the **same four-part lifecycle**. Price (P1.7a) is the reference implementation;
the only thing that varies per family is the **refresh cadence** (column 2) and the **object/projection**.

```
  ┌─ BACKFILL feed ──────┐   one-time per security: seed history depth. Idempotent (snapshot dedup);
  │  (history depth)     │   re-runs only for a new listing. e.g. ohlcv_backfill ≥2y; financials ≥8Q+3-5yr.
  ├─ REFRESH feed ───────┤   ongoing, cadence-appropriate: the "keep it current" job.
  │  (keep-current)      │   price=EOD accrual+10min; statements=event-on-results-filing+weekly sweep;
  │                      │   dividends=daily corp-action sweep; people/ownership=quarterly.
  ├─ PROJECT ────────────┤   lake.fn_<family>_project() trigger: VERIFIED/PENDING lake.objects → public.*
  └─ DERIVED REFRESH ────┘   (derived families only) q_maintenance handler recomputes from VERIFIED objects.
```

**Why refresh cadence differs from price** (the key insight the user's "same as 1.7a" framing needs):
quotes change every tick, so their refresh is a 10-min in-session poll. **Fundamentals only change when a
company files** — so the correct "ongoing" feed for statements/earnings/dividends is **event-driven off
the filings poller** (which already runs every 5 min and already does list-diff), backed by a **low-cadence
safety sweep**. This is *cheaper and more correct* than polling statement pages every 10 minutes, and it
reuses the `filing_detail` event-enqueue path that TDWL/ADX filings already use (`enqueueFilingDetails` +
`filingDetailSourceId` in `filings-poll.ts`).

---

## 3. Per-family build matrix — what exists, what's missing, exact identifiers to add

Legend: ✅ built · ⚠️ partial · ❌ missing. "Cover" = venues with a working adapter.

### 3.1 Financial statements / fundamentals — `public.financial_statements` — **the gating gap**
- **Status:** table ✅ (empty) · ingest source/schedule ❌ (none seeded) · adapter ❌ (no `financials.ts`
  anywhere) · runtime `financials` case ❌ · projection ❌ · derived refresh ✅ (`key_ratios_recompute`
  exists but starved of inputs). **Normalizer ✅ built** (`statement-normalizer.ts`, §3.1 primitive keys).
- **Backfill feed:** ≥8 trailing quarters + 3–5 annual per security (07 D-src-6 floor). Sources: Mubasher
  `/financial-statements`+`/ratios` (TDWL/ADX, 5-yr tables), Yahoo `fundamentals-timeseries` (DFM/QE,
  multi-year standardized), MSX `.aspx` + PDF. Model on `ohlcv_backfill`: a depth-parameterized one-time
  sweep, idempotent via snapshot dedup.
- **Refresh feed:** **event-driven** — when the filings poller sees a RESULTS/financial-statement filing
  for a security, enqueue a `financials` re-scrape for that name (reuse `enqueueFilingDetails` pattern) +
  a **weekly safety sweep** (`cadence_minutes` ≈ 10080, Sat 09:00 UTC, `session_only=false`).
- **To build:** (a) `VenueAdapter.financials?: TaskSpec<NormalizedStatements>` slot + `financials` case in
  `runtime.ts tasksForDataType`; (b) `financials.ts` per venue (TDWL/ADX Mubasher; DFM/QE Yahoo; MSX PDF)
  → route each through `statement-normalizer.ts` → emit `FILING.FINANCIALS` staging rows carrying the
  §3.1 line_items; (c) seed `ingest.sources`+`ingest.schedules` rows; (d) **NEW projection**
  `lake.fn_financials_project()` (object_type `FILING.FINANCIALS`) → `public.financial_statements`
  (`source_object_id` FK already present), one row per (statement_type, basis, fiscal_period). Derived
  refresh already wired: `nightly` → `key_ratios` → `score_batch`.
- **Absorbs:** `DEF-STMT-INGEST`. **Blocked by:** live sessions + Yahoo egress (not code).

### 3.2 Ratios — `public.key_ratios` — **DERIVED, already built**
- **Status:** ✅ end-to-end (`ratios-compute.ts` + `key-ratios.ts`, sector-aware, `[NEW COL]` shipped).
  Runs off `nightly` (02:00 GST). **No new work** — it produces real numbers the moment §3.1 lands.
- The only "obtain from source" ratios (Mubasher `/ratios` ROE/ROA/EPS/growth) are captured by the §3.1
  `financials` adapter as a cross-check/fallback into `line_items`; the canonical ratio set stays DERIVED
  (07 §3.2). Do **not** build a second ratio pipeline.

### 3.3 Filings — `public.filings` — **✅ list + publish; ⚠️ detail; ❌ facts**
- **Status:** filings_list ✅ 6/6 (5-min cadence) · `filings_poll` handler ✅ (event-driven `filing_detail`
  enqueue) · publish ✅ (`fn_filing_project`, 0034, 86 rows) · `filingDetail` adapter ⚠️ **TDWL/ADX only**
  (DFM/QE/MSX/BHB ❌) · full_text/`extracted_facts`/`ai_summary` ❌.
- **To build:** extend `filingDetail` to the 4 missing venues (`filings.ts` detail path each); then the
  full-text/facts upgrade (PDF→EN → `extracted_facts` typing → `ai_summary` via `src/lib/llm/`).
- **Absorbs:** `DEF-VENUE-FILINGS`, `DEF-FILING-FACTS` (facts need the shared PDF-LLM pipeline).

### 3.4 Earnings — `public.earnings_events` — **❌ (rides filings)**
- **Status:** table ✅ (empty) · no dedicated ingest (earnings arrive as `filing_type='RESULTS'`) · no
  parse → earnings_events · verdict compute ❌ · earnings-date calendar ❌.
- **To build:** a parse of a RESULTS filing's `extracted_facts` → `earnings_events`
  (`eps_actual, revenue_actual, verdict BEAT/IN_LINE/MISS, surprise_pct, rvc_table`) — depends on §3.3
  facts. Then wire the **event-driven single-name Score recompute** (`earnings_events.verdict` set →
  enqueue `score_batch {securityIds:[id]}` on `q_maintenance`; the engine already accepts the slice).
- **Absorbs:** `DEF-SCORE-EVENTS-TRIGGER`. Earnings-*date* calendar (forward-looking) is largely a **P6**
  suite concern; note it, don't build it here.

### 3.5 Dividends — `public.dividends` — **❌ ingest**
- **Status:** table + `fn_dividend_confirm_guard` (33b human-confirm) + `fn_dividend_fanout_notify` ✅ ·
  `VenueAdapter.dividends` slot + runtime `dividends` case ✅ · adapter ❌ (no `dividends.ts`) · seed ❌ ·
  projection ❌.
- **Backfill:** Mubasher `/corporate-action` history back to 2019 (TDWL/ADX) + DIVIDEND-filing history.
- **Refresh:** daily corp-action sweep (`cadence_minutes` ≈ 1440, 15:00 UTC) + event-driven on a DIVIDEND
  filing.
- **To build:** `dividends.ts` per venue → emit `DIVIDEND.EXDATE`/`DISCLOSURE.DPS` staging; **NEW**
  `lake.fn_dividend_project()` → `public.dividends` that **respects `state='pending_confirm'` default and
  does NOT auto-`live`** (price-sensitive → the 33b human gate; reuse `fn_dividend_confirm_guard`, never
  bypass). Feeds `dividend_yield`/`payout_ratio` in `key_ratios` for free.

### 3.6 Estimates / Revisions — `public.estimates` — **❌ (no cheap source)**
- **Status:** table ✅ (empty) · no consensus source (biggest sourcing risk, 07 G / D-src-5) · `estimates_agg`
  cron ❌ (comment-only in `nightly_omnibus`). Revisions factor **ships NULL** (D-8).
- **To build (deferred):** when a consensus source is chosen — schedule `estimates_agg` @ 23:00 GST
  (30/90-day revision Δ + breadth → `revisions_features` MV) feeding the Score's Revisions factor.
- **Absorbs:** `DEF-ESTIMATES-AGG`. **Owner call required** (D-src-5) before any build.

### 3.7 People — `public.company_people` — **❌ ingest** (table shipped 0035)
- **Status:** table ✅ (empty, board/management + independence + seat_count) · no `people` DataType · no
  adapter · no projection.
- **Refresh:** low-volume — **quarterly sweep** + event-driven on a board-change/governance filing.
- **To build:** add `people` to the DataType union + `VenueAdapter.people` slot + runtime case; adapter
  scraping venue profile pages / Mubasher `/profile` / ADX `overview.json`; **NEW** `lake.fn_people_project()`
  → `company_people`. **The same profile scrape populates `securities.sector`** — do them together.
- **Absorbs:** `DEF-SECTOR-DATA` (sector is the credibility gate for the Score's cohorts + ratio-validity
  map — 07 §3.3/§3.5), part of P1.7e-I.

### 3.8 Ownership — `public.ownership_snapshots` / `holders` / `holder_positions` — **❌**
- **Status:** tables ✅ (empty) · no `ownership` DataType · no adapter · no projection.
- **Refresh:** quarterly (low volume). Sources: Mubasher `/major-shareholders` (TDWL/ADX, with history) +
  venue/registrar disclosures + >5% filings.
- **To build:** add `ownership` DataType + adapter + `lake.fn_ownership_project()`. Historical time series
  starts at launch (01 §9 defers deep ownership history).
- **Absorbs:** P1.7e-J.

### Build/missing summary

| Family | Table | Ingest source | Adapter (cover) | Runtime case | Projection | Derived refresh |
|---|---|---|---|---|---|---|
| Quotes | ✅ | ✅ 6/6 | ✅ 6/6 | ✅ | ✅ `fn_quote_project` | — |
| OHLCV | ✅ | ✅ backfill+accrual | ✅ | ✅ | ✅ `fn_ohlcv_daily_project` | ✅ `ohlcv_accrual` |
| Filings list | ✅ | ✅ 6/6 | ✅ 6/6 | ✅ | ✅ `fn_filing_project` | — |
| Filing detail | ✅ | event | ⚠️ TDWL/ADX | ✅ | (into filings) | ❌ facts (PDF-LLM) |
| **Financials** | ✅ empty | ❌ | ❌ 0/6 | ❌ | ❌ | ✅ (starved) |
| **Ratios** | ✅ | — | — | — | ✅ `key-ratios.ts` | ✅ `nightly` |
| **Score** | ✅ | — | — | — | ✅ `scores.ts` | ✅ `score_batch` |
| **Earnings** | ✅ empty | rides filings | ❌ | ❌ | ❌ | ❌ verdict + trigger |
| **Dividends** | ✅ empty | ❌ | ❌ (slot ✅) | ✅ | ❌ | (feeds ratios) |
| **Estimates** | ✅ empty | ❌ no source | ❌ | ❌ | ❌ | ❌ `estimates_agg` |
| **People** | ✅ empty | ❌ | ❌ | ❌ | ❌ | — |
| **Ownership** | ✅ empty | ❌ | ❌ | ❌ | ❌ | — |

---

## 4. Cadence schedule — the new researcher jobs (all on the existing machine)

New `ingest.schedules` rows (one `ingest.sources` row per venue×family; `enqueue_due_jobs` handles the
rest). Stagger `offset_minutes` per the existing TDWL+0…BHB+5 convention. Times UTC.

| Family | `data_type` | `cadence_minutes` | `session_only` | Trigger | New cron (if any) |
|---|---|---|---|---|---|
| Financials (refresh) | `financials` | 10080 (weekly Sat 09:00) | false | + event on RESULTS filing | — (uses `ingest_tick`) |
| Financials (backfill) | `financials_backfill` | — (one-time) | false | manual / new-listing | — |
| Dividends | `dividends` | 1440 (15:00) | false | + event on DIVIDEND filing | — |
| Earnings | (rides `filing_detail`) | — | — | event on RESULTS filing | — |
| People + sector | `people` | 129600 (quarterly) | false | + event on GOVERNANCE filing | — |
| Ownership | `ownership` | 129600 (quarterly) | false | + event on >5% filing | — |
| Estimates agg (derived) | — | — | — | — | `estimates_agg` `0 19 * * *` = 23:00 GST → `q_maintenance {task:'estimates_agg'}` *(when a source exists)* |

The only **new pg_cron** entry is the optional `estimates_agg` (deferred until a consensus source lands).
Every other new job is a **row in `ingest.schedules`**, enqueued by the existing `ingest_tick`. **No new
scheduler, no new queue.** Request-budget guardrail (≤300/host/day) already enforced in `core/fetcher.ts`;
these low-cadence families add negligible load (weekly/daily/quarterly, not 10-min).

---

## 5. Build sequence (dependency-ordered, slotted under P1.7b–e)

This plan is the **live-data completion of P1.7b–e** — the code spine (normalizer, ratio engine, Score
engine, filings publish, `company_people`) already landed 2026-07-14. It is **not** a new master-plan
phase. Reader-facing suites (analyst hub, earnings/dividend suites, AI) remain **P6**; backfill *depth*
completion remains **P7**.

1. **Financials researcher (unblocks everything derived).** §3.1 — TDWL vertical slice first (Mubasher
   `/financial-statements` → `statement-normalizer` → `FILING.FINANCIALS` staging → `fn_financials_project`
   → `financial_statements` → `nightly` `key_ratios` → `score_batch`), proving the chain on one venue, then
   fan out ADX (Mubasher) / DFM+QE (Yahoo) / MSX (PDF). **This is the critical path.** Effort L.
2. **Sector + people researcher (parallel, unblocks Score credibility).** §3.7 — the profile scrape
   populating `securities.sector` (D-1/D-2 gate) *and* `company_people`. Effort M.
3. **Dividends researcher.** §3.5 — feeds `dividend_yield`/`payout_ratio` + the reader dividend card,
   honoring the 33b confirm gate. Effort S–M.
4. **Filing detail fan-out + facts.** §3.3 — the 4 missing `filingDetail` venues, then the PDF-LLM
   full-text/`extracted_facts`/`ai_summary` upgrade (shared pipeline). Effort M–L.
5. **Earnings researcher + Score event trigger.** §3.4 — parse RESULTS facts → `earnings_events`; wire the
   verdict→single-name recompute. Effort M. Depends on 4.
6. **Ownership researcher.** §3.8 — quarterly, low volume. Effort M.
7. **Estimates/Revisions.** §3.6 — **owner-gated** on a consensus source; until then Revisions=NULL.

Each numbered item = the §2 four-part lifecycle for that family. Agents editing shared files
(`runtime.ts`, `core/types.ts`, migrations) concurrently → use `isolation:'worktree'`; the projection
triggers are independent migrations that can land in parallel.

---

## 6. Guardrails (locked — restated so no builder reinvents infra)

- **No new scheduler / queue / pipeline / agent framework.** A researcher = `ingest.sources` +
  `ingest.schedules` + a `TaskSpec` (fetch impure + parse **pure**). A derived agent = a `q_maintenance`
  handler + a `pg_cron` enqueue. Copy `fn_filing_project` for every new projection.
- **Pure parse, snapshot-first, config-driven** (no hardcoded URLs — `endpoint_config`; no `Date.now()` in
  parse). Golden-test every adapter against `ingestion/fixtures/`, zero network. Replay via `parserVersion`.
- **Cost discipline:** ingestion adds only low-cadence fetches; the derived tier is pure SQL/TS math (≈0
  marginal cost). The **only** LLM cost is the §3.3 filing full-text + §3.4 facts, bounded per-filing, via
  `src/lib/llm/` — never a provider SDK directly, never in the hot path.
- **Price-sensitive discipline:** dividends/IPO/results project as `pending_confirm`/PENDING and require the
  **human** 33b gate before `live`/`VERIFIED` (`fn_dividend_confirm_guard`, `fn_object_state_guard`). Never
  auto-publish a price-sensitive number.
- **Single-source honesty (D-src-1):** most fundamental families are single-source per venue → objects sit
  PENDING; project PENDING+VERIFIED (like quotes/OHLCV/filings) and surface the tier honestly on the reader.
- **Migrations** timestamp-prefixed (next after `20260713000035`), applied via `apply_migration` **and**
  committed. **Doc-sync** (`AGENTS.md`): on completion mark done in `BUILD-STATUS.md`, remove the absorbed
  §7 row, tick `07-lake-enrichment.md`.
- **Don't overlap P3.** This plan fills the lake (DATA tier). P3's editorial agents read it. Keep the
  boundary.

---

## 7. Deferred-ledger reconciliation

This plan is the **home** for these existing `BUILD-STATUS.md §7` rows — it does not restate them, it
sequences them: `DEF-STMT-INGEST` (§3.1, step 1), `DEF-SECTOR-DATA` (§3.7, step 2), `DEF-VENUE-FILINGS`
+ `DEF-FILING-FACTS` (§3.3, step 4), `DEF-SCORE-EVENTS-TRIGGER` (§3.4, step 5), `DEF-ESTIMATES-AGG` (§3.6,
step 7), `DEF-STMT-LLM-PDF` (the shared PDF-LLM pipeline behind §3.1 MSX + §3.3 facts). Add one §7 row
pointing at this plan as their consolidated home.

**Definition of done:** every non-price family has a live researcher keeping it current on the existing
scheduler (backfill + refresh + projection), the derived tier (`key_ratios`/`scores`) runs on real
fundamentals across the 812 universe with populated sectors, and `BUILD-STATUS.md` + `07-lake-enrichment.md`
reflect it — with **zero new scheduler/queue/pipeline code**.

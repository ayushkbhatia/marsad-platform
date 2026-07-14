# Plan — ADX / MSX / BHB price-history backfill adapters

> **Self-contained handoff.** Paste this into a fresh chat and say: *"ultracode — execute this plan; run a
> workflow to build the ADX/MSX/BHB price-history backfill adapters."* It assumes NO prior conversation
> context. Written 2026-07-14.

---

## 0. TL;DR

Yahoo (`chart?range=2y`) covers only **TDWL / DFM / QE** (`.SR/.AE/.QA`) — those have `ohlcv_backfill`
sources (ids 22/23/24) and are backfilling now. **ADX, MSX, BHB are NOT on Yahoo** → `public.ohlcv_daily`
has zero bars for them. This plan builds their price-history backfill via **non-Yahoo sources**, one
independent track per venue, as a recon → build → verify workflow.

- **ADX** — Mubasher historical CSV. Most feasible. Effort **M**. Code-first.
- **MSX** — msx.om history XHR. Feasibility unknown until a **market-open** network capture. Effort **M** (if XHR exists) / **L** (per-day XLSX fallback).
- **BHB** — no cheap ≥2y source; recommend **accept as coverage-gap** and accrue forward. Effort **L**, marginal ROI — make this decision *before* building.

Do **not** disturb the running TDWL/DFM backfill or the worker config while doing this.

---

## 1. Context (the platform)

- **Marsad** — agent-run GCC equities intelligence platform. 6 venues: TDWL (Saudi), DFM (Dubai), ADX (Abu Dhabi), QE (Qatar), MSX (Oman), BHB (Bahrain). **660 listed securities** in `public.securities`.
- **P1.7a** = persist **price history** into `public.ohlcv_daily` (≥126 trailing daily bars per security). It gates the Marsad Score's **Momentum** factor and the chart tab. This plan completes the 3 venues P1.7a can't reach via Yahoo.
- **Repo**: this working dir. **DB**: Supabase project `yjsncnpbjuueaoeejrqj` (query via the Supabase MCP `execute_sql`; DDL via `apply_migration`). **VPS worker**: Hetzner, `ssh deploy@91.99.99.85`, code at `/opt/marsad`, systemd unit `marsad-worker`, deploys by pulling `main`.
- **Source of truth docs**: `docs/architecture/07-lake-enrichment.md` (§2.1 WAF posture, §2.2 per-venue source matrix, §4 P1.7a), `docs/BUILD-STATUS.md` (§7 deferred ledger).

---

## 2. The pipeline your adapter plugs into (already built + working)

```
fetch → snapshot (lake.snapshots) → parse → NormalizedOhlcv rows
     → stage (lake.staging_rows, object_type='OHLCV.CLOSE')
     → crosscheck_sweep (pg_cron, every 1 min)
     → cross_check handler (q_pipeline) → lake.objects (OHLCV.CLOSE, single-source PENDING)
     → trigger objects_ohlcv_project_ins (migration 0028) → public.ohlcv_daily   ✅ automatic
```

**You only build the `fetch` + `parse`.** Everything downstream (staging map, cross-check, projection to
`ohlcv_daily`) is done and proven — QE ran end-to-end; TDWL/DFM are running now.

Recently-shipped infra you must NOT rebuild (and can rely on):
- **gzip content-encoding decode** in `ingestion/src/core/fetcher.ts` — fetched bytes are already plaintext.
- **Rotating IPRoyal proxy** per-source (`endpoint_config.use_proxy=true` + `proxy_mode:'rotate'`) — resolved in `runtime.httpClientForSource`. Use for WAF venues.
- **BrowserClient** `bootstrap` / `extract:'direct'` mode (`core/browser.ts`) — for Akamai/WAF sites; ADX *filings* already fetches its apigateway URL this way (`adapters/adx/filings.ts`).
- **sweep-dedup** (migration 0030 `swept_at`) + **backfill-staging-consume** (migration 0032, trigger `objects_ohlcv_consume_backfill`) — the q_pipeline queue will NOT churn on your backfill.
- **OHLCV projection** (0028) — objects → `ohlcv_daily` upsert, PENDING+VERIFIED, idempotent on `(security_id, trade_date)`.

---

## 3. The template to copy

`ingestion/src/adapters/yahoo/ohlcv.ts` — the working backfill adapter. Mirror its structure:
- `fetch(ctx: FetchContext): Promise<FetchResult[]>` — reads `endpoint_config.symbols`, bounded-concurrency pool (`fetch_concurrency`, default 8), one GET per symbol → `FetchResult`. Honors the `ctx.onFetched` **streaming sink** (stage each symbol as it lands; return `[]`). Per-symbol try/catch isolation (a 404 ticker skips, sweep continues).
- `parse(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv>` — **PURE** (no `Date.now`, no clock), snapshot bytes → `NormalizedOhlcv[]`: `{ venue, ticker (RAW, so cross-check keys match), tradeDate 'YYYY-MM-DD', open, high, low, close, volume }`. Malformed body → `[]` (never throw hard).
- Export a `TaskSpec<NormalizedOhlcv>` with `dataType: 'ohlcv_backfill'`.

Also read: `ingestion/src/runtime.ts` — `mapOhlcv` (staging map, emits natural_key `OHLCV.CLOSE:{venue}:{ticker}:{tradeDate}`), `withYahooSymbols` (symbol injection), and the routing (§4 below).

---

## 4. ⚠️ Routing gap you MUST close (read before building)

`runtime.tasksForDataType` has **no `ohlcv_backfill` case** — the Yahoo backfill only resolves through the
`provider='yahoo'` branch (`tasksForProvider` → `yahooTasks.ohlcvBackfill`). A venue-native
`ohlcv_backfill` source will resolve to **no task** unless you extend routing. Two options:

- **(A) VenueAdapter slot** — add `ohlcvBackfill?: TaskSpec` to `VenueAdapter` (core/types.ts), mount it in `adapters/<venue>/index.ts`, and add a `case 'ohlcv_backfill': if (adapter.ohlcvBackfill) out.push(...)` to `tasksForDataType`. Cleanest for venue-native adapters.
- **(B) provider discriminant** — add a `provider='mubasher_csv'` (etc.) branch to `tasksForProvider`, like Yahoo. Better if the source is a cross-venue aggregator (Mubasher).

Recommend **(A)** for MSX (venue-native) and **(B)** with `provider='mubasher_csv'` for ADX (Mubasher is cross-venue; TDWL could reuse it later). Confirm the choice in recon.

Also: `withYahooSymbols` injects `endpoint_config.symbols` from `public.securities` **only for `provider='yahoo'`**. For these venues either generalize that injection for the new provider, OR bake the symbol list into `endpoint_config.symbols` statically (precedent: the MSX quotes fix set 68 tickers statically).

---

## 5. Source config to seed (per venue)

An `ingest.sources` row (via a migration, mirroring `…0022_activate_yahoo.sql` / `…0027_yahoo_proxy_rotate.sql`):
```
venue='ADX', data_type='ohlcv_backfill', transport=<'http'|'http_bootstrap'>, active=true,
endpoint_config = {
  urlTemplate: '…{symbol}… or …{hash}…',
  headers: {…},
  use_proxy: true, proxy_mode: 'rotate',        -- WAF venues
  fetch_concurrency: 4,                          -- keep modest; the drain, not the fetch, is the bottleneck
  provider: 'mubasher_csv',                      -- if using routing option (B)
  symbols: […]                                   -- if not auto-injected
}
```

---

## 6. Per-venue build specs

### 6a. ADX — Mubasher historical CSV  ·  effort M  ·  MOST FEASIBLE
- **Source**: `static.mubasher.info/File.MubasherCharts/…/{hash}.csv` — full daily OHLCV since IPO, plain HTTP, no auth (verified: Aramco 2019-12-11→present, 1631 rows). Cleanest single price-history artifact.
- **The `{hash}`** is per-ticker, embedded in that ticker's Mubasher stock-page HTML. So it's **2-step per ticker**: (1) fetch the ADX Mubasher page → regex/parse the `{hash}`; (2) GET the CSV → parse rows.
- **WAF**: plain curl to `static.mubasher.info` → **403**. MUST route through the **rotating proxy** (`use_proxy:true`) and/or BrowserClient. Confirm in recon which works from the VPS.
- **Build**: `ingestion/src/adapters/adx/ohlcv.ts` (or a shared `adapters/mubasher/ohlcv-csv.ts` since TDWL can reuse it). CSV parser → NormalizedOhlcv. 93 ADX tickers.
- **NOT** ADX-native `financial-reports.json` — that's fundamentals (P1.7b), different thing.

### 6b. MSX — msx.om history XHR  ·  effort M (if XHR) / L (XLSX)  ·  RECON-GATED, MARKET-OPEN
- **No Yahoo.** `snapshot.aspx?s={symbol}` returns single-value `<span>`s (today's H/L/Vol/Close — what the *quotes* parser reads), **not** a ≥2y series. The chart is JS/XHR-rendered.
- **RECON (needs a live MSX session, Sun–Thu)**: on the VPS, network-capture the historical-series `.ashx`/`.aspx` handler the MSX chart fires for one symbol. If found → fan out over 68 tickers → **M**. If none → fall back to the **daily-bulletin XLSX** (current source 15 `reports.aspx?t=Daily` is a **dead 302 → PageNotFound**; find the real path) iterated backward by date → slow, **L**.
- Do **not** promise depth until the XHR is confirmed.

### 6c. BHB — accept as coverage gap  ·  effort L, marginal  ·  DECIDE FIRST
- **No cheap ≥2y source.** Not on Yahoo, no Mubasher CSV for Bahrain, deep `bahrainbourse.com` paths **Radware-blocked** from the VPS IP (needs IPRoyal residential proxy). Only artifact = per-day Daily-Trading-Summary XLSX (~500 proxied requests for 2y). Browser-through-proxy path is currently **hard-down** (BHB filings: 148 consecutive fails).
- **8 securities only.** **Recommendation: do NOT build a 2y BHB backfill.** Accept BHB as the honest coverage-gap venue; accrue forward from today via the EOD accrual once BHB quotes work. This is **owner decision D-src-4** (`07 §5`) — surface it, don't silently build.

---

## 7. Parallel-agent workflow (how to run it)

Three independent venue tracks. Use a workflow (`ultracode`):

**Phase 1 — RECON (parallel, 1 agent/venue).** Confirm the exact endpoint + data shape + reachability, from code + docs + a **safe** live probe via the VPS proxy/browser. Deliver: the confirmed URL(s), the response shape, the routing choice (§4 A vs B), and a go/no-go. (MSX recon needs a market-open session; BHB recon = confirm the XLSX path + make the accept-as-gap call.)

**Phase 2 — BUILD (parallel, only venues recon greenlit).** Per venue: the adapter (`fetch` + pure `parse`), a captured **fixture** + golden unit tests (zero network), the routing wiring (§4), and the `ingest.sources` seed migration. Reuse `yahoo/ohlcv.ts`. Each agent works in isolation (`isolation:'worktree'` if editing shared files like `runtime.ts`/`core/types.ts` concurrently — otherwise they'll conflict).

**Phase 3 — VERIFY (per venue).** Deploy to the VPS, trigger the backfill job (`insert into ingest.job_queue (source_id, run_after, priority, status) values (<id>, now(), 1, 'queued')`), and confirm bars land: `select count(distinct security_id), count(*) from public.ohlcv_daily od join public.securities s on s.id=od.security_id where s.venue_code='<V>'` climbs, with q_pipeline bounded (not diverging).

---

## 8. Guardrails (non-negotiable)

- **Don't disturb** the running TDWL/DFM backfill or the worker's `dbPoolMax`/`pipelineConcurrency`. If you must restart the worker, expect brief interruption + re-run (idempotent).
- **Pure parse** — no `Date.now()`/`Math.random()`/`new Date()` in `parse()` (breaks replay). Config-driven via `endpoint_config` (a URL/field change is a data fix, not a redeploy).
- **Test against fixtures** — capture a real response to `ingestion/fixtures/<venue>/…`, golden-test the parser, zero network in unit tests.
- **Doc-sync convention** (`AGENTS.md`): on defer, log to `BUILD-STATUS.md §7`; on completion, mark done there + update `07-lake-enrichment.md §2.2` and tick the venue in the P1.7a matrix.
- **Pooler ceiling**: Supabase session pooler caps at **25** clients; worker pool is 20. Don't raise worker concurrency past that.
- Migrations are timestamp-prefixed (`20260713000033_…`); next number after 0032. Apply via `apply_migration` AND commit the file.

---

## 9. Recommended sequencing

1. **ADX first** — code-first, most feasible, biggest venue of the three (93). Ship it end-to-end as the proof.
2. **MSX** — recon during a live session; build only if the history XHR exists. If it's XLSX-only, weigh effort vs the 68 tickers.
3. **BHB** — make the accept-as-gap call (owner D-src-4) *before* any build. Likely: mark it the coverage-gap venue and move on.

**Definition of done for this plan:** ADX `ohlcv_daily` populated (≥126 bars for liquid tickers); MSX either populated or an explicit "XLSX-only, deferred" call logged; BHB decision recorded. All three reflected in `BUILD-STATUS.md §7` + the enrichment doc.

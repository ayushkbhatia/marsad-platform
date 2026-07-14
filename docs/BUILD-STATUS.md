# Marsad — Build Status & Roadmap

_Last updated: 2026-07-14. Living document — the source of truth for what's shipped, what's live, and what's next._

Maps against the phase plan in [`docs/architecture/00-master-plan.md`](architecture/00-master-plan.md).

> **Doc-sync convention (follow this — it is also a project rule in `AGENTS.md`):** whenever work is
> **deferred/parked**, log it in §7 (Deferred backlog) with a trigger + a home so it is never silently
> dropped. Whenever deferred/in-flight work is **completed + integrated**, update the docs *in the same
> change* — mark it done here, remove it from §7, and update the relevant domain doc (e.g.
> `architecture/07-lake-enrichment.md`). Docs move with the code, not after it.

---

## 1. Live infrastructure (running now)

| Component | State | Detail |
|---|---|---|
| **GitHub** | ✅ | `ayushkbhatia/marsad-platform` (private), continuous on `main`, CI green |
| **Supabase** | ✅ | Project `yjsncnpbjuueaoeejrqj`, ap-south-1, Postgres 17.6. All 21 migrations applied (128+ tables, RLS on every one) |
| **Vercel** | ✅ | Auto-deploys `main`; `marsad-platform.vercel.app` |
| **VPS worker** | ✅ | Hetzner CX23 `91.99.99.85` (Nuremberg). `marsad-worker` running, heartbeating every ~10s, DB-connected via `marsad_worker` role |
| **LLM gateway** | ✅ | `src/lib/llm/` — Anthropic ↔ OpenRouter ↔ local Ollama swap by env only. Verified all 3 providers |
| **CI/CD** | ✅ | GitHub Actions: web (tsc/lint/build) + worker (tsc) + db (all migrations from scratch + RLS assert). Green |

---

## 2. Shipped by phase

### P0 — Foundations ✅ COMPLETE
- 21 migrations: full schema (iam/lake/ingest/ops/billing/comms/analytics/vectors), RLS on every exposed table, seed reference data (7 venues, 6 indices, 54 holidays, 12 agent service accounts, 10 rules R-01..R-10, 8 templates, capability matrix)
- Provider-agnostic LLM gateway with per-role routing + cost accounting
- Design tokens → Tailwind v4 theme, brand fonts, 5 core UI components, `/styleguide`
- Worker skeleton, cloud-init, systemd, CI
- **Security verified live**: score-leak blocker fixed, all SECURITY DEFINER functions have `search_path`, RLS matrix correct (anon reads public reference only, gated tables hidden, service schemas denied)

### P1 — Ingestion ✅ CORE COMPLETE (tuning in progress)
- `ingestion/` standalone package: core framework (undici HTTP + Playwright BrowserClient for WAF venues, snapshot-first hash-addressed store, scheduler, rate-limit ≤300/day/host, 6-state freshness machine), 6 venue adapters, staging mapper → cross-check 2-source → VERIFIED lake objects, key-ratios, worker pgmq handlers
- **Runtime bring-up on the VPS**: `ingest.job_queue` claim loop (worker claims + dispatches), poison-message handling, snapshot-first storage
- **PROVEN end-to-end**: DFM + MSX filings → raw snapshots stored in the lake
- 239 ingestion + 37 worker tests pass

### Infrastructure / VPS bring-up ✅
- Full owner provisioning (Hetzner + cloud-init + Playwright Chromium + worker.env)
- **Cracked the make-or-break WAF question**: GCC exchanges block datacenter/proxy IPs (see §3)

---

## 3. Data source status (per venue)

The scariest unknown — reaching the exchanges — is resolved. Findings:

| Venue | Quotes source | Filings | Notes |
|---|---|---|---|
| **TDWL** (Saudi) | ✅ **Mubasher** aggregator (JSON API, 387 tickers) + ✅ **Yahoo** `.SR` (cross-check, dormant) | ⚠️ still on Akamai site | Official saudiexchange.sa is Akamai IP-blocked for all our IPs; Mubasher + Yahoo are the paths |
| **DFM** (Dubai) | ✅ official + ✅ **Yahoo** `.AE` (cross-check, dormant) | ✅ 200 | direct from VPS |
| **QE** (Qatar) | ✅ official + ✅ **Yahoo** `.QA` (cross-check, dormant) | ⚠️ URL 404 (tuning) | direct from VPS |
| **ADX** (Abu Dhabi) | ✅ official (browser) | ⚠️ endpoint undiscovered | direct from VPS; Yahoo doesn't cover |
| **MSX** (Muscat) | ✅ official | ✅ 200 | direct from VPS; Yahoo doesn't cover |
| **BHB** (Bahrain) | via **IPRoyal GCC proxy** | ⚠️ filings URL 403 (tuning) | datacenter IP blocked; proxy solves home page |

**Cross-check strengthened**: Yahoo Finance (`v8/finance/chart`, no WAF/proxy) gives TDWL/QE/DFM a 2nd source → 2-source → VERIFIED, plus ≥2y OHLCV backfill. Built + tested, seeded `active=false` pending provider-aware routing.

---

## 4. Known gaps / in-flight tuning

1. **Provider-aware routing** — runtime resolves adapter by `(venue, data_type)`; needs to also key on `endpoint_config.provider` (to run Yahoo alongside the primary) + an `ohlcv_backfill` branch. Gates Yahoo activation.
2. **Per-venue endpoint fixes**: QE filings 404, ADX filings endpoint discovery, BHB filings URL (403 even via proxy), TDWL filings (only quotes moved to Mubasher).
3. **Downstream verification**: confirm snapshots → parse → staging → cross-check → VERIFIED lake objects (the second half of the pipeline).
4. **Live quote validation**: quotes are session-gated → validate when GCC markets open (Sun–Thu ~10:00 GST).

---

## 5. Next-phase roadmap

### P1.5 — Activate & Tune (~80% done)
- ✅ Provider-aware routing → Yahoo activated (2nd cross-check source + backfill)
- ✅ ADX endpoint discovered + filings working end-to-end (fetch → cross-check → lake.objects)
- ✅ Cross-check wired (pg_cron sweep, migration 0026) — staged rows → VERIFIED/PENDING lake objects
- ✅ BrowserClient `direct` mode (reusable WAF-venue capability)
- ⏳ Remaining: `public.filings` publish path (detail-fetch + single-source publish rule); QE/BHB/DFM/MSX filings tuning; Tue market-open live-quote validation (2-source VERIFIED path); ≥2y backfill kickoff. See `memory/marsad-next-session.md`.

### P1.7a — Price history (in progress)
Two feeds fill `ohlcv_daily` — **both required, different cadences, do not conflate**:
- **Backfill (one-time per security):** ≥2y seed via Yahoo `chart` etc. ✅ **built + proven live
  2026-07-14** — full chain fetch→snapshot→parse→stage→cross-check→`ohlcv_daily` validated on QE.
  **Per-venue backfill source coverage:** TDWL/QE/DFM = Yahoo `chart`; **ADX = Mubasher historical
  CSV** (0033, provider `mubasher_csv`, `adapters/mubasher/ohlcv-csv.ts`); **MSX = native
  `company-chart-data.aspx` JSON** (0034, provider `msx-company-chart`, `adapters/msx/history.ts` —
  ≥2y daily **close-only**, intraday ticks filtered). Both seeded `active=false` pending the
  post-deploy activation flip. **BHB remains the one price-history GAP** (needs proxy — see DEF-BHB-OHLCV).
- **EOD accrual (ongoing, +1 bar/security/trading-day):** rolls the intraday `quotes_latest` ticks
  into that day's O/H/L/C/volume **at close** (cadence is DAILY, not the ~10-min quote cadence).
  ⏳ **wired but NOT YET VALIDATED** — migration 0028 (`accrue_ohlcv_from_quotes` + `ohlcv_accrual`
  pg_cron @ 18:00 UTC) is live but has never run against a real session. **Must prove:** after ≥1 GCC
  session → 18:00 roll-up → confirm exactly one correct new bar/security lands. **Don't skip — the
  reader is only right once the daily bar keeps appearing, not just once history is seeded.**
  (`07-lake-enrichment.md` §P1.7a V-1/V-2.)
- **Throughput follow-ups before the full-universe backfill:** sweep-dedup (`crosscheck_sweep`
  re-enqueues duplicates → queue diverges) + handler **tx-threading** (each handler holds a
  `runAsAgent` tx *and* nests pool connections → deadlock caps concurrency). QE `.QA` history shallow
  (~40 bars) → needs QE `MarketWatch.txt` for Score depth (≥126). Detail in `memory/marsad-next-session.md`.

### P1.7b — Fundamentals + ratios (code spine landed 2026-07-14)
The **derived data path is built + tested**; it goes live the moment `financial_statements` is populated.
- ✅ **`[NEW COL]` migration** (0036) on `public.key_ratios`: `net_margin, gross_margin, rev_growth_yoy,
  eps_growth_yoy, rev_cagr_3y, eps_cagr_3y, ret_3m, ret_6m, ret_12_1, ebitda_ttm, currency_computed`.
- ✅ **Sector-aware ratio recompute** (`ingestion/src/lake/ratios-compute.ts` + `key-ratios.ts`): proper
  TTM assembly (trailing-4Q flows / latest balance / prior-year + 3y-ago for growth+CAGR), margins,
  div-adjustable momentum from `ohlcv_daily`, and the §3.3 **sector→valid-ratio map** (banks/insurers
  drop EV/EBITDA + gross-margin + net-debt/EBITDA, keep P/B+ROE+NIM). **Divergence from 07 §3.6:** the
  recompute is **TS** (`KeyRatiosRecompute`), not a SQL `fn_recompute_key_ratios()` — the shipped
  code path chose TS; docs updated to match.
- ✅ **Statement-normalization service** (plan §2, `ingestion/src/lake/statement-normalizer.ts`): the
  §3.1 primitive-key contract + deterministic Mubasher `/financial-statements`+`/ratios` and Yahoo
  `fundamentals-timeseries` mappers + a validation harness + a TTM deriver. Golden-tested vs fixtures,
  zero network. LLM/PDF path is a declared-but-throwing seam for P1.7d.
- ⏳ **Not yet**: the live statement scrape that fills `financial_statements` (Mubasher/Yahoo/MSX
  adapters + Yahoo egress) — until it lands, `key_ratios`/Score inputs are price-only. See §7.
- ⏳ **Wired**: `nightly` handler runs the full `key_ratios` recompute off the 02:00 GST `nightly_omnibus` cron.

### P1.7c — Marsad Score v1 (engine landed 2026-07-14)
- ✅ **Score engine** (`ingestion/src/lake/score-engine.ts`, pure math, synthetic-unit-tested): GCC-wide
  sector cohorts → winsorize 2/98 → percentile-rank → 5 factors (Value w/ **bank override**, Growth,
  Profitability, Momentum, Revisions=NULL) → composite 25/20/20/20/15 → universe percentile → rating
  bands + A±…D± grades. All owner methodology D-1…D-10 encoded.
- ✅ **Batch service + wiring** (`scores.ts` + `worker/.../score-batch.ts`): loads the score-eligible
  universe, **freshness-gate abort** on stale ratios (clean no-op on the empty universe), writes
  `scores`/`score_history`/`score_events` + a `COMPUTED.SCORE` lake object/name, diffs vs yesterday.
  Registered as the `score_batch` handler on the live 04:00 GST cron (`task`→`handler` alias).
- ⏳ **Runs once 7b lands** (needs a populated `key_ratios`; empty today ⇒ scores=0 no-op).
- ⏳ **Deferred**: earnings-verdict single-name recompute trigger; `estimates_agg` cron (both §7).

### P1.7d — Filings publish + dividends + earnings (publish path landed 2026-07-14)
- ✅ **`public.filings` publish path** (0037, `lake.fn_filing_project`) — **closed DEF-FILINGS-PUBLISH**.
  FILING.REF lake objects → `public.filings` (single-source PENDING publish rule, owner D-src-1;
  title→`filing_type` keyword classifier, venue-scoped, `security_id` NULL until detail-fetch). **86
  announcements now published** (was 0), auto-projecting on every new FILING.REF.
- ⏳ **Deferred**: full-text/`extracted_facts`/`ai_summary` (the one bounded LLM cost) and the
  dividends/earnings-actuals parse that rides on it (§7).

### P1.7e — Exchange-native + ownership + people (table landed 2026-07-14)
- ✅ **`company_people`** created (0038) — the `02-data-lake.md` "Missing entity" (board/management,
  independence, seat count) with public-read RLS + worker grants.
- ⏳ **Deferred**: ADX-native cross-check, `ownership_snapshots`, the board/people scrape, BHB egress (§7).

### P1.7 — Continuous enrichment (the researcher-agent operating architecture)
The live-data completion of P1.7b–e: a **researcher-agent fleet** (per-venue `DATA-*` ingest) + **derived-
refresh agents** (`nightly`/`score_batch`) that keep each data family current on the **existing** scheduler
(`ingest.schedules` → `enqueue_due_jobs` → `job_queue` → worker) — generalizing P1.7a's backfill+refresh
two-feed pattern to statements/ratios/filings/earnings/dividends/people/ownership. **No new scheduler/queue/
pipeline** — a researcher = a config row + a parse adapter; a refresh agent = a `q_maintenance` handler.
Full spec, per-family gap matrix, cadence table, and build sequence: **`docs/plans/p17-continuous-enrichment-researchers.md`**.
It is the consolidated **home** for the DEF-STMT-INGEST / DEF-SECTOR-DATA / DEF-VENUE-FILINGS /
DEF-FILING-FACTS / DEF-SCORE-EVENTS-TRIGGER / DEF-ESTIMATES-AGG / DEF-STMT-LLM-PDF cluster (§7).

### P2 — Reader core on real data (~4 wks)
Ledger, 812 stock pages, newswire, screener, heatmap, search, SEO — all from the live lake, CDN-cached anonymous browsing. (Master plan P2.)

### P3 — Newsroom pipeline (~3 wks)
VERIFIED object → classify → draft (cite VERIFIED only) → edit → rules → owner approval / TPL-01 auto-wire. (Master plan P3.)

### P4 — Marsad Desk (~3 wks)
Dashboard, approval review, agents console, lake browser, rules UI, data-desk ops, audit chain.

### P5 — Monetization (~3 wks)
Auth, Stripe, server-side entitlements/meters, dunning, transactional email, PDPL/ZATCA.

### P6 — Full surfaces (~5 wks)
Alerts/watchlists, Marsad AI + pgvector, IPO/dividends/earnings, analysts, Wire Brief, analytics.

### P7 — Hardening (~3 wks)
Backfill depth, ads, security/RLS pen pass, restore drills, runbooks.

---

## 6. Owner decisions & sign-offs (log)

- Scrape-only, delayed data; all 6 venues; cheapest run cost + swappable LLM; English only
- Trial card-required; free meters 2 reads / 3 scores / 5 AI answers
- $5 VPS approved (Hetzner CX23, ~$6.49/mo actual)
- TDWL sourcing: **hybrid** — Mubasher/Yahoo aggregators now, official-via-premium-proxy later if quality demands
- BHB: IPRoyal residential proxy (GCC geo)
- **D-src-4 · BHB price-history (2026-07-14):** accept BHB as the **coverage-gap venue** — no cheap ≥2y source (no aggregator, IP-blocked); build **no** 2y backfill, forward-accrue once quotes flow. Ledger: DEF-BHB-OHLCV (§7); detail: `07-lake-enrichment.md` §5 D-src-4.

### Owner action items (non-blocking)
- Enable `custom_access_token_hook` in Supabase Dashboard → Auth → Hooks (needed for P5 reader auth, not before)
- IPRoyal / proxy creds already set on the VPS; rotate anytime from the IPRoyal dashboard

---

## 7. Deferred / parked backlog

Work **consciously deferred, not dropped.** Each item carries a **trigger** (when to pick it up) and a
**home** (the doc/phase it belongs to). Nothing here is forgotten — it has either a scheduled home or a
forcing condition. Per the doc-sync convention above, add rows when parking work and delete them when the
work lands.

| ID | Item | Why deferred (not now) | Trigger to pick up | Home |
|---|---|---|---|---|
| **DEF-ADX-QUOTES** | Repoint ADX quotes (`ingest.sources` id=7) to the **direct apigateway board** `apigateway.adx.ae/adx/marketwatch/1.1/securityBoard/marketwatch` + capture its `fieldMap` | Works today via flaky `network_capture` discovery — a reliability upgrade, not a fix. Board-shape capture is **market-open-gated**. Needs an adapter change (`fetchAdxBoard` has no static-URL path). | **Next live ADX session (V-2 window)** — capture the board then; or fold into **P1.7e** (ADX-native, same adapter/pattern). ADX is not on Yahoo, so ADX quote reliability gates ADX's ongoing `ohlcv_daily` accrual. | `07 §P1.7a V-2`, `P1.7e` |
| **DEF-STMT-INGEST** | Live statement scrape → populate `public.financial_statements` (≥8Q) so the (built) ratio + Score path has real inputs: Mubasher `/financial-statements`+`/ratios` (TDWL/ADX), Yahoo `fundamentals-timeseries` (DFM/QE), MSX `.aspx`. Route each through the **shipped** `statement-normalizer`. | The normalizer + ratio + Score engines are built + tested; only the live venue adapters (and Yahoo egress) are missing. Blocked on live sessions / egress, not on code. | **P1.7b live** — next Yahoo-egress + market-data window | `07 §P1.7b`, `plan §3a` |
| **DEF-SECTOR-DATA** | Populate `securities.sector` (all 660 rows are `'unknown'` today) via a profile scrape (Mubasher `/profile`, ADX `overview.json`). | The §3.3 sector→valid-ratio map (D-1) + GCC-wide cohorts (D-2) are coded correct-by-design but have **no data to key on** — every name collapses to one `'unknown'` cohort + the full ratio set. | Before the Score is credibility-published (D-1/D-2 need real sectors) | `07 §3.3/§3.5`, `P1.7e-I` |
| **DEF-FILING-FACTS** | Filing **full_text** (PDF→EN) → `extracted_facts` typing → `ai_summary` (the one bounded LLM cost), then the dividends + earnings-actuals parse that rides on the facts (`public.dividends` w/ the confirm gate; `earnings_events` verdicts). | Needs the shared **PDF-extraction pipeline**; filings **lists** now publish (0037) but carry no facts yet. | **P1.7d F/G/H** — when the PDF-LLM pipeline stands up | `07 §1.1 F/G/H`, `P1.7d` |
| **DEF-SCORE-EVENTS-TRIGGER** | `earnings_events.verdict` set → single-name Score recompute into `q_maintenance` (updates the Revisions grade overnight). Engine already accepts a `securityIds` slice. | `earnings_events` is empty + Revisions ships NULL (D-8) — nothing to trigger on yet. | When 7d earnings actuals land | `07 §3.5`, `P1.7c` |
| **DEF-ESTIMATES-AGG** | `estimates_agg` cron @ 23:00 GST (30/90d revision Δ + breadth → `revisions_features` MV) feeding the Revisions factor. | No cheap consensus-estimate source (D-src-5); Revisions = NULL until resolved — harmless-while-empty, so not scheduled to avoid a false heartbeat. | When a consensus source is chosen (OQ-10) | `07 §3.6`, `P1.7c` |
| **DEF-STMT-LLM-PDF** | Implement `normalizeViaLlm` (the declared seam in `statement-normalizer.ts`) + the PDF-extraction pipeline for MSX/BHB statement depth + F full-text. | Shared LLM-extraction service (`01-ingestion.md §9`); the real effort sink, not buildable without the pipeline. | **P1.7d/e** — shared with DEF-FILING-FACTS | `plan §2`, `07 §P1.7b/e` |
| **DEF-VENUE-FILINGS** | Venue filings parser tuning — QE (q-disclosure URL), BHB (webapi/proxy), DFM (eFsah drift), MSX (RSS drift), TDWL (pin Mubasher-news) | Low-volume + parsers **drift** (ongoing maintenance, never a finish line); does not gate the Score | **P1.7d** filings upgrade / when a given venue's filings become reader-needed | `P1.7d`, `01-ingestion.md` |
| **DEF-ROTATE-N** | rotate-every-N keep-alive proxy pool (reuse tunnels instead of fresh-per-request) | Fetch is fast + stable now (pipeline 8, no deadlock); pure perf | **Only if** a full multi-venue backfill proves fetch-throughput-bound | ingestion `core/fetcher.ts` |
| **DEF-BHB-OHLCV** | BHB ≥2y daily OHLCV backfill adapter + seed (last price-history GAP; ADX=0033 Mubasher, MSX=0034 native, both done) | BHB is IP-blocked even via headless; the XLSX bulletin needs a working proxy path recon'd first | **When a BHB-reachable proxy exists** — then mirror the ADX/MSX adapter shape (provider discriminant + `withInjectedSymbols` branch) | `07 §P1.7a`, `07-lake-enrichment.md` price-history matrix |

**Cleared from this list — done + integrated 2026-07-14** (kept for one revision as an audit trail, then prune): **DEF-FILINGS-PUBLISH** (shipped as the `lake.fn_filing_project` single-source projection, 0037 — 86 filings published); plus the P1.7b/c/e code spine landed same day (key_ratios `[NEW COL]` 0036 + sector-aware ratios, the statement-normalizer, the Marsad Score engine + `score_batch`/`nightly` handlers, `company_people` 0038). Earlier: gzip content-encoding decode; concurrent + incremental OHLCV backfill; DB pool starvation (`max` 5→20); q_pipeline batch-drain; Supabase pooler-cap sizing; **sweep-dedup** (migration 0030); handler **tx-threading** deadlock; **q_dispatch** poison-heartbeat.

# Marsad — Build Status & Roadmap

_Last updated: 2026-07-15. Living document — the source of truth for what's shipped, what's live, and what's next._

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
| **TDWL** (Saudi) | ✅ **Mubasher** aggregator (JSON API, 387 tickers) + ✅ **Yahoo** `.SR` (cross-check, dormant) | ⚠️ Akamai-blocked; **deactivated** (`20260715150100`, DEF-VENUE-FILINGS) | Official saudiexchange.sa is Akamai IP-blocked for all our IPs; Mubasher + Yahoo are the paths |
| **DFM** (Dubai) | ✅ official + ✅ **Yahoo** `.AE` (cross-check, dormant) | ✅ 200 | direct from VPS |
| **QE** (Qatar) | ✅ official + ✅ **Yahoo** `.QA` (cross-check, dormant) | ⚠️ URL 404; **deactivated** (`20260715150100`, DEF-VENUE-FILINGS) | direct from VPS |
| **ADX** (Abu Dhabi) | ✅ official (browser) | ⚠️ endpoint undiscovered | direct from VPS; Yahoo doesn't cover |
| **MSX** (Muscat) | ✅ official | ✅ 200 | direct from VPS; Yahoo doesn't cover |
| **BHB** (Bahrain) | ✅ **webapi board** `GetTabularData?storedProcdure=Quotes` — **LIVE, direct egress** (`20260715100000` + `20260715150100`) | ⚠️ filings 0/138 ok; **deactivated** (`20260715150100`, DEF-VENUE-FILINGS) | webapi WAF gate is gone → **direct** VPS egress (proxy off, bearer rotated, replay-fatal `provider` key stripped — `20260715150100`); live board = 41 stocks incl. daily OHLCV |

**Quotes are single-source live-refresh (Yahoo quote 2nd-source retired 2026-07-15)**: Yahoo per-symbol quotes were the TDWL/DFM/QE 2nd cross-check source, but the native boards + the `QUOTE.LAST` in-place refresh (`cross-check.ts`) now advance single-source quotes every poll, so the Yahoo **quote** twins are **retired** (`20260715093000`; 081318 had retired DFM/QE but missed the TDWL twin, which kept polling Yahoo through the proxy ~282×/24h). Verified redundant: the twins carried **0** tickers the native boards lack (TDWL 268⊂414, DFM 52⊂473, QE 49⊂146). Yahoo is retained **only** for `ohlcv_backfill` (provider-scoped), itself paused (§7 DEF-DEEP-BACKFILL-ROLLOUT, switched to Mubasher in 0042). **Net: proxy egress (Geonode since #21) is backfill-only and itself paused — BHB quotes went DIRECT (WAF gone, `20260715150100`), so nothing polls through the proxy day-to-day.**

---

## 4. Known gaps / in-flight tuning

1. **Provider-aware routing** — runtime resolves adapter by `(venue, data_type)`; needs to also key on `endpoint_config.provider` (to run Yahoo alongside the primary) + an `ohlcv_backfill` branch. Gates Yahoo activation.
2. **Per-venue endpoint fixes**: QE filings 404, ADX filings endpoint discovery, BHB filings URL (403 even via proxy), TDWL filings (only quotes moved to Mubasher).
   - **Parser health (2026-07-15, root-caused):** Four sources stage **0 rows** — but NOT parser drift. Three are **fetch failures**: TDWL filings (id2), QE filings (id11), BHB filings (id17) have no pinned `endpoint_config.urlTemplate`, so `browser.bootstrap()` throws `action discovery found no URL` (`ingestion/src/core/browser.ts:166-170`); **0/287 fetches ok, parser never runs** (no snapshot, no `parse_runs`). One is **wrong-shape**: BHB quotes (id16) has no JSON URL pinned → falls back to `entry_url` = the SPA-shell HTML → JSON parser (`adapters/bhb/quotes.ts:90`) gets HTML → 0 rows. Working siblings (DFM/ADX/MSX filings, TDWL quotes via Mubasher) all have a **pinned `urlTemplate` + golden fixture**; these four never had the feed URL captured. **Fix = capture + pin the real `urlTemplate` + a golden fixture per venue** (one live headless capture each; BHB also needs its proxy leg checked — intermittent `402` tunneling). Adds additive coverage, not a bandwidth cut. **BHB quotes (id16) is now LIVE** — re-pointed to the real webapi board `GetTabularData?storedProcdure=Quotes` + Bearer (`20260715100000`), parser handles the real key shape, worker deployed, 14/21 fetches ok in the last 24h; the WAF gate is gone so egress is **direct** (proxy off, bearer rotated) and the replay-fatal `provider='bhb_webapi'` key is stripped (`20260715150100` — with it, `tasksForProvider` returns `[]` for quotes and a fresh replay silently kills the board). **TDWL (id2) / QE (id11) / BHB (id17) filings are now ALL deactivated** (sources + schedules, `20260715150100`) — they burned 176+176+138 fetches/day at 0 ok (QE ~27s, BHB ~17s per attempt); they re-activate as the last step of the turnkey fix. Parked under DEF-VENUE-FILINGS (§7).
3. **Downstream verification**: confirm snapshots → parse → staging → cross-check → VERIFIED lake objects (the second half of the pipeline).
4. **Live quote validation**: quotes are session-gated → validate when GCC markets open (Sun–Thu ~10:00 GST). ✅ **intraday-freeze fixed 2026-07-15** — `QUOTE.LAST` is day-keyed + every venue feed is single-source, and cross-check's `applyPending` left a live single-source object untouched (right for static facts), so each security's quote **froze at the day's first print** (max `revision`=1, ~1 intraday point/security/day, all venues). Fix: treat `QUOTE.LAST` as a live-latest single-source-authoritative feed — refresh the live object **in place** with the newest staged print each poll (fires `objects_quote_project_upd`) and consume its staging each pass so `primaryOf` can't keep re-selecting the oldest row. `ingestion/src/lake/cross-check.ts` (`LIVE_LATEST_TYPES`, `refreshLiveValue`, `newestCandidate`). ✅ **All 5 venues live intraday 2026-07-15** — with the freeze fixed, the remaining venues that weren't flowing were repointed to their real native boards: **DFM** = POST `marketwatch.dfm.ae/dapi/fetch` (the `api2.dfm.ae/mw/v1` route was dead); **QE** = POST `www.qe.com.qa/wp/mw_app/mw.php` body `f=MarketWatch` (the `/pps/qse_files/MarketWatch.txt` path was a **stale static file** — Last-Modified Oct 2025, byte-identical intraday). Yahoo per-symbol quote fallbacks deactivated (blew the `query1.finance.yahoo.com` 300/day host budget ~30 min into each session). Two fetcher fixes en route: **(a)** `endpoint_config.headers` must use **lowercase** keys or undici sends duplicate headers (DFM 400'd on a dup `user-agent`); **(b)** a shared undici `Agent` with a **30s connect ceiling** (default 10s was too tight for QE's ~15s TLS handshake). `EndpointConfig` gained `body`+`timeoutMs`; DFM/QE adapters honor `cfg.method` for POST boards. Verified live: ADX 4.5 / MSX 5.0 / DFM·TDWL ~2.8 / QE 1.1 intraday points/security/day (was 1.00 = frozen everywhere). See `memory/marsad-live-quote-boards.md`. ✅ **TDWL `as_of` timezone bug fixed 2026-07-15** — *separate from the freeze*: TDWL quotes advance fine (~2.8 pts/day) but every `as_of` was **backdated exactly 3h**. `parseMubasherTimestampToUtc` subtracted a 3h AST offset, but the Mubasher `/stocks/prices` feed prints **UTC** (owner-confirmed ~15-min delay; a mid-session Aramco print `10:59:55` at 14:16 Riyadh reconciles to now−15min only when read as UTC — under AST it implied trades ~3h before the open). Dropped the offset (parse digits verbatim), bumped parser `v1→v2` (replay-eligible), added a regression test asserting hour-in==hour-out. `adapters/mubasher/tdwl-quotes.ts`. Self-heals on the next poll after deploy — `quotes_latest` is overwritten each cycle, so no data backfill needed.

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
  ≥2y daily **close-only**, intraday ticks filtered); **BHB = native webapi
  `DataExportCompanyProfile` JSON** (`20260715101500`, provider `bhb_webapi`, `adapters/bhb/ohlcv.ts` —
  ≥2y **EOD-CLOSE-ONLY** per owner, sticky-proxy egress). All seeded `active=false` pending the
  post-deploy activation flip. **All 6 venues now have a price-history backfill source** (DEF-BHB-OHLCV
  closed — a BHB-reachable sticky proxy exists, its documented trigger).
  **"one-time" is now enforced (migration 0041):** the daily-cadence backfill schedule used to re-fetch
  the FULL listed universe every run (the injectors inject all `status='listed'` tickers); a sticky
  `securities.ohlcv_backfilled_at` flag — stamped by the objectifier the moment a security's backfill
  bars land — makes `listedTickersForVenue` inject only un-backfilled securities, so once a venue is
  fully seeded the injected list is empty and `runTask` skips the fetch (graceful stop; EOD accrual +
  intraday quotes carry the lake forward). A one-shot `range=2y` GET returns the provider's full feasible
  window, so "backfilled once" = "as deep as the provider offers" — no day-count threshold needed. Live
  after apply: QE 49/49 stamped → 0 to re-fetch; TDWL 374/387 (finishing); ADX/MSX/BHB still 0 (their
  backfill sources have not produced — separate issue).
- **EOD accrual (ongoing, +1 bar/security/trading-day):** rolls the intraday `quotes_latest` ticks
  into that day's O/H/L/C/volume **at close** (cadence is DAILY, not the ~10-min quote cadence).
  ⏳ **wired but NOT YET VALIDATED** — migration 0028 (`accrue_ohlcv_from_quotes` + `ohlcv_accrual`
  pg_cron @ 18:00 UTC) is live but has never run against a real session. **Must prove:** after ≥1 GCC
  session → 18:00 roll-up → confirm exactly one correct new bar/security lands. **Don't skip — the
  reader is only right once the daily bar keeps appearing, not just once history is seeded.**
  (`07-lake-enrichment.md` §P1.7a V-1/V-2.)
- **Throughput follow-ups before the full-universe backfill:** sweep-dedup (`crosscheck_sweep`
  re-enqueues duplicates → queue diverges, migration 0030) + sweep **venue-fairness** (0039 — the
  `by natural_key` order starved every venue but the alphabetically-first; TDWL sat at 0-swept until
  fixed with round-robin) + **OHLCV bulk-objectify** (0040 — the price backfill is ~95% of the
  q_pipeline volume and single-source-forever, so routing it through the ~8-round-trip cross_check
  pinned drain at ~325/min against a 500/min fill from a Mumbai DB / EU worker at ~140ms RTT; replaced
  with a set-based `ops.objectify_ohlcv_backfill` pg_cron job that lands ~10k bars/tick in-DB and lets
  the 0028/0032 triggers fire in-process. Drained DFM+QE to full and TDWL 0→94 secs in minutes) +
  handler **tx-threading** (each handler holds a `runAsAgent` tx *and* nests pool connections → deadlock
  caps concurrency). **Consumer throughput now bounded, not open:** q_pipeline carries only genuine
  multi-source cross_check (quotes-vs-Yahoo, filings, dividends) at low volume; the price flood is off
  it. QE `.QA` history shallow (~40 bars) → needs QE `MarketWatch.txt` for Score depth (≥126). Detail
  in `memory/marsad-next-session.md`.
- **Post-backfill no-op reclaim (0045 / `20260715080537`, 2026-07-15):** once the deep drain completed, two pg_cron lanes
  idled *hot*. `crosscheck_sweep` fired **every minute** re-sweeping ~1.1k structurally single-source
  staging keys — `QUOTE.LAST`/`FILING.REF`/stranded eod_bulletin `OHLCV.CLOSE` that can never satisfy the
  2-source rule — for ~5.4k no-op `parse_runs`/day; `ohlcv_bulk_objectify` fired every minute against an
  empty backlog for ~0.45k more. Fixed: (1) `enqueue_crosscheck_sweep` now **parks** a key once its oldest
  unconsumed evidence is >6h old and it still has <2 distinct sources — self-healing (a 2nd source
  re-qualifies it on the next tick, no state), and the tick is throttled **1→5 min** (== the per-key
  cooldown); (2) `objectify_ohlcv_backfill` **self-gates** — returns before opening a `parse_run` when no
  backfill bar is pending, auto-waking when MSX/BHB/remaining-ADX staging lands. Verified live: objectify
  returns 0 with no new `parse_run`; sweep cadence now `*/5`. No data dropped — parking only stops
  re-sweeping. Note this does **not** implement DEF-DEEP-BACKFILL-ROLLOUT item (3) (lane reservation).

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
- **D-src-4 · BHB price-history (2026-07-14; RESOLVED 2026-07-15):** originally accepted BHB as the **coverage-gap venue** (no aggregator, IP-blocked) pending a BHB-reachable proxy. That trigger fired: a **sticky IPRoyal session** reaches BHB's webapi `DataExportCompanyProfile` per-security **EOD-close** export (proven live 2026-07-15, `scratchpad/BHB-API-CONTRACT.md`). Built the backfill adapter (`adapters/bhb/ohlcv.ts`, provider `bhb_webapi`, seed `20260715101500`, `active=false`) mirroring ADX/MSX. **EOD CLOSE ONLY** (open/high/low/volume null — owner requirement). DEF-BHB-OHLCV closed. Detail: `07-lake-enrichment.md` §5 D-src-4.

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
| ~~**DEF-ADX-QUOTES**~~ ✅ **DONE 2026-07-15** (PR #10) — ADX quotes repointed to the direct apigateway board via the cookie-seated Chromium context; `extract='direct'` + `urlTemplate` (0043) + the exact gateway headers `adx-gateway-apikey`/`channel-id`/`referer` (0044); `mapQuote` falls back to snapshot fetch time when a board row has no `asOf`. ADX quotes flow end-to-end. | — | — | `adapters/adx/quotes.ts`, `07 §P1.7a` |
| **DEF-ADX-NATIVE-DATA** | Build the ADX **filings + financial-statements** ingestion: per-company `news` (efid/cdc) → filing/financial-statement/annual-report **PDFs** → download via the WAF-bypassed browser context → store → **extract IS/BS/CFS reusing the Tadawul document→extract pipeline** (not just the raw balance-sheet JSON); plus `board-members` + `listedCompanyShareholderInfo` for `company_people`/`ownership_snapshots`. Full recipe + endpoint table + PDF-download proof already written. | Endpoints discovered + PDF download proven live (`2POINTZERO` → `application/pdf`), but the build is its own effort — reuses the shared PDF-extraction pipeline (shared with `DEF-FILING-FACTS`/`DEF-STMT-LLM-PDF`), which is the real sink. | **P1.7d/e** — when the PDF-LLM extraction pipeline stands up (shared with DEF-FILING-FACTS) | `docs/architecture/adx-browser-bypass.md` §5, `07 §P1.7e`, `P1.7d` |
| **DEF-STMT-INGEST** | Live statement scrape → populate `public.financial_statements` (≥8Q) so the (built) ratio + Score path has real inputs: Mubasher `/financial-statements`+`/ratios` (TDWL/ADX), Yahoo `fundamentals-timeseries` (DFM/QE), MSX `.aspx`. Route each through the **shipped** `statement-normalizer`. | The normalizer + ratio + Score engines are built + tested; only the live venue adapters (and Yahoo egress) are missing. Blocked on live sessions / egress, not on code. **TDWL slice is NOT Yahoo-blocked** — it uses the Mubasher `/financial-statements`+`/ratios` path (5 statements for 2010/4330/4350 already landed 2026-07-14/15 via the external Tadawul scraper, proving the source). The gap for TDWL is pure wiring: `financials` is a declared `DataType` but has **no** `ingest.sources` seed, **no** `DATA_TYPE_TO_HANDLER` entry, and **no** Mubasher financials `TaskSpec`/handler — so nothing enqueues a per-security financials fetch. | **TDWL slice: buildable now** (recommended next pickup — wire the Mubasher financials adapter→source→schedule; no egress dependency). DFM/QE slice still **P1.7b live** — next Yahoo-egress window. | `07 §P1.7b`, `plan §3a` |
| **DEF-SECTOR-DATA** | Populate `securities.sector` (all 660 rows are `'unknown'` today) via a profile scrape (Mubasher `/profile`, ADX `overview.json`). | The §3.3 sector→valid-ratio map (D-1) + GCC-wide cohorts (D-2) are coded correct-by-design but have **no data to key on** — every name collapses to one `'unknown'` cohort + the full ratio set. | Before the Score is credibility-published (D-1/D-2 need real sectors) | `07 §3.3/§3.5`, `P1.7e-I` |
| **DEF-FILING-FACTS** | Filing **full_text** (PDF→EN) → `extracted_facts` typing → `ai_summary` (the one bounded LLM cost), then the dividends + earnings-actuals parse that rides on the facts (`public.dividends` w/ the confirm gate; `earnings_events` verdicts). | Needs the shared **PDF-extraction pipeline**; filings **lists** now publish (0037) but carry no facts yet. | **P1.7d F/G/H** — when the PDF-LLM pipeline stands up | `07 §1.1 F/G/H`, `P1.7d` |
| **DEF-SCORE-EVENTS-TRIGGER** | `earnings_events.verdict` set → single-name Score recompute into `q_maintenance` (updates the Revisions grade overnight). Engine already accepts a `securityIds` slice. | `earnings_events` is empty + Revisions ships NULL (D-8) — nothing to trigger on yet. | When 7d earnings actuals land | `07 §3.5`, `P1.7c` |
| **DEF-ESTIMATES-AGG** | `estimates_agg` cron @ 23:00 GST (30/90d revision Δ + breadth → `revisions_features` MV) feeding the Revisions factor. | No cheap consensus-estimate source (D-src-5); Revisions = NULL until resolved — harmless-while-empty, so not scheduled to avoid a false heartbeat. | When a consensus source is chosen (OQ-10) | `07 §3.6`, `P1.7c` |
| **DEF-STMT-LLM-PDF** | Implement `normalizeViaLlm` (the declared seam in `statement-normalizer.ts`) + the PDF-extraction pipeline for MSX/BHB statement depth + F full-text. | Shared LLM-extraction service (`01-ingestion.md §9`); the real effort sink, not buildable without the pipeline. | **P1.7d/e** — shared with DEF-FILING-FACTS | `plan §2`, `07 §P1.7b/e` |
| **DEF-VENUE-FILINGS** | Venue filings parser tuning — QE (q-disclosure URL), BHB (webapi/proxy), DFM (eFsah drift), MSX (RSS drift), TDWL (pin Mubasher-news). | Low-volume + parsers **drift** (ongoing maintenance, never a finish line); does not gate the Score. **Root-caused 2026-07-15:** id2/id11/id17 fail because `urlTemplate` was never pinned → `browser.bootstrap()` throws `action discovery found no URL` (`core/browser.ts:166-170`), 0/287 ok, parser never runs (id16 BHB quotes had the sibling SPA-shell-fallback disease — FIXED + live, see trigger cell). Not selector drift. | **P1.7d** filings upgrade / when reader-needed. **id2/id11/id17 sources + schedules are OFF (`20260715150100`)** — they burned 176+176+138 fetches/day at 0 ok; flipping `active=true` back is the LAST step of the fix. **Turnkey fix per venue:** capture the real feed XHR once via VPS headless (`page.on('response')`) → pin `endpoint_config.urlTemplate` (+ `filingFieldMap` if non-standard) → mirror `sources.seed.ts` → add golden fixture → re-`active=true`. TDWL `saudiexchange.sa` issuer-news; QE `qe.com.qa/q-disclosure` portlet XHR; BHB filings urlTemplate already pinned — drop `actionDiscovery` so `fetchFilings` uses it directly (golden `fixtures/bhb/filings-live.json` exists). BHB quotes (id16) is DONE — live + direct, provider key stripped (`20260715150100`). | `P1.7d`, `01-ingestion.md` |
| **DEF-EOD-BULLETIN** | Venue EOD-bulletin feeds: build the missing `eodBulletin` TaskSpecs for DFM/QE/MSX (`adapters/{dfm,qe,msx}/index.ts` have no slot) and repoint TDWL off Akamai-blocked `saudiexchange.sa`; those 4 sources + schedules deactivated meanwhile (`20260715150100`). ADX + BHB eod_bulletin STAY active (real TaskSpecs, close-gated by `eodCloseGate`). | DFM/QE/MSX rows had NO adapter TaskSpec, so the hourly `eod_sweep` job reported `ok` while dispatching **zero** fetches — 0 `fetch_log` rows EVER for any eod_bulletin source, a fake-fresh signal; TDWL's host is unfetchable from every IP we have. Daily bars accrue from the quote boards + EOD accrual (0028) meanwhile, so nothing downstream starves. | When the official close bulletin is wanted as the OHLCV 2nd cross-check source (P1.7a exit criterion) — or any eod parser work resumes | `adapters/{dfm,qe,msx}`, `worker/src/handlers/eod-sweep.ts`, `01-ingestion.md` |
| **DEF-ROTATE-N** | rotate-every-N keep-alive proxy pool (reuse tunnels instead of fresh-per-request) | Fetch is fast + stable now (pipeline 8, no deadlock); pure perf | **Only if** a full multi-venue backfill proves fetch-throughput-bound | ingestion `core/fetcher.ts` |
| ~~**DEF-BHB-OHLCV**~~ ✅ **DONE 2026-07-15** — trigger fired (a sticky IPRoyal session reaches BHB's webapi `DataExportCompanyProfile` per-security EOD-close export, proven live `scratchpad/BHB-API-CONTRACT.md`). Built `adapters/bhb/ohlcv.ts` (provider `bhb_webapi`, close-only per owner) + `runtime.ts` wiring (`AltProvider`/`providerOf`/`tasksForProvider`/`withBhbWebapiSymbols`/`withInjectedSymbols`) + seed `20260715101500` (source+schedule `active=false`; 41-symbol securities seed guarded `on conflict do nothing`). Mirrors the ADX/MSX adapter shape. Unit-tested (18 cases green), tsc clean. **Activation is a deliberate later flip** (a 41-symbol deep drain over the sticky proxy is not auto-run). | — | — | `adapters/bhb/ohlcv.ts`, `20260715101500`, `07 §P1.7a` |
| ~~**DEF-WORKER-DEPLOY-SECRETS**~~ ✅ **DONE 2026-07-14** — `VPS_HOST`/`VPS_SSH_KEY` secrets set; CI `worker-deploy` now deploys on `worker/**`+`ingestion/**` merges (verified: PR #6 auto-deployed). | — | — | `worker-deploy.yml` |
| **DEF-DEEP-BACKFILL-ROLLOUT** | Finish the deep (20-33y) OHLCV backfill for all TDWL/DFM/QE (and re-do the 12 ADX names + resume ADX). Source is switched to Mubasher (0042, gives full history — proven: ~8 secs landed deep, TDWL→1993/DFM→2000/QE→2006) but the full re-drain of ~3-4M bars is **PAUSED**: staging ingests only ~750 bars/min/venue (RTT-bound, same wall as cross_check) → ~a day, and a 25-security chunk of *deep* data is still a marathon that hogs all 4 poller lanes into market hours. **4-point plan:** (1) batch the staging INSERTs (kill the ~750/min RTT ceiling — mirror the bulk-objectify pattern); (2) chunk by BAR count, not security count, so a deep security isn't a marathon; (3) reserve ≥2 poller lanes for quotes/filings so backfill never starves live data; (4) run off-hours. **Paused state to reverse when picking up:** Mubasher `ohlcv_backfill` schedules `active=false`; all TDWL/DFM/QE + the 12 ADX securities force-stamped `ohlcv_backfilled_at` (so the coverage guard idles) — several ADX names (ADCB/ADIB/ALDAR/AMR) are stamped-but-still-stale and need re-clearing (14 ADX names sit unstamped live, deliberately NOT re-stamped); Yahoo `ohlcv_backfill` for TDWL/DFM/QE is deactivated (0042), so those venues have NO active backfill until this resumes (EOD accrual 0028 still adds the daily bar). **The pause is now COMMITTED as SQL (`20260715150100`)** — every `ohlcv_backfill` schedule off + the TDWL/DFM/QE stamp reproduced, so a fresh migration replay can no longer resurrect the multi-million-bar drain. **`objectify_ohlcv_backfill` now self-gates (0045)** — it sits dormant (no `parse_run` churn) while paused and auto-wakes the instant this backfill resumes and staging lands, so resuming needs no cron change. | **Off-hours block after the staging-throughput fix** (item 1 is the gate — without it the deep drain is too slow to matter) | `runtime.ts` (`BACKFILL_CHUNK_SIZE`, staging emitter), `ingest-poller.ts` (lane reservation), `07 §P1.7a` |

**Cleared from this list — done + integrated 2026-07-14** (kept for one revision as an audit trail, then prune): **DEF-FILINGS-PUBLISH** (shipped as the `lake.fn_filing_project` single-source projection, 0037 — 86 filings published); plus the P1.7b/c/e code spine landed same day (key_ratios `[NEW COL]` 0036 + sector-aware ratios, the statement-normalizer, the Marsad Score engine + `score_batch`/`nightly` handlers, `company_people` 0038). **sweep venue-starvation** (migration 0039 — `crosscheck_sweep` ordered `by natural_key`, so the alphabetically-first venue monopolised every 500-key window and TDWL, sorting last + ingested last + largest at 125k keys, was never enqueued: swept=0/consumed=0; replaced with fair round-robin across venues, oldest-evidence-first within venue); **OHLCV bulk-objectify** (migration 0040 — bypass per-key cross_check for single-source `ohlcv_backfill` OHLCV.CLOSE with a set-based `ops.objectify_ohlcv_backfill` pg_cron job + a matching sweep exclusion; ~325/min RTT-bound drain → ~10k bars/tick in-DB; DFM/QE completed + TDWL 0→94 secs / 2yr history). **deep OHLCV history via Mubasher** (migration 0042 — TDWL/DFM/QE backfill switched Yahoo 2y → Mubasher CSV, which serves full listing history: TDWL to 1993 ~33y, DFM to 2000 ~26y, QE ~20y; same plain-HTTP source already used for ADX, no new provider code/legal posture; TradingView evaluated + rejected — beats Yahoo depth but ToS + exchange licences forbid automated extraction/redistribution for a commercial publisher). **ingest-poller continuous lanes + chunked backfill** (a deep backfill runTask is a marathon; the old `drainOnce` Promise.all barrier let one such job stall the whole poller — 173 due jobs frozen 66 min behind one ADX backfill — and outlive the 15-min stuck reaper; rewrote the poller to N independent lanes and capped `listedTickersForVenue` to `BACKFILL_CHUNK_SIZE=25` with a 3-min self-chained follow-up, so backfills run as short non-blocking chunks that churn fast and never freeze quotes/filings). Earlier: gzip content-encoding decode; concurrent + incremental OHLCV backfill; DB pool starvation (`max` 5→20); q_pipeline batch-drain; Supabase pooler-cap sizing; **sweep-dedup** (migration 0030); handler **tx-threading** deadlock; **q_dispatch** poison-heartbeat.

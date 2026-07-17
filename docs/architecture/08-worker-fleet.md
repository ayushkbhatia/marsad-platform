# 08 — Worker & Scraper Fleet: job-map, guardrails, and onboarding

> Operating manual for every autonomous worker/scraper/agent Marsad runs. Answers three questions the
> owner must always be able to answer for any running process: **what is it working towards, how does it
> know where to look and what to fetch, and when does it stop?** No worker should ever be a "treasure
> hunt." Every worker is onboarded with the four guardrails in §4 before it is allowed to run.
>
> Status: v1, 2026-07-16. Written after a proxy-bandwidth incident (§5) — 9 GB/night through the metered
> residential proxy, root-caused to two browser researchers running full-page loads every 15–20 min.

---

## 1. The fleet at a glance — two classes, very different cost

Marsad runs autonomous work in two structurally different ways. Confusing them is how bandwidth blows up.

| Class | Where | Transport | Proxy? | Cost profile | Examples |
|---|---|---|---|---|---|
| **A. Ingest pollers** (config-driven) | `marsad-worker` (VPS, always-on Node) claiming `ingest.job_queue` | plain HTTP (undici) or a Playwright request-context for WAF venues — **fetches the pinned data endpoint only, never renders a full page** | **No** (direct VPS egress) day-to-day | **~free** — a board JSON / RSS / webapi call is KBs; dedup skips unchanged content | quote_poll, filings_poll, filings_detail_poll, eod_sweep |
| **B. Browser researchers** (script-driven) | dedicated `systemd` timers on the VPS running headed Chromium under `xvfb` | **full page navigation** (`page.goto`) — loads the whole SPA (JS + CSS + images + fonts) then scrapes the DOM | **Yes** (Geonode residential — required to bypass Akamai on `saudiexchange.sa`) | **expensive** — a heavy WebSphere/SPA page is 3–15 MB; **through a metered proxy**; ×N companies ×frequency | tadawul-researcher (XBRL financials), tadawul-gapfill (fsPdf + LLM) |

**The golden rule: Class-B (full-page browser + proxy) is the most expensive thing we do. It must run as
rarely as the data changes, fetch as little as possible, and never re-load a page whose output it already
owns.** Class-A is cheap and can run often. Never let a Class-B worker inherit a Class-A cadence.

Both classes are also governed by the **fleet productivity guard** (§3.1) — a worker that produces no
incremental lake benefit backs off automatically. But the guard only covers the cadence-driven ingest
pollers (Class A); Class-B researchers are governed by their own systemd cadence + the guardrails in §4.

---

## 2. Job-description & workflow map (every active worker)

Each entry answers the owner's four questions: **(1) how often, (2) what exactly it fetches and how,
(3) when it stops, (4) its config surface.**

### A. Ingest pollers — `marsad-worker`, claiming `ingest.job_queue`

The scheduler (`ingest.enqueue_due_jobs`, pg_cron `ingest_tick` `*/5`) enqueues one job per due
`ingest.schedules` row; the worker's continuous-lane poller claims it and runs the handler for the
source's `data_type`. **Config is data** — every URL/cadence/flag lives in `ingest.sources` +
`ingest.schedules`, never hardcoded. All are direct-egress (no proxy).

| Worker (handler) | Targets & data-point | How it fetches | Cadence (base → effective) | Stop / rest | Config |
|---|---|---|---|---|---|
| **quote_poll** | Each venue's full quote board → `QUOTE.LAST` / `INDEX.LEVEL` | one GET/POST of the **pinned native board** (`endpoint_config.urlTemplate`); BHB via webapi + dynamic Bearer | 10 min, **session-only** | off-session (calendar gate); backs off to ≤20 min when a board is unchanged (guard cap 2×) | `ingest.sources` (TDWL/DFM/ADX/QE/MSX/BHB quotes) |
| **filings_poll** | Venue disclosures list → new `external_id` → `FILING.REF` | one GET of the **pinned list feed** (eFsah JSON / ADX apigateway / MSX RSS / BHB webapi) | 5 min | backs off 5→40 min when the list is unchanged (guard cap 8×); wakes on any new filing | `ingest.sources` filings_list |
| **filings_detail_poll** | Pending `seen_items` → download the announcement PDF → `filings` bucket + `public.filings` + `ops.filing_extract_queue` | drains a chunk of pending items; downloads the ref's `pdf_url` (direct CDN) | event-driven (priority-1 wake-up from filings_poll) + 60-min backstop; backstop backs off to 8 h when nothing pending | terminal `seen_items` state (`fetched`/`nopdf`/`failed`); self-chains only while a full chunk drains | `ingest.sources` filing_detail (MSX active; DFM/BHB list-only; TDWL/QE list off) |
| **eod_sweep** | Venue EOD bulletin → `OHLCV.CLOSE` | close-gate opens at close+30, then fetches the bulletin | 60 min, `backoff_exempt` | **close-gate** (fetches once/day/venue at close+30; otherwise returns without a fetch) | `ingest.sources` eod_bulletin (ADX/BHB active) |
| **quote_poll (ohlcv_backfill)** | ≥2y daily bars per un-backfilled security | per-symbol GET of the provider (Yahoo/Mubasher/MSX/BHB) | daily, `backoff_exempt`; **currently paused** | **coverage guard** — stops the moment every listed security is `ohlcv_backfilled_at`; self-chains chunks of 25 | `ingest.sources` ohlcv_backfill (all `active=false`, DEF-DEEP-BACKFILL-ROLLOUT) |

pgmq-consumer handlers on the same worker (event/cron-driven, not proxy, cheap): **cross_check**
(2-source → VERIFIED lake.objects), **key_ratios_recompute** / **nightly**, **score_batch**,
**ohlcv_accrual**. pg_cron SQL jobs (in Supabase): `crosscheck_sweep`, `ohlcv_bulk_objectify`,
`feed_status_sweep`, `queue_reaper`, `heartbeat_sentinel`, retention/partition/billing housekeeping.

### B. Browser researchers — dedicated `systemd` timers (the expensive class)

| Worker | Targets & data-point | How it fetches | Cadence | Stop / rest | Config |
|---|---|---|---|---|---|
| **tadawul-researcher** (`marsad-researcher.timer` → `researcher-cron.sh` → `tadawul-researcher.mjs`) | TDWL financial statements: per company, click "Financial Statements & Reports" → scrape `XBRL_DOCS/*.html` + `fsPdf/*.pdf` → parse XBRL → `financial_statements` + archive PDFs to `filings` bucket | **headed Chromium through the Geonode proxy**; per company: `goto` market-watch SPA → click company anchor → click FS control → in-page `fetch` the XBRL/PDF | **6 h** (was 15 min — §5); walks the universe in chunks of 16, 2 concurrent sticky-IP browsers | `RUN_BUDGET_MS` (~680 s) + `PDF_ARCHIVE_MAX` (20/run) + chunk cursor; **incremental** — skips already-`owned` storage keys | env: `CHUNK_SIZE/CONCURRENCY/RUN_BUDGET_MS/PDF_ARCHIVE_MAX`; state `.researcher-chunk` |
| **tadawul-gapfill** (`marsad-gapfill.timer` → `gapfill-cron.sh` → `tadawul-gapfill.mjs`) | TDWL **pre-XBRL** statements: scrape `fsPdf/*.pdf` → LLM-extract (Claude Code) → `financial_statements` | same headed-Chromium-through-proxy pattern; downloads PDFs | **6 h** (was 20 min — §5) | shares the `.tadawul-scrape.lock` with the researcher (never concurrent); incremental skip-owned | env similar; state cursor |
| **dfm-backfill** (`dfm-backfill-cron.sh` → `dfm-backfill.mjs`) — **Class-A, the §7 principle in practice** | DFM statements (PDF-only, no XBRL): per company, GET the eFsah `financial_reports` list → download the PDF from `feeds.dfm.ae/documents` → LLM-extract (Claude Code, $0 seat) → `financial_statements` + catalogue in `filings` bucket | **plain `fetch` — NO browser, NO proxy, NO Xvfb** (DFM is direct-fetchable, no Akamai gate). This is a script-driven scraper but **not Class-B** — it fetches the data endpoint, not the page (§7 rule #2). | **backfill:** frequent until covered (coverage-gate self-limits spend); **steady-state:** `DFM_WINDOW_GATE=1` → filing-window cadence | `FSPDF_MAX` (LLM calls/run) + chunk cursor `.dfm-backfill-chunk`; **incremental** — skips periods already in `financial_statements`; own `.dfm-scrape.lock` | env: `CHUNK_SIZE/FSPDF_MAX/EFSAH_TAKE/CLAUDE_MODEL/DFM_WINDOW_GATE`; state `.dfm-backfill-chunk` |
| **adx-gapfill** (`marsad-adx-gapfill.timer` → `adx-gapfill-cron.sh` → `adx-gapfill.mjs`) | ADX financial statements (no XBRL → LLM-only): per company GET the `efid` disclosure feed → download `Financial Report` PDFs → LLM-extract → `financial_statements` | **the light exception to the Class-B rule — NO proxy, NO xvfb, headless.** Bootstraps the Akamai cookies **once** (nav `www.adx.ae`), then `ctx.request.get`s the apigateway JSON feed + PDF bytes directly (no per-company SPA render). ~1-3 MB/PDF, unmetered datacenter egress | **6 h**, reporting-window-gated (`WINDOW_DAYS=60`/`ANNUAL_WINDOW_DAYS=120`, UAE calendar) | own `.adx-scrape.lock`; `ADX_PDF_MAX` (6/run) LLM budget + chunk cursor `.adx-gapfill-chunk`; extract-once via `exPara` owned marker; `MemoryHigh=2200M` | env: `CHUNK_SIZE/ADX_PDF_MAX/ADX_GATEWAY_APIKEY/ADX_FROM_DATE/ADX_FIN_TYPES`; one-shot `adx-oneshot.sh` |
| **bhb-financials** (`marsad-bhb-financials.timer` → `bhb-financials-cron.sh` → `bhb-financials.mjs`) | BHB statements: `GetCompanyFinancialStatements` webapi index → download statement PDFs → LLM-extract (Claude Code) → `financial_statements` | **direct HTTP — NO browser, NO proxy** (BHB is not WAF-walled): one JSON `fetch` per company (dynamic APIKey Bearer) + direct PDF downloads; `pdftotext` → `claude -p` | **6 h** | `FSPDF_MAX` (6/run) + `RUN_BUDGET_MS` + chunk cursor; **incremental skip-owned BEFORE download** (`public.filings` `BHB-FS-*`); own `.bhb-financials.lock` (never contends with the Tadawul chrome lock) | env: `CHUNK_SIZE/FSPDF_MAX/RUN_BUDGET_MS/CLAUDE_MODEL`; state `.bhb-financials-chunk` |

> **`bhb-financials` and `adx-gapfill` are the CHEAP script-driven researchers:** both are script-driven +
> LLM-extracting like the Tadawul pair, but **NOT a proxy/bandwidth risk** — the "most expensive thing we
> do" framing of §B applies only to the two headed-Chromium-through-proxy Tadawul researchers. BHB is pure
> direct HTTP (plain JSON webapi + direct PDF downloads, no browser at all); ADX seats the WAF cookies with
> ONE headless nav then `ctx.request.get`s the apigateway JSON + PDFs directly (no per-company SPA render,
> no proxy). Both verified 2026-07-16 — no full-page SPA load, no metered proxy byte. Their cost is bounded
> purely by the `claude -p` budget (`FSPDF_MAX`/`ADX_PDF_MAX`) + direct egress, not proxy bandwidth.

> **Known weakness (Class B):** both **Tadawul** researchers **re-navigate the full market-watch SPA per company to
> check for new documents, even when nothing is new** — the `owned`-skip happens *after* the page load, so
> a steady-state pass still pays full page bandwidth for zero new data. This is the "treasure hunt" the
> owner flagged. The correct end-state is **event-driven**: only re-scrape a company when a new
> financial-statement filing is detected. See §5 remediation.

> **Fixed 2026-07-16 — credit-leak bug in `gapfill-cron.sh`:** the wrapper sources `/etc/marsad/worker.env`
> with `set -a` (exports everything, including `ANTHROPIC_API_KEY` — set there for the platform's own
> LLM gateway) before running `tadawul-gapfill.mjs`, which `spawnSync('claude', ['-p', ...])`s with no
> `env` override. `claude -p` prefers `ANTHROPIC_API_KEY` over the OAuth subscription login when both are
> present, so every extraction call silently billed pay-as-you-go **credits** instead of the intended $0
> subscription seat (the comment "$0 via Claude Code subscription" was never true in practice). Fixed by
> `unset ANTHROPIC_API_KEY` right after sourcing worker.env in `gapfill-cron.sh`.

*One-off / manual scripts in `/home/deploy` (NOT timed, dev tools — do not run recurring):
`tadawul-acquire/company/detail/diag/marketwatch/profile.mjs`, `geonode-navtest.mjs`, `extract-test.mjs`,
`xbrl-ingest.mjs`. These should be pruned or moved to a `scripts/` dir; they are not part of the fleet.*

---

## 3. The guardrail framework

Three layers keep the fleet from doing pointless or runaway work.

### 3.1 Productivity guard (Class A — shipped `20260716100000`, see `01-ingestion.md §4.5`)

A cadence-driven ingest worker that produces no incremental lake benefit (`fetch_log.changed=false`) has
its effective cadence backed off exponentially (`base × least(cap, 2^⌊idle/3⌋)`), auto-resuming on the
next changed run. Per-class caps: quotes 2×, filings/detail 8×, eod/backfill exempt. Kill-switch:
`update ingest.schedules set max_backoff_mult=1`.

### 3.2 Proxy-byte discipline (Class B — the expensive lever)

The residential proxy is **metered and billed per byte**. Rules for any proxied worker:

1. **Only proxy a host that genuinely cannot be reached direct** (Akamai/geo-block). Audit:
   `select id,venue,data_type,active from ingest.sources where (endpoint_config->>'use_proxy')::bool`.
   Today the only proxy-configured ingest source is BHB `ohlcv_backfill` (inactive). **The proxy's real
   users are the two Tadawul browser researchers**, not the ingest fleet.
2. **Fetch the data endpoint, not the page.** A researcher that needs an XBRL/PDF URL should reach it with
   the fewest page loads possible and **block non-essential resources** (`context.route` → abort
   `image`/`font`/`media`, and analytics/ad hosts) — a DOM/data scrape never needs them. (Caveat: on an
   Akamai host, validate that resource-blocking does not raise the challenge rate before enabling it.)
3. **Cadence tracks how often the data changes, not how often you can poll.** Financial statements are
   **quarterly** — a full-universe browser sweep every 15 min is ~4,000× more often than the data changes.
4. **Never re-load a page whose output you already own.** Gate the expensive fetch on a cheap signal (a
   new filing in the feed, a coverage flag), so steady-state passes cost ~nothing.
5. **Bound every run** (`RUN_BUDGET_MS`, chunk size, PDF cap) and **log bytes/run** so bandwidth is
   observable and a runaway is caught early.

### 3.3 Coverage & session gates (both classes)

- **Coverage guard:** a worker that has fully covered its universe stops (ohlcv_backfill's
  `ohlcv_backfilled_at`; the researchers' `owned` skip). The gate must be checked **before** the expensive
  fetch, not after.
- **Session/calendar gate:** session-only sources don't run off-hours (`venue_is_open`).
- **Close-gate:** eod_sweep fetches once/day/venue at close+30.

---

## 4. Agent onboarding — the four guardrails every new worker declares BEFORE it runs

No scraper/agent/worker is activated until it declares all four. This is the contract; a worker that
can't answer these is a treasure hunt and must not run.

**1 — How frequently to run (cadence + why).** State the cadence and justify it against *how often the
data changes*. Class A: an `ingest.schedules` row (+ the productivity guard auto-tunes it). Class B: a
systemd `OnUnitActiveSec` sized to the data's real change rate (quarterly data ⇒ ≥ every few hours, ideally
event-driven). **Default suspicion: if the cadence is faster than the data changes, it is wrong.**

**2 — Run path / exact datapoint + how to extract it (no treasure hunt).** Name the *pinned* endpoint and
the exact field/artifact:
- Class A: `ingest.sources.endpoint_config.urlTemplate` (+ `filingFieldMap` / parser) — the adapter knows
  the response *shape*, never discovers it at runtime. A source with no pinned `urlTemplate` (needs live
  discovery every run) is not production-ready.
- Class B: the fewest page loads to reach the artifact, resource-blocking on, and the exact URL pattern of
  the target (`XBRL_DOCS/*.html`, `fsPdf/*.pdf`). Full-page rendering is a last resort, only for genuinely
  JS-rendered artifacts.

**3 — When to stop and rest (coverage + benefit).** Define the terminal/rest condition: a coverage flag
(everything owned), a benefit signal (nothing changed ⇒ back off), a session/close gate, or a bounded run
budget. **A worker with no stop condition is a bug.** Class A gets the productivity guard for free; Class B
must implement its own (skip-owned before fetch, run budget, event trigger).

**4 — Configuration set (config over code, Desk-overridable).** Every knob — URL, cadence, chunk size,
proxy on/off, budgets, active flag — lives in `ingest.sources`/`ingest.schedules` (Class A) or the
service's env/`.env` + systemd drop-in (Class B), **never hardcoded**, so it is tunable without a redeploy.
Class-B scripts must be **version-controlled in the repo** (today `researcher/gapfill` live only on the
VPS in `/home/deploy` — a gap; they should move under `scripts/researchers/` with their systemd units).

**Onboarding checklist (paste into the PR that adds a worker):**
- [ ] Cadence set to the data's change rate (not the max poll rate); justified in one line.
- [ ] Endpoint/datapoint **pinned** (no per-run discovery); parser knows the shape.
- [ ] Stop/rest condition defined (coverage flag / benefit backoff / gate / run budget).
- [ ] If proxied: justified why direct fails; resource-blocking on; bytes/run logged; cadence ≤ data change rate.
- [ ] All config in data/env (nothing hardcoded); script in the repo; kill-switch documented.
- [ ] Heartbeat + fetch_log so the productivity guard / sentinel can see it.
- [ ] **Heartbeat reports OUTCOME, not just liveness** — `heartbeatOk()` on success *and*
      `heartbeatError()` on failure, not `heartbeatRun()` alone. A `last_run_at` stamp only answers
      "is it beating?", which stays **true** for a job that runs forever and fails every time; the
      sentinel's failure rule needs `last_ok_at` + `consecutive_failures` to see it. Skipping this is
      how `ingest:quote_poll:ADX` stayed dark for 47 h (`20260717101959`). If the job intentionally
      does nothing (gate/close-window/coverage), that is a **success**, not a failure — call
      `heartbeatOk()`, or the sentinel will page on a healthy no-op.

---

## 5. Incident 2026-07-16 — 9 GB/night proxy bandwidth (root cause + remediation)

**Symptom:** ~9 GB overnight on the metered Geonode residential proxy, with the ingest fleet showing near-
zero proxy-configured sources and tiny fetch volume.

**Root cause:** two VPS `systemd` browser researchers, **not** the ingest fleet:
`marsad-researcher.timer` (every **15 min**, 55 runs/night) and `marsad-gapfill.timer` (every **20 min**,
42 runs/night). Each launches a **headed Chromium through the proxy** and does **full-page `goto`
navigations of the saudiexchange.sa SPA per company** with **no resource interception** (loads all JS/CSS/
images/fonts), 2 concurrent sticky-IP browsers, then in-page-fetches XBRL/PDFs — for data that changes
**quarterly**, re-loading company pages even when nothing is new. ~190 MB/run × ~90 runs ≈ 9 GB.

**Immediate remediation (done, reversible):** both timers throttled `15/20 min → 6 h` via systemd drop-ins
(`/etc/systemd/system/marsad-{researcher,gapfill}.timer.d/throttle.conf`). ~20× fewer runs → ~9 GB → a few
hundred MB/night, with zero data loss (quarterly data; incremental skip-owned). Revert:
`rm the drop-in && systemctl daemon-reload && systemctl restart …timer`.

**Recommended deeper fixes (owner approval — they touch the proprietary scraper):**
1. **Event-driven cadence:** trigger a company re-scrape only on a *new* TDWL financial-statement filing,
   not on a blind timer. Steady state then costs ~nothing. (Biggest, most correct win.)
2. **Resource interception + bytes/run logging** in both scrapers (block `image`/`font`/`media`/trackers;
   validate Akamai challenge rate doesn't rise). Adds observability + a further per-run cut.
3. **Move the scrapers into the repo** (`scripts/researchers/`), version-controlled, with their config as
   declared env — closing the onboarding-guardrail gap (they run today untracked on the VPS).
4. **A hard per-run byte budget** as a safety net so no future misconfiguration can burn GBs in a night.

**Status of the deeper fixes (2026-07-16):** #2 (resource interception + bytes/run logging) and #4
(hard per-run byte budget) are **DONE** — shipped in `scripts/researchers/scrape-guardrails.mjs`,
imported by both scrapers, validated live (Aramco: 17 XBRL / 21 PDF found, 137 requests blocked, no extra
Akamai challenge, `proxy 10.8 MB` logged). #3 (repo-tracking) is **DONE** — both scrapers + wrappers +
units are now under `scripts/researchers/`. #1 (event-driven cadence) is specced below and needs sign-off.

---

## 6. Event-driven researcher redesign (spec — needs owner sign-off)

**The remaining waste.** Even at 6 h cadence with interception, both researchers **walk the universe on a
blind timer** and pay full page-load bandwidth to *check* each company for new documents — the `owned`/
`covered` skip happens only *after* the market-watch + profile SPA loads (~10 MB/company). Financial
statements arrive ~4×/year/company in known windows, so ~99% of these page loads discover nothing new.
"Well-pointed" means: **do the expensive proxy page-load for a company only when it actually has a new
filing.** Two ways to know that cheaply:

### Option A — Reporting-window calendar gate (near-term, zero new infra)
Saudi issuers file on statutory windows: quarterlies within ~30 days of Mar 31 / Jun 30 / Sep 30, annuals
within ~90 days of Dec 31. **Gate the cadence on the calendar:** run the universe walk frequently only
*inside* those windows (e.g. the ~6 weeks after each quarter-end), and rarely (weekly) outside them.
- **Build:** the cron wrapper (`researcher-cron.sh`) computes "am I in a reporting window?" from the date
  and exits early if not (or a second, slow systemd `OnCalendar` for the off-season). ~15 lines. No detector.
- **Saves:** ~2/3 of the year is off-season → the walk stops entirely then. In-window it still walks (but
  that is when filings actually land, so it is justified — not waste).
- **Keeps:** the current scraping logic unchanged; lowest risk.

### Option B — Tadawul market-wide disclosures detector → targeted scrape (the well-pointed endgame)
> **Owner directive 2026-07-16:** the golden source of truth is **Tadawul (`saudiexchange.sa`), not
> Mubasher** — Mubasher is/will be paywalled, so the platform must not build new pipelines on it. The
> detector is therefore Tadawul-native, not a Mubasher/Argaam feed.

The waste in the universe walk is that it discovers *which company filed* by loading each company's page.
Tadawul publishes a **market-wide issuer-news / disclosures list** (`newsandreports/issuer-news`) that
names every recent filing (issuer + type + date + id) — **one page load instead of 387.** The redesign:
- **Detector:** the wrapper loads the issuer-news disclosures list **once** (through the proxy browser,
  since Tadawul is Akamai-blocked), diffs the recent *financial-statement* filings against a seen-set
  (`ingest.seen_items`-style), and derives the set of companies with a NEW filing.
- **Targeted scrape:** feed exactly those tickers to the existing scrapers via `ACQUIRE_SYMBOLS=<list>`
  (they already accept it). The blind universe walk is retired.
- **Steady-state proxy cost ≈ 1 disclosures-list load per run + a page-load only per genuinely-new filing**
  ≈ a few MB/day — essentially the floor.
- **Build:** (1) the **discovery task** — DONE (finding): a direct `goto` of the issuer-news portal URL
  does **not** render (Akamai + the WebSphere portal virtualizes exactly like the company profile — two
  capture attempts crashed on that nav). So the detector must reach the disclosures list via the same
  market-watch→in-page-SPA-nav click pattern the researcher already uses for company profiles; pinning the
  exact list feed is part of this build. (2) A small `list-disclosures.mjs` that loads it,
  parses `(ticker, filing_ref, filedAt)`, and writes a `tdwl_fs_pending` set. (3) The wrappers read pending
  tickers instead of the chunk cursor. All Tadawul-native, no Mubasher.

### Recommendation
**A shipped now**; **build B** as the endgame once the issuer-news list is pinned. A + interception + the
6 h throttle already take ~9 GB to well under 1 GB/night; B takes steady state to ~zero — all off Tadawul.

### Broader steer — exit Mubasher platform-wide (strategic, separate from this)
Per the same directive, the platform should get **off Mubasher entirely**, not just the researcher. Current
Mubasher dependence: **TDWL quotes** (Mubasher `/stocks/prices?country=sa`) and the **TDWL/ADX OHLCV
backfill** (Mubasher CSV). These moved to Mubasher because `saudiexchange.sa` is Akamai-blocked *direct*;
returning them to Tadawul means routing them through the **proxy browser** (the researchers' path) — a real
cost/latency trade the quotes cadence (10-min, all 387 tickers) makes non-trivial. This is a **separate
project** with its own plan (options: Tadawul-via-proxy board capture; official EOD-license; accept the
proxy cost). Logged as **DEF-EXIT-MUBASHER** in §7 — do not fold it into the researcher work.

# Marsad — Build Status & Roadmap

_Last updated: 2026-07-13. Living document — the source of truth for what's shipped, what's live, and what's next._

Maps against the phase plan in [`docs/architecture/00-master-plan.md`](architecture/00-master-plan.md).

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

### Owner action items (non-blocking)
- Enable `custom_access_token_hook` in Supabase Dashboard → Auth → Hooks (needed for P5 reader auth, not before)
- IPRoyal / proxy creds already set on the VPS; rotate anytime from the IPRoyal dashboard

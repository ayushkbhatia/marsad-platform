# Marsad — Engineering Handoff

_Written 2026-07-20 at the end of the data-tier + newsroom build. Read this, then `docs/BUILD-STATUS.md` (the living ledger) and `docs/architecture/00-master-plan.md` (the phase plan). This file is the "what a new engineer needs in their head" — orientation, current state, the road ahead, and the traps that already cost time._

---

## 0. What Marsad is

An **agent-run GCC equity-research platform**. Scrapers/researchers keep a data lake of all 6 Gulf exchanges (TDWL/DFM/ADX/QE/MSX/BHB, ~762 listed securities) fresh; an autonomous newsroom writes cited articles/wires off that lake; a reader app (mostly unbuilt) will surface it. Owner is ex-hedge-fund, ME-based. Delayed data only (scrape-only, 15-min), English only, cheapest-run-cost with swappable LLM providers. Design set (181 screens) exists; most of the reader/Desk UI is greenfield.

**The spine that exists and works:** ingestion fleet → `lake.objects` (canonical, cross-checked) → projections into `public.*` serving tables → derived (`key_ratios`, `scores`) → newsroom conveyor (classify→draft→edit→rules→approval→publish) → a bare approval screen. Everything downstream of "a fact in the lake" is proven end-to-end. The reader app is the big missing consumer.

---

## 1. Infra map & how to operate

| Thing | Where | Notes |
|---|---|---|
| **Repo** | `ayushkbhatia/marsad-platform` (private) | 3 packages: root (Next.js app), `ingestion/` (scraper framework + lake + LLM gateway + rules engine), `worker/` (pgmq consumers on the VPS). `worker` depends on `marsad-ingestion` (file:); reach shared code via the ingestion barrel. |
| **DB** | Supabase project `yjsncnpbjuueaoeejrqj`, ap-south-1, PG17 | Schemas: `public` (serving + reader), `lake` (canonical objects + citations), `ingest` (sources/schedules/fetch_log), `ops` (pipeline/rules/incidents/llm_runs), `iam` (principals/roles/switches). Only `public` + `graphql_public` are PostgREST-exposed — `ops`/`lake`/`ingest`/`iam` are reached via **public wrapper views/RPCs** or a direct pg connection. |
| **VPS worker** | Hetzner CX23 `91.99.99.85` (Nuremberg), `root` SSH | systemd `marsad-worker` (pgmq consumers + ingest poller) + ~8 researcher timers. Env in `/etc/marsad/worker.env`. Code at `/opt/marsad` (deploy user; `git config --global --add safe.directory /opt/marsad` already set). |
| **Vercel** | `marsad-platform.vercel.app` | Auto-deploys `main` on its own GitHub integration (independent of GitHub Actions). `/admin/*` is HTTP Basic Auth (`proxy.ts`, needs `ADMIN_USER`/`ADMIN_PASSWORD` in Vercel env). |
| **CI** | GitHub Actions | **CURRENTLY BILLING-BLOCKED** — every run dies in 2s ("recent account payments have failed"). This also kills the auto worker-deploy. All work this session was validated locally + against prod, and the **VPS worker is deployed by hand over SSH**. **First ops task: fix GitHub billing.** |

### Deploy playbook (until CI billing is fixed)
- **DB migration:** write the `.sql` in `supabase/migrations/`, apply via Supabase MCP `apply_migration`, then **rename the local file to the live stamp** (`supabase_migrations.schema_migrations.version` — the MCP auto-stamps its own timestamp) and append to `supabase/migrations.ledger`. Run `node scripts/check-migration-ledger.mjs` (CI guards repo↔ledger drift). **Commit the .sql** — a migration applied via MCP but not committed = repo/live drift, a documented recurring trap.
- **Worker/ingestion change:** merge to `main`, then on the VPS: `sudo -u deploy git fetch origin && git reset --hard origin/main`, `cd ingestion && npm run build`, `cd ../worker && npm run build && npm prune --omit=dev`, `systemctl restart marsad-worker`. Verify `systemctl is-active` + the boot log.
- **Reader/Desk (Next):** merge to `main` → Vercel deploys automatically.

### The golden rules (from `AGENTS.md` — these are load-bearing)
1. **This Next.js is non-standard (v16.2.10).** Middleware is `proxy.ts` (renamed). `params`/`searchParams` are Promises (await them). Read `node_modules/next/dist/docs/` before writing app code — except it's **not shipped in this install**, so lean on the existing `src/app/admin/lake/page.tsx` as the known-good pattern.
2. **Docs move with the code, same change.** `BUILD-STATUS.md` is the source of truth for shipped/live/next; `docs/architecture/*` are the domain specs. Deferred work goes in BUILD-STATUS §7 with a **trigger** + a **home**, or it's lost.
3. **Postgres.js Date trap:** the driver returns `date`/`timestamp` as JS `Date`, never a string — never compare to a string in JS; use `to_char`/`::text` in SQL. This has silently broken gates twice.
4. **Hot-function migrations:** a `create or replace` on a live function must diff against the **latest applied body**, not the version you authored from (a stamp-regression once dropped a CTE and re-injected 60k rows). Verify live body md5 vs repo before replacing.
5. **RLS ≠ grant.** A table with RLS enabled needs a **policy**, not just a `grant`. This bit the newsroom tables AND `ops.llm_runs` (silent insert failures) this session. New worker-written table → add `create policy worker_all ... for all to marsad_worker using(true) with check(true)`.

---

## 2. Current state (verified live 2026-07-20)

**Data lake — rich and flowing:**
- `financial_statements`: **32,337 rows** (income 8,337 / balance 7,415 / cashflow 8,458 / **oci 4,073 / equity_change 4,054** — the Phase B XBRL enrichment). Presentation labels + filing links on the TDWL replay set.
- `ohlcv_daily`: 571k bars, all 6 venues ≥2y (deep backfill to 1993 paused, see DEF-DEEP-BACKFILL).
- `filings`: 13,551; **AI summaries/facts on 152** (filing-extractor draining the queue, ~12/45min).
- `key_ratios`: **PE non-null on 399**, `scores`: **337** — nightly + score_batch are working (the numeric-overflow bug that blocked them is fixed).
- Identity: ISIN on 276/762, **shares_outstanding on only 49** (QE only — the binding gap; see below).

**Newsroom — backend complete, not armed:**
- Switches all **OFF**: `pipeline_intake_enabled=false` (trigger doesn't fire), `auto_publish_wires=false` (everything → approval), `pause_all_agents=false`, `kill_all_output=false`.
- `content_items`: 3, `pipeline_items`: 3, `llm_runs`: 7. One real QNBK wire (item 7) sits at `approval` as a live demo of `/admin/approvals`.
- 1 open incident (check `ops.incidents where resolved_at is null`).

**Empty tables (no producer yet):** `dividends`, `earnings_events`, `estimates`, `transcripts`, `holders`, `ownership_snapshots`, `index_levels_daily`, `company_people`. These gate specific templates/reader tabs.

---

## 3. The road ahead — build ledger

Ordered by leverage. Each item: what, why, where to start.

### A. Data-tier completion (finish the lake before the reader leans on it)

1. **`shares_outstanding` — the single most valuable missing scalar.** 49/762. Blocks real PE/PB/market-cap/Score on 5 venues. Not in TDWL XBRL. Owner approved Mubasher (direct HTTP, no proxy) for TDWL but the profile API route is unknown — **needs one browser XHR capture** of a Mubasher stock page (F12 → Network → find the `/api/1/...` call carrying shares; owner can paste a cURL in ~2 min, faster than headless capture). MSX/BHB/DFM identity endpoints also unmapped (probe findings in BUILD-STATUS §Phase C). The producer machinery is config-driven and live — each venue is just a URL + fieldMap once the endpoint is known (QE proved the whole path: 49/49 in one evening).
2. **`dividends` + `earnings_events` producers.** The equity_change tier already holds dividends-declared data per period; a projection `equity_change → public.dividends` is a small add and unblocks **TPL-04 dividend wires** + the reader dividends tab. Earnings verdicts (`earnings_events`) unblock TPL-03 recaps + the Revisions score factor.
3. **`index_levels_daily`.** Empty — but the reader **front page (Ledger) leads with the index tape**. Needs an index-levels scraper (6 indices seeded, zero levels). Nobody's building this; flag it early for P2.
4. **Filing-facts drain continues** (filing-extractor timer running; ~13k filings, 152 done). Steady-state; just let it run + watch the queue.
5. **Deep OHLCV backfill (DEF-DEEP-BACKFILL-ROLLOUT)** — 20-33y history paused behind a staging-throughput fix. Only needed for long-horizon charts; not blocking.

### B. Newsroom — arm + tune (backend is done)

1. **DEF-WRITER-NUMBER-MARKING** — the writer occasionally leaves a number without a `[cN]` marker on **story-length** drafts → R-03 blocks → loops to human. Fix: strengthen the writer prompt's "every number carries a marker" rule, or add a post-draft auto-marker pass. **Wire-first (TPL-01, ≤40w, single fact) is the easy first clean piece** — tune that path first.
2. **Arm it, gradually:** flip `pipeline_intake_enabled` ON (trigger starts firing on VERIFIED objects — watch `q_pipeline` volume, the prefilter drops the noisy types). Then, once wires look right in `/admin/approvals`, flip `auto_publish_wires` ON for the human-free TPL-01 path.
3. **DEF-NEWSROOM-LLM-ACCOUNTING is FIXED** (was an RLS-policy gap) — the budget ladder (`ops.newsroom_budget_state` → ok/$60/$120) now has data. Watch spend once armed.
4. **What single-source means:** statements land PENDING (single-source by design), and R-03 requires VERIFIED-now citations. So a story citing statements always routes to human approval, never auto-publishes. Correct for a single-source lake — know it, don't "fix" it.

### C. P2 — Reader app (the biggest greenfield, highest product value)

The app is ~create-next-app + `/admin/*` ops pages + `/styleguide`. The whole reader route tree (~50 routes, spec in `docs/architecture/04-reader-app.md`) is unbuilt. **It reads only public tables the lake already fills — buildable now, TDWL/QE richest.** Order:
1. `src/proxy.ts` matcher + the 7 `/api/pulse/*` polling endpoints (CDN-cached, no websockets day one) + `usePulse` hook.
2. Ledger front page (needs index tape → build A.3 first) + `/markets` + heatmap (quotes_latest + venue_feed_status exist).
3. Stock pages (~762): Overview + chart tab (bars exist) + **Financials tab** (32k statement rows renderable NOW — use the `presentation` jsonb for faithful ordering) + Filings tab (13k rows). The doc's "credible page" bar: financials + ratio strip + chart + Score — TDWL/QE hit it first; ship venue-by-venue.
4. Newswire from `public.filings`; screener over `key_ratios`; search + SEO.
- **RLS note:** `financial_statements` + `key_ratios` are default-deny (a premium/pricing decision, not a bug — `design-analysis.md §85`). Reader reads them via a service-role path or a public view with an entitlement gate; decide the pricing tier when you build the Financials tab.

### D. P4 — Marsad Desk (~19 admin screens)

`docs/architecture/05-desk-admin.md`. The backend for the **approval queue already exists** (P3.5 — `desk_decide_approval`, `v_desk_approvals`). Pull the **market-data ops screen (33a)** forward — editing `ingest.sources`/`schedules` from a UI directly serves the daily fleet tuning you do by hand now. Then agents console, lake browser, rules editor, front-page curation. All read `ops`/`ingest`/`lake` via service-role like `/admin/lake` does.

### E. P5 — Monetization

Auth (Supabase Auth — **owner must enable `custom_access_token_hook`** in the dashboard, a pending manual action that also unblocks real per-user Desk auth, replacing the interim Basic-Auth + DESK-OWNER principal), Stripe UAE, server-side entitlements/meters (2 reads / 3 scores / 5 AI answers), dunning, transactional email (SES), PDPL/ZATCA.

### F. P6 — Full surfaces (+ the owner's two originally-requested agent tiers)

- **News-signal researcher agents** (the owner's item 1 from the first conversation): DATA-NEWS ingests external news/RSS/exchange wires, ties a signal to a stock, WRITER-3 drafts deep-dive/Take articles. The pipeline exists (P3); this adds the **external-news intake trigger** + the analyst-angle prompts. Currently the only trigger is VERIFIED lake objects (filings/results); wire DATA-NEWS to also enqueue from news.
- **Editorial/design agents** (owner's item 2): EDITOR-1 is "design & publishing" in spec but only does headline-tighten today. **Infographics/charts is NET-NEW scope** — `claude.ai/design` has no callable API. The feasible version: a chart-spec step in the writer pipeline → a deterministic SVG/PNG renderer over lake data → attached via `content_attachments`/`story_blocks` (14 seeded). Needs a §7 ledger row + a spec addition to `03-agent-newsroom.md` — **decide with the owner before building.**
- Also P6: alerts/watchlists, Marsad AI + pgvector (embeddings deferred to here), IPO/dividends/earnings suites, analyst hub, Wire Brief email, self-hosted analytics.

### G. P7 — Hardening

Backfill depth, ads, security/RLS pen pass, restore drills, runbooks, second-VPS/PITR (post-launch).

---

## 4. Live defects & watches

- **Open fix chips (spawned, may be unstarted):** BHB quotes 401 (expired pinned Bearer — move to the dynamic Bearer that filings uses) and QE quotes frozen-board (mw.php serving cached content intraday — the `qe-financials` PR #62 added a curl-transport fix for the board; verify quotes advance). The nightly-overflow chip was already fixed by PR #50.
- **eod_bulletin** sources (ADX/BHB) fetch but 0-ok — the 2nd-source cross-check path; parked (DEF-EOD-BULLETIN).
- **1 open incident** live — check `ops.incidents`.
- After any market session, sanity-check quote freshness per venue (`quotes_latest.as_of`) — session-gated feeds go stale off-session by design.

## 5. Traps already paid for (don't re-learn these)

- **Migration ledger drift** on every merge conflict — resolve by taking `origin/main`'s ledger then appending your row; `--write` reconciles.
- **`sql.json(x)` needs a cast** in the worker (`x as never`) — postgres.js types.
- **`lake.objects` insert needs `parse_run_id`** (NOT NULL) + `verified_by` when state=VERIFIED (a guard trigger enforces it).
- **`securities.sector` is a FK to `sectors(key)`** — a 12-slug taxonomy, not free text; unmappable → `'unknown'` logged.
- **`global_switches.value` is boolean, `changed_by` is NOT NULL** (use SYSTEM principal id).
- **`principal_kind` enum is `human|agent|system`** — humans need `auth_user_id`; use `system` kind for service principals like DESK-OWNER.
- **VPS long jobs:** launch detached via `systemd-run` (transient unit), NOT `nohup` (dies on SSH session GC). conc=2 + swap + MemoryHigh proven; conc=4 OOMs.
- **Pooler cap:** 5 concurrent researcher jobs hit the 35-client session-pooler cap once — stagger timers, cap pools.
- **Mubasher is being exited** (owner directive, DEF-EXIT-MUBASHER) — don't add new Mubasher dependencies except the one approved shares snapshot.

## 6. Immediate next moves (my recommendation, in order)

1. **Fix GitHub billing** (unblocks CI + auto-deploy — everything else is slower without it).
2. **`shares_outstanding`** — get the Mubasher (+ MSX/BHB/DFM) profile cURLs from the owner, wire the producers. Unblocks real ratios/scores platform-wide. Highest data leverage.
3. **`dividends` projection** off the equity_change tier → arm TPL-04 dividend wires → **the first clean auto-published wire** (short, single-fact, easy R-03 pass). This is the most satisfying "watch the newsroom go live" milestone.
4. **P2 reader, stock-page-first** — the platform has no face yet; the lake is rich enough (TDWL/QE) to render credible Financials + chart + Score tabs today.
5. In parallel, **arm the newsroom gradually** (intake ON → watch → auto-publish ON) and tune DEF-WRITER-NUMBER-MARKING.

---

_Memory files under `~/.claude/projects/-Users-ayushkbhatia-Marsad-Platform/memory/` carry the deeper operating knowledge (per-venue API contracts, the fleet job-map, sourcing decisions). `marsad-gap-analysis-2026-07-17.md` is the running session ledger. Everything in this handoff is grounded in live DB/VPS state as of 2026-07-20, not docs._

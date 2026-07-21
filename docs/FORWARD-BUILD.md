# Marsad — Forward Build Plan

_Written 2026-07-21. A shareable, standalone pickup doc for the next engineer(s). Read this, then
`docs/HANDOFF.md` (orientation + traps), `docs/BUILD-STATUS.md` (the living ledger), and
`docs/architecture/04-reader-app.md` (the reader route→screen spec). The centerpiece here is **§3 — how
to launch the front-end in parallel toward a production-ready app from the design set.**_

---

## 1. Where things stand (post 2026-07-20/21 build)

**The data spine is rich and flowing.** Everything from a scraped fact → serving tables → derived →
newsroom is proven end-to-end. Recent deltas:

- **Fundamentals essentially solved.** `shares_outstanding` 49 → **728/762 (96%)** (Mubasher page scrape,
  all 6 venues); this unblocked **market-cap 668**, **PE 497**, **PB 490**, **Scores 465**. Financials
  **613/762 secs (80%)** after the stockanalysis/S&P **cross-check + gap-enrich** (16.7k rows tagged
  `source='stockanalysis-spg'`, reversible; 33k filing rows untouched; a 2.3k-row Desk conflict/QA queue).
- **Dividends** 1,147 (TDWL history, gated) · **earnings_events** 4,190 (actuals) · **index tape LIVE**
  (all 6 headline indices via Yahoo + tradingeconomics, 10-min refresh).
- **Reader (P2) LIVE on Vercel** — foundation + stock pages + markets/screener/newswire/SEO.
- **Newsroom** backend complete; **switches OFF** (not armed); writer number-marking fixed + budget ladder enforced.

**Built reader routes (13 of ~50 spec'd in `04-reader-app.md`):**
`/` (Ledger) · `/markets` · `/wire` · `/filings` · `/filings/[id]` · `/stocks/[venue]/[ticker]` (+ `/chart`
`/filings` `/financials`) · `/screener` · (+ `/admin/{lake,approvals}` ops, `/styleguide`).

**Foundation in place (the reusable seam):** `src/lib/data/*` (cookieless-anon `use cache` read layer),
`/api/pulse/*` + `usePulse`, `public.v_scores_public`, `src/lib/securities/resolve.ts`, market-state,
5 UI primitives + 13 reader components, design tokens (`globals.css @theme`), the `cacheComponents`
+ `<Suspense>` + async-params conventions.

**Unbuilt reader surfaces:** articles/research, analysts/investors, earnings/dividends/IPO/concalls
calendars, compare/datapoints, the stock-page dividends/earnings/ownership tabs, the whole `(member)`
group (watchlist/alerts/notebook/AI) + `(auth)` group, and the P4 Desk (~19 screens).

---

## 2. Forward build list (ordered by leverage)

`[OWNER]` = needs the owner · `[READY]` = buildable now · `[BLOCKED-BY]` noted.

### Unblock (owner-only)
- `[OWNER]` **GitHub billing** — restores CI + auto-worker-deploy (all deploys are hand/SSH until then).
- `[OWNER]` **Enable `custom_access_token_hook`** (Supabase dashboard) — gates all P5 auth + per-user Desk.
- `[OWNER]` **Newsroom auto-publish sign-off** — the irreversible flip (also needs the ≥2-root feed below).
- `[OWNER]` **Confirm the 33c entitlement/pricing model** (free vs premium per surface) — gates the member/premium front-end.

### Data-tier — finish the lake
- `[READY]` **`DIVIDEND.DECLARED` feed** (DPS + ex/record/pay dates off filing-facts) → arms **TPL-04
  dividend wires** (the first clean auto-publish) + real reader dividend cards. _Highest-leverage next._
- `[READY]` **SA symbol-drift close** — seed `securities.sa_symbol` via stockanalysis `/api/search` for the
  ~10% (Bahrain cross-listings) → the last ~150 secs of financials coverage.
- `[READY]` **SA weekly refresh lane** + re-reconcile on golden restatement (xcheck staleness).
- `[READY]` **Earnings consensus/verdict source** → BEAT/MISS + the Score Revisions factor (or ratify "Marsad-internal, sparse-allowed").
- `[READY]` **ISIN/sector for ADX + BHB** via their gated profile endpoints (ADX browser cookie-seat / BHB
  dynamic Bearer). DFM/MSX have **no clean ISIN source** — park. _Low priority (identity nicety, not a blocker)._
- `[READY]` **Deep OHLCV backfill** (20-33y) — staging-throughput fix then off-hours drain (DEF-DEEP-BACKFILL).
- `[READY]` **Producers for the empty tiers** the front-end needs: `holders`/`ownership_snapshots`,
  `company_people` (board/mgmt), `transcripts`, `estimates`, `ipo_offers`.

### Data quality / ops
- `[READY]` **Desk conflict-queue review** — 2.3k real SA-vs-golden diffs (sign flips/scope); some are genuine extraction bugs.
- `[READY]` **Financials un-gate decision** — SA now fills the non-XBRL venues; decide free-vs-premium per the pricing model.

### Newsroom — arm gradually
- `[READY]` **`DEF-WRITER-CONTEXT-VERIFIED`** — stop handing the writer PENDING-backed facts (the other story-blocker).
- `[READY]` **≥2-lineage-root sourcing** on price-sensitive objects → makes auto-wire actually fire.
- `[READY]` **Intake soak** — flip `pipeline_intake_enabled` ON (human-gated) → watch → then `auto_publish_wires` with sign-off.

### Front-end (see §3 for the parallel playbook)
- `[READY]` **Reader public surfaces** — calendars, analysts/investors, article/research depth, stock-page
  dividends/earnings/ownership tabs, compare/datapoints, heatmap/screens depth. _Fully parallelizable now._
- `[BLOCKED-BY: auth]` **Member surfaces** — watchlist/alerts/notebook/AI + `(auth)`/checkout.
- `[READY]` **P4 Desk** — market-data ops screen first (edit `ingest.sources`/`schedules` from a UI), then
  agents console, lake browser, rules editor, front-page curation, the SA conflict UI.

### P5 monetization `[BLOCKED-BY: auth hook]`
- Supabase Auth → Stripe UAE → server-side entitlements/meters (2 reads / 3 scores / 5 AI) → dunning → SES email → PDPL/ZATCA.

### P6 / P7
- Alerts+dispatch → **Marsad AI + pgvector** (grounded Q&A over the now-rich lake) → Wire Brief AM email →
  IPO/dividends/earnings suites → analyst hub → infographics (`[OWNER]` decide scope, net-new).
- Hardening: RLS/authz pen pass, restore drills, runbooks, ads, second-VPS/PITR.

**If picking the next 3:** (1) `DIVIDEND.DECLARED` → first auto-wire; (2) SA symbol-drift + weekly lane →
lock the financials win; (3) fan out the reader public surfaces per §3.

---

## 3. Front-end: parallel launch → production-ready app

**The core idea.** The reader is one Next.js 16 app with a **finished foundation**: a `use cache` data
layer, pulse polling, a component library, route-group layouts, and the `cacheComponents`/`<Suspense>`
conventions. So every new surface is the same shape — _"add a route that reads a data-layer fn, composes
primitives, and matches a design screen."_ That shape is **highly parallelizable** because surfaces are
**disjoint route subtrees over a shared read layer**. The trick is to **freeze the seams, then fan out by
vertical slice.**

### 3.1 Freeze the seams first (serial, do once)
These are the only things multiple workers touch, so a **single owner** (lead) controls them. Most already
exist — the remaining task is to _write them down_ so workers don't re-derive or collide:

| Seam | Where | Rule |
|---|---|---|
| **Read layer** | `src/lib/data/*.ts` | one `use cache` fn per surface; workers ADD fns, never edit another's |
| **Component library** | `src/components/{ui,reader}/*` | additions reviewed by the lib owner (prevents 3 duplicate `PriceChart`s) |
| **Design tokens** | `src/app/globals.css @theme` + `design-tokens.json` | frozen — compose, don't restyle |
| **Route-group layouts** | `(reader)/(dataroom)/(member)/(auth)/layout.tsx` | owned by the foundation worker; feature workers add PAGES, not layouts |
| **DB migrations** (RLS/views/entitlements) | `supabase/migrations/*` | serialized through the lead who applies + re-stamps + ledgers |
| **Framework rules** | see §3.4 | documented once; all workers follow |

**Action:** write a `docs/frontend/CONVENTIONS.md` (data-fetch pattern, Suspense/cacheComponents rules,
token usage, the primitive catalog, the collision rules below). ~1 page. This is the single highest-leverage
thing to do before fanning out.

### 3.2 Carve by vertical slice (parallel — one worker each)
Each slice owns a **disjoint route subtree** + its own data-layer fns + its own leaf components. Minimal overlap.

| # | Slice | Owns (routes) | Reads | Design screens |
|---|---|---|---|---|
| S1 | **Stock-page depth** | `stocks/[v]/[t]/{dividends,earnings,ownership,concalls}` | dividends, earnings_events, holders, transcripts | 3d, 8b, 18d |
| S2 | **Calendars** | `earnings/*`, `dividends/*`, `ipo/*` | earnings_events, dividends, ipo_offers | 8a-8d, 23a, 22a-22c |
| S3 | **Editorial** | `articles/[slug]`, `research`, `wire` depth, `analysts/*` | articles (`fn_article_render`), analyst_profiles | 1k, 1l, 1i-1j, 20d |
| S4 | **Data-room** | `(dataroom)/{heatmap,screens,screens/*}` | sector_aggregates, screen_catalog, key_ratios | 1e/2a, 9a-9d |
| S5 | **Entities** | `investors/*`, `compare`, `datapoints/[id]` | holders/ownership, datapoint_series | 20b-20c, 18a-18b |
| S6 | **Member** `[auth]` | `(member)/{watchlist,alerts,notebook,ai/*}` | user-owned tables + AI | 1h, 5a, 20a, 10a-10f |
| S7 | **Auth/checkout** `[auth]` | `(auth)/*`, `checkout/*` | Supabase Auth + Stripe | 6a-6l, 11a-11f |
| S8 | **Desk (P4)** | `admin/*` new screens | ops/lake/ingest via service-role | 33a, agents, lake browser, rules |

S1-S5 + S8 are buildable **now** (public/service-role reads). S6-S7 wait on P5 auth.

### 3.3 Collision rules (the make-or-break for parallel)
1. A slice **never edits another slice's route files or data-layer fns.**
2. New shared component/primitive → **through the library owner** (one reviewer). Leaf components private to a
   slice live under that slice or a slice-named folder.
3. New DB read → a **new `use cache` fn** in the right `data/*.ts` (disjoint), never an inline read in a page.
4. New migration (RLS/view/entitlement) → **PR to the lead**, who applies + re-stamps + ledgers (these are
   cross-cutting; serialize them — see the migration-ledger trap in HANDOFF).
5. Route-group **layout** edits are the foundation worker's; feature workers add pages under the layout.
6. Merge cadence = **incremental-deploy**: each verified surface → `main` → Vercel. The lead owns merges,
   the shared library, migrations, and the design-QA gate (the integration bottleneck — keep it lean).

### 3.4 Framework rules every worker follows (Next 16.2.10, non-standard)
- `params`/`searchParams` are **Promises** — `const {venue,ticker} = await params`.
- `cacheComponents: true` is ON: a page/segment can **not** use `export const dynamic/revalidate`. Put
  request-time/dynamic reads inside a `<Suspense>`-wrapped async child (sync shell → `<Suspense fallback><Body/></Suspense>`
  → async `Body` does the awaits). Pattern lives in `stocks/[v]/[t]/page.tsx` + `admin/lake/page.tsx`.
- A `use cache` fn is **deterministic** — never read `new Date()`/`Date.now()`/`connection()`/`cookies()` inside
  one (that's the blocking-route/current-time error). Dynamic reads go in a non-cached fn that does
  `await connection()` first and is called inside a `<Suspense>`. (This bit `getMarketState`/`getOhlcvSeries` — fixed.)
- Cached public reads use the **cookieless `createAnonClient()`** (`src/lib/supabase/public.ts`); the
  cookie-bound client is for personalized dynamic reads only. Gated/metered reads go through a SECURITY DEFINER
  RPC (§3.2 of 04-reader-app). Never ship gated data to a client component.
- Do **not** extend `src/proxy.ts` matcher to reader/pulse routes (Set-Cookie kills CDN caching).
- Date filtering stays in SQL (`::text`/`.gte`) — never a JS Date-vs-string compare (postgres.js returns Dates).

### 3.5 Design fidelity: from the 181 screens to production
- The design set numbers screens (`1a`…`33x`); `04-reader-app.md §1` maps route→screen and
  `design-analysis.md` carries the analysis. Each worker reads **their** screen(s) in Figma and builds to them.
- The design system is already extracted (tokens + 5 primitives + `/styleguide`), so surfaces **inherit** the
  look — workers compose, they don't reinvent styling.
- **Per-surface design-QA gate (before merge):** screenshot the built route in the preview browser vs the design
  screen; run the `design-critique` + `accessibility-review` passes; fix; then merge. Cover the states the
  design specs: loading (`loading.tsx`), empty (17a-17c), 404 (17d), error boundaries, and the DELAYED/closed
  freshness everywhere.
- A final **design-fidelity sweep** across all surfaces gates "production-ready": visual consistency,
  responsive (mobile-web is a first-class target — auth screens 11a-11f are the mobile auth), dark-mode where
  speced (the dark `(dataroom)` chrome), Lighthouse ≥ 90 on Ledger + stock page, and the pulse cost math holding.

### 3.6 The incremental production ladder
- **L0 (done):** foundation + stock pages + markets = the credible skeleton, deployed.
- **L1 (now, fully parallel):** the public reader surfaces (S1-S5) — read public tables, no auth. Fan out ~5
  workers; each merged surface goes live. _This is what to launch in parallel first._
- **L2:** P5 backbone — auth + Stripe + entitlements + the 33c meter config. Semi-serial (auth is a foundation).
- **L3 (after L2):** member surfaces (S6) + real premium-unlock wiring + paywall variants.
- **L4 (parallel to L1-L3):** Desk (S8) — separate app area, service-role, no user auth interim.
- **L5 (production-hardening):** a11y (WCAG AA), responsive/mobile-web polish, Lighthouse, SEO depth
  (sitemaps/JSON-LD/OG per surface), the design-fidelity sweep, cost/perf validation under the pulse load test,
  RLS pen pass.

### 3.7 Prerequisites before fanning out (do these, then launch S1-S5 in parallel)
1. Write `docs/frontend/CONVENTIONS.md` (§3.1) — the shared contract.
2. Give workers the Figma access + the route→screen map.
3. Decide the entitlement/pricing model (`[OWNER]`) so gated surfaces know free-vs-premium.
4. Build the empty-tier producers the surfaces need (holders/ownership, company_people, transcripts,
   ipo_offers, estimates) **ahead of or alongside** their surface — a page over an empty table is just a graceful
   empty state, so the front-end and its producer can proceed in parallel and meet at the data layer.

---

## 4. Owner action items (consolidated)
1. **GitHub billing** — unblocks CI + auto-deploy.
2. **`custom_access_token_hook`** — unblocks all of P5 + member front-end (S6-S7).
3. **Entitlement/pricing model (33c)** — free vs premium per surface.
4. **Newsroom auto-publish sign-off** (after the ≥2-root feed).
5. **Index-tape:** now live via aggregators; if you want native/exchange sourcing later, one market-open browser capture per venue.
6. Optional data cURLs like the Mubasher-shares one, if a new gated source is found.

_Traps, infra IDs, and deploy playbook are in `docs/HANDOFF.md §1/§5`. The living status is `docs/BUILD-STATUS.md`._

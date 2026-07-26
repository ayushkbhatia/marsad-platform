# Marsad — Bridge Build Plan (backend ↔ front-end)

_Written 2026-07-26. Executable plan for taking every front-end surface from sample-seeded to
live data. Companion to `BRIDGE-PLAN.md` (the **strategy** — the contract seam, the `surfaces`
catalog, the phase idea) and `BUILD-STATUS.md §7` (the **ledger**). This document is the
**execution** layer: numbered steps, exact files, acceptance criteria._

> **This plan EXECUTES `BRIDGE-PLAN.md`, it does not replace it.** That doc's Phase 0 and
> Phase 1 were never started — `src/lib/contracts/`, `src/lib/data/adapters/` and
> `public.surfaces` do not exist in code. Its vocabulary (contract / adapter / surface /
> ready-now / blocked-producer) is used verbatim here.

---

## 0. How to use this document (executor contract)

**Audience:** an executing agent (Sonnet) working step by step, plus the owner reviewing.

**Step ids** are `P{phase}.{step}` — e.g. "execute P1.3". Each step lists: what to change,
exact file paths, and an acceptance criterion. Do not batch phases; a phase is a merge unit.

### 0.1 The five laws (violating any of these is a defect, not a trade-off)

1. **Never edit a view-model type to fit a DB shape.** The view-model is the contract. If the
   DB can't serve a field, the adapter returns `null`/`—` and the gap gets a `DEF-*` row. The
   design is the spec; the schema bends or the field degrades honestly.
2. **Never fabricate.** If a producer is empty, render the honest empty state
   (`EmptyState variant="awaitingFeed"`), never a plausible number. This is the standing law of
   this codebase and the reason the sample seam exists at all.
3. **Layout lives in code, content lives in rows.** Never move layout into the database
   (the schema-driven-UI trap, `BRIDGE-PLAN §0`).
4. **Every parked item gets a `§7` row** with a trigger and a home, in the same commit
   (`AGENTS.md`). "Not written down" = dropped. The newsroom is the proof: none of its real
   defects were ever logged, and it looked "done" while producing nothing.
5. **Docs update in the same change as the code.** No "done in code, stale in docs".

### 0.2 Per-step verification loop (non-negotiable)

```bash
npx tsc --noEmit && npx eslint <changed paths>
```
Then, for any browser-observable change: start the preview, load the route at 1440px, take a
screenshot, and check `read_console_messages` for errors. A step is not done until the route
renders with **real data** and the console is clean.

For any step that changes a DB read, additionally prove the read with SQL against the live DB
(project `yjsncnpbjuueaoeejrqj`) before wiring it — the count you assert in the acceptance
criterion must be the count the query actually returns.

### 0.3 Merge protocol (established, keep)

One branch per phase, `claude/bridge-p{n}`. Commit with the repo's message convention,
`Co-Authored-By: Claude`. Rebase onto `origin/main` (the worker fleet lands commits there
independently), then push `branch:main`. Update `BUILD-STATUS.md` changelog + `§7` and
`SCREENS-REGISTER.md` in the same commit.

---

## 1. Ground truth — measured, not assumed (2026-07-26)

Every number below was measured directly against the live DB and, where it matters, **probed as
`anon`** (`set local role anon`). `BRIDGE-PLAN §1` was explicit that its statuses were inferred;
these are not.

### 1.1 The data is alive

| table | rows | newest |
|---|---|---|
| `ohlcv_daily` | 646,109 | 2026-07-26 |
| `filings` | 14,632 | 2026-07-26 15:24 UTC |
| `quotes_intraday_y2026m07` | 74,343 | — |
| `financial_statements` | 52,277 | — |
| `earnings_events` | 9,180 | report_date 2026-07-21 |
| `index_levels` | 4,261 | 2026-07-26 18:30 UTC |
| `quotes_latest` | 705 | 2026-07-26 12:19 UTC |
| `securities` | 762 | — |
| `key_ratios` | 736 | — |
| `scores` | 538 | 2026-07-26 00:27 UTC |

### 1.2 Per-venue coverage — **705 names can render a real stock page today**

| venue | secs | quote | score | ratios | filings | fins | ohlcv | sector | isin |
|---|---|---|---|---|---|---|---|---|---|
| TDWL | 387 | 387 | 265 | 380 | 326 | 293 | 387 | 387 | 227 |
| MSX | 120 | 93 | 79 | 112 | 105 | 106 | 93 | 120 | 0 |
| ADX | 93 | 63 | 67 | 85 | 71 | 71 | 86 | 93 | 0 |
| DFM | 72 | 72 | 47 | 69 | 67 | 67 | 72 | 72 | 0 |
| QE | 49 | 49 | 42 | 49 | 48 | 48 | 49 | 49 | 49 |
| BHB | 41 | 41 | 38 | 41 | 41 | 41 | 41 | 41 | 0 |
| **total** | **762** | **705** | **538** | **736** | **658** | **626** | **728** | **762** | **276** |

### 1.3 Anon probe — what the reader can actually read

| probe | visible to anon | verdict |
|---|---|---|
| `quotes_intraday` (parent) | **78,365** | ✅ partition-RLS is **not** a blocker; intraday charts are unblocked |
| `ohlcv_daily` | 646,109 | ✅ |
| `earnings_events` | 9,180 | ✅ |
| `v_scores_public` | 538 | ✅ the anon-safe score cut works |
| `v_key_ratios_public` | 736 | ✅ |
| `scores` (base) | 0 | ✅ correctly premium-gated |
| `content_items` | **1** | only the single published WIRE |
| `analysts` | 0 | table is empty (not blocked) |
| `dividends` | **0** | ⚠️ all 1,229 rows are `pending_confirm` → **reader sees nothing** |

### 1.4 The two reframes that drive this plan

**Reframe A — the read layer already exists and is dead-wired.** The reader data layer was built
in wave-1/wave-2; the design pass then replaced pages with sample modules and orphaned it. Dead
but complete: **all of `data/wire.ts`**, **all 8 of `data/editorial.ts`**, **10 of 15 in
`data/calendars.ts`**, 4 in `data/filings.ts`, all 3 reads in `data/stock-overview.ts`,
`getStockOverview`, `getOwnershipForSecurity`, `listNewsroomContent`. Plus ~18 orphaned
components (`QuoteHeader`, `StockTabs`, `ChartPanel`, `PeerComparisonTable`, `ArticleBlocks`,
`AnalystLeaderboard`, `WireStream`…). **Most of the bridge is re-wiring, not building.**

**Reframe B — the newsroom machinery is complete and starved.** The conveyor
(state machine, rules engine, budget ladder, approval desk, kill switches, RLS) is built and
correct. It produces nothing because of four stacked blockers:

1. `iam.global_switches.pipeline_intake_enabled = **false**` — intake is off.
2. Even switched on, intake fires only on `lake.objects.state='VERIFIED'`. Live:
   `FILING.FINANCIALS` = **36,316 PENDING / 1 VERIFIED**; `DIVIDEND.EXDATE`, `EARNINGS.VERDICT`,
   `IPO.OFFER`, `DISCLOSURE.DPS` = **0 objects of any state**. The newsroom is blind to
   14,632 filings and 52,277 statements.
3. **The rules engine blocks every real story** via four engine bugs (§5.2, P4) — not writing
   problems. Both real drafts died `reassigned_human`.
4. The reader can't see it anyway — 5 of 6 editorial routes render `SAMPLE_*`.

The one "live" wire was **hand-seeded** (`writer_agent = NULL`), not agent-written.
**None of these problems has a `§7` row** — which is precisely why the newsroom looked done.

---

## 2. Decisions required before execution

Answer these; the plan branches on them. Recommendation given for each.

| id | decision | options | recommendation |
|---|---|---|---|
| **D-1** | Interim content (owner's point #1) | (a) seed **real** `content_items`/`analysts` rows, hand-authored, and wire the reader to the real read path; (b) keep TS sample modules | **(a).** It exercises the real query path end-to-end, closes four `DEF-*-LIVE-DATA` rows on the FE side, and makes the newsroom rebuild a *producer* swap with zero FE change. Same effort, permanent value. |
| **D-2** | Auth / monetization scope | (a) include as P6 in this plan; (b) stop at the auth boundary and keep member surfaces sample-gated | **(b) for now.** Watchlist, alerts, notifications, 2FA, premium-cut and search-history all block on it, but it is a self-contained project (Stripe + `(auth)` group + hook enablement) and Batch 2 designs are not built. P6 is specified here but sequenced last and separately mergeable. |
| **D-3** | Newsroom supply — the core unblock | (a) promote `FILING.FINANCIALS`/`FILING.REF` to `VERIFIED`; (b) change intake to accept `PENDING` for single-source families; (c) hybrid: intake on a new `state IN ('VERIFIED','PENDING')` predicate scoped by `object_type` | **(c).** `20260719175050_writer_context_pack.sql` states the lake **deliberately serves statements/filings at PENDING** — R-03 never got that memo. Forcing VERIFIED fights the lake's own design; broadening intake per-type is honest and reversible. |
| **D-4** | Analyst identity model | (a) AI agents carry bylines; (b) external human analysts only; (c) hybrid — agents write, a named desk analyst signs off | **(c)**, which is what the schema already models: `content_items.byline_chain` (jsonb chain), `analysts.is_external` + `revenue_share_pct`, and 12 `iam.agent_accounts`. Needs `v_analysts_public` (§P0.5) since `iam.principals` is worker-read-only. |
| **D-5** | Auto-publish posture | (a) keep `auto_publish_wires=false` (every piece human-approved); (b) enable for TPL-01 ≤40 words once guardrails are fixed | **(a) until P5 lands**, then revisit. Owner set this default deliberately on 2026-07-19. Quality gates must measure clean before the human is removed. |
| **D-6** | Stock page prerender scale | (a) `generateStaticParams` over all 705 quoted names; (b) prerender a top-N and serve the rest on demand | **(b)** — prerender ~60 (index constituents + most-active), rest on-demand. 705 × 6 tabs = 4,230 prerenders is a slow build for little gain. |
| **D-7** | Fate of the sample modules | (a) permanent feature-flagged fallback; (b) retire per surface as it goes live | **(b) with a transitional fallback.** Keep `withSampleFallback` during P1–P3 so an empty read can never blank a pixel-perfect screen, then delete per surface. Tracked so it can't linger. |

### 2.1 Owner-blocked items (cannot be executed by an agent)

- **O-1** Confirm `yjsncnpbjuueaoeejrqj` is the production project (BRIDGE-PLAN O-1, still open).
- **O-2** Fleet-verify producers: `systemctl list-timers 'marsad-*'` on the VPS. Timers were
  paused 2026-07-17; every producer status in the docs is inferred.
- **O-3** Enable `custom_access_token_hook` in Supabase Dashboard → Auth → Hooks (blocks the
  premium cut end-to-end; prerequisite for P6).
- **O-4** Confirm `SUPABASE_SERVICE_ROLE_KEY` is set in the Vercel production environment
  (`server-admin.ts` throws without it; needed for the financials tab if D-financials picks the
  service-role route in P1.6).

---

## 3. Target architecture

```
DB (Postgres/RLS)  →  reads (src/lib/data/*.ts, `use cache`)  →  ADAPTER  →  CONTRACT  →  component
                                                                    │           │
                                              maps rows to the contract    src/lib/contracts/*
                                                                                │
                                                        sample module implements the SAME contract
```

- **Contract** = the view-model TypeScript type. Frozen. Lives in `src/lib/contracts/`.
- **Adapter** = `src/lib/data/adapters/<surface>.ts`, maps real read results → contract.
- **Sample** = `src/lib/data/sample/*`, the other implementation of the same contract.
- **Surface catalog** = `public.surfaces`, metadata only (never renders anything).

Swapping a page from sample to live becomes a one-line change in its `page.tsx`.

---

## 4. Phase plan

Merge order is the phase order. P6 is independently sequenced (see D-2).

| phase | name | unblocks | producer dependency |
|---|---|---|---|
| **P0** | Foundations + defect sweep | everything | none |
| **P1** | Real entity routes (stocks) | 705 real stock pages | none — data is live |
| **P2** | Market-data rails + calendars | home, wire, earnings | none (dividends/IPO stay honest-empty) |
| **P3** | Editorial seed + re-wire reader | home lead, wire, research, articles, analysts | seed rows (D-1) |
| **P4** | Newsroom repair: supply + guardrails | agent-written content can exist | — |
| **P5** | Newsroom craft: voice, structure, selection | content worth reading | — |
| **P6** | Auth + member surfaces | watchlist, alerts, 2FA, premium cut | owner (D-2, O-3) |
| **P7** | Remaining producers | IPO, ownership, consensus, dividends | worker fleet |
| **P8** | Hardening + doc reconciliation | launch readiness | none |

---

### P0 — Foundations and the cross-cutting defect sweep

_No visible change. Everything downstream depends on this._

**P0.1 — Freeze the contracts.** Create `src/lib/contracts/` and move every exported *type*
out of `src/lib/data/sample/*` into it, one file per surface: `ledger.ts`, `newswire.ts`,
`research.ts`, `analysts.ts`, `stock.ts`, `thesis.ts`, `calendars.ts`, `ipo.ts`, `watchlist.ts`,
`alerts.ts`. Sample modules then `import type` from contracts and export only the `SAMPLE_*`
consts. Resolve the known collisions while moving: `FinRow` (in both `stock.ts` and `ipo.ts` →
`StockFinRow` / `IpoFinRow`); `IpoPipeline` and `IpoListing` are both a type and a component
name → suffix the types `IpoPipelineData` / `IpoListingData`.
_Accept:_ `tsc --noEmit` clean; no `src/app/**` imports a type from `sample/`.

**P0.2 — Adapter skeleton + fallback.** Create `src/lib/data/adapters/` and a shared helper:

```ts
// src/lib/data/adapters/fallback.ts
export async function withSampleFallback<T>(
  load: () => Promise<T | null>, sample: T, surface: string,
): Promise<T> {
  try { const v = await load(); if (v) return v; } catch (e) { console.error(`[adapter:${surface}]`, e); }
  console.warn(`[adapter:${surface}] empty read — serving sample`);
  return sample;
}
```
Per D-7 this is transitional. Every use site gets a `// TODO(P8): retire fallback` marker so
P8.5 can find and remove them.
_Accept:_ helper exists, is unit-testable, logs on every fallback.

**P0.3 — `public.surfaces` catalog.** New migration `supabase/migrations/<ts>_surfaces.sql`
implementing the DDL in `BRIDGE-PLAN §3`: `surface_key` pk, `title`, `route_pattern`,
`route_group` enum(reader|dataroom|admin), `kind` enum(index|detail|template),
`view_model_type`, `adapter_module`, `content_model` enum(none|content_items),
`gating` enum(public|premium|member), `producer_status` enum(live|partial|pending),
`wire_readiness` enum(ready-now|partial|blocked-producer|blocked-auth), `def_backlog_id`,
`is_live`. `world_read` RLS for the anon subset. Seed one row per surface from the map in §5.
_Accept:_ migration applied; `select count(*) from public.surfaces` = number of rows in §5;
committed as a `.sql` file in the repo (see the migration-drift trap — MCP-apply alone is not
enough).

**P0.4 — Fix the broken venue codes (live bug).** Real codes are `TDWL DFM ADX QE MSX BHB`.
Sample data emits **`QSE`** (7×) and **`BK`** (4×), which resolve to nothing —
`WatchlistTable.tsx:48` builds `/stocks/QSE/QNBK`, and that 404s on the real tabs. Fix in
`sample/watchlist.ts`, `sample/analysts.ts`, `sample/calendars.ts`, `sample/newswire.ts`:
`QSE`→`QE`, `BK`→ drop the rows (Boursa Kuwait is `active:false`, not ingested) or relabel to a
covered venue.
_Accept:_ `grep -rn '"QSE"\|"BK"' src/lib/data/sample/` returns nothing.

**P0.5 — `v_analysts_public` (unblocks 1i + 1j entirely).** `public.analysts` is world-read but
has **no name and no slug**; the identity is in `iam.principals` (`handle`, `display_name`),
which is `worker_read` only. Add a migration creating a `security_invoker=false` view — the same
pattern as `v_scores_public` / `v_key_ratios_public`:

```sql
create view public.v_analysts_public with (security_invoker = false) as
select p.handle as slug, p.display_name, a.title, a.credential, a.bio,
       a.is_external, a.joined_at, a.principal_id
from public.analysts a join iam.principals p on p.id = a.principal_id
where p.is_active and p.purged_at is null;
grant select on public.v_analysts_public to anon, authenticated;
```
Do **not** expose `revenue_share_pct`. Then implement `getAnalystProfileBySlug` in
`src/lib/data/editorial.ts` (currently a documented `null` stub) against this view.
_Accept:_ as `anon`, `select count(*) from public.v_analysts_public` succeeds (0 until P3 seeds).

**P0.6 — Wire cache invalidation (currently absent, and load-bearing for a news product).**
There is **no `revalidateTag` call anywhere in `src/`**. Every `cacheTag` is declared and only
ever expires by `cacheLife`. Add `src/app/api/revalidate/route.ts` — a POST accepting a
shared-secret header (`REVALIDATE_SECRET`) and a tag list, calling `revalidateTag`. Tags already
in use: `indices freshness heatmap movers stock:{id} earnings dividends ipo filings content
newsroom articles analysts search securities fx compare holders datapoints screener`.
_Accept:_ POST with the secret + `{"tags":["content"]}` returns 200; without it, 401.
File a follow-up for the worker to call it on publish (P3.7).

**P0.7 — Determinism + stale-comment sweep.**
- `src/lib/data/wire.ts#getFilingsTodayCount` reads `new Date()` **inside** `use cache` — make
  the caller pass `todayISO`, matching the pattern already used by `getEarningsKpis`.
- `src/lib/data/markets.ts:31-33` claims `index_levels` is EMPTY; it has 4,261 rows
  (BRIDGE-PLAN O-3). Delete the comment.
- `src/app/sitemap.ts` `STOCK_SUBPAGES` omits `thesis` — add it.
_Accept:_ no `new Date()` inside any `use cache` function; `grep -rn "index_levels is EMPTY" src/` empty.

**P0.8 — Doc hygiene (AGENTS.md compliance, and the §7 ledger is now untrustworthy).**
- Delete the ~13 struck-through ✅-done rows from `§7`; remove the duplicate
  `DEF-REPO-DRIFT-STMT-EXTRACTION` (appears twice, one done, one open); prune the 2026-07-14
  "kept for one revision" block.
- Fix the free-reads contradiction: `BUILD-STATUS §6` and `FORWARD-BUILD §2` still say
  **2 reads**; owner resolved **3** on 2026-07-26.
- Update the `BUILD-STATUS.md` header date (says 2026-07-22, content runs to 07-26).
- `SCREENS-REGISTER` Batch 1 summary says 16 screens; its own tables list 14. Reconcile.
- `FORWARD-BUILD §1` says "13 of ~50 routes built"; actual is 46 `page.tsx`. Correct it.
- **Add the missing newsroom `DEF-*` rows** — see P4.0, this is the important one.
_Accept:_ `§7` contains no struck rows and no duplicate ids; free-reads reads "3" everywhere.

---

### P1 — Real entity routes: kill "every stock is Aramco"

_Owner's point #4. Highest visible impact, zero producer dependency — the data is live for 705
names today._

Current state: the stock **layout and 5 tabs** render `SAMPLE_STOCK` (Aramco) for every ticker,
while `/chart`, `/earnings`, `/dividends` are **already real** and `notFound()` correctly — and
are **not in the tab bar**, so they're unreachable. `generateStaticParams` returns exactly one
entry.

**P1.1 — Resolve the entity in the layout.** In
`src/app/(reader)/stocks/[venue]/[ticker]/layout.tsx`: call
`resolveSecurity(venue, ticker)` → `notFound()` on miss. Replace `generateStaticParams` per D-6
(prerender ~60: index constituents + top movers by `value_traded`). Restore per-entity
`generateMetadata` and the `Corporation` JSON-LD.
_Accept:_ `/stocks/TDWL/1120` shows **Al Rajhi Bank**, not Aramco; `/stocks/TDWL/9999` 404s.

**P1.2 — Header adapter.** `src/lib/data/adapters/stock.ts` — map `getStockHeader(securityId)`
(exists, currently only used by `/api/og`) → the `StockHeader` contract. Formatting belongs
here: `price` and `change` are contract *strings*, and the score chip reads `v_scores_public`
(not `scores`, which anon cannot read). Mount the orphaned live `QuoteHeader` island.
_Accept:_ header shows the real name/ticker/venue/price for 5 spot-checked tickers across 3 venues.

**P1.3 — Fix the tab bar.** `src/components/reader/stock/StockHeader.tsx` `TABS` is missing
`chart`, `earnings`, `dividends` — the three tabs that already work. Add them.
`src/components/reader/StockTabs.tsx` is an orphan duplicate carrying the correct 7-segment
set — delete it after merging its entries. Keep `Quote & Coverage` inert.
_Accept:_ all real tabs reachable by click; no orphan `StockTabs.tsx`.

**P1.4 — Overview tab.** Adapter over `getStockOverview`, `getKeyRatiosStrip`,
`getPeerComparison`, `getDividendBox` (all four exist, all four dead) → the `Overview` contract.
Honest degradation: `dividend_yield` is NULL in **all 736** `v_key_ratios_public` rows → render
`—`, not a computed guess. `aboutHtml`, `deskView`, `pros`/`cons` have **no backing column** —
keep them sample-fed behind `withSampleFallback` and file `DEF-STOCK-EDITORIAL-FIELDS`.
_Accept:_ ratios, chart, peers all real; no fabricated yield.

**P1.5 — Filings & Concalls tab.** Adapter over `getFilingsForSecurity` +
`getFilingsCountForSecurity` (both dead) → `FilingsConcalls`. `transcripts` = **0 rows** → the
concalls block renders `EmptyState awaitingFeed`. Only **374 of 14,632** filings have
`ai_summary` → show the summary when present, omit the block when not.
_Accept:_ real filings listed with working `/filings/[filingId]` links; concalls honestly empty.

**P1.6 — Financials tab.** `financial_statements` (52,277 rows) is **`worker_all` only** — no
anon path and **no reader function exists at all**. Two routes: (a) a `v_financials_public`
view exposing the free subset + `PremiumLock` for the rest; (b) a service-role read behind the
existing `PremiumLock`. **Prefer (a)** — consistent with `v_scores_public`/`v_key_ratios_public`,
and keeps the cookieless anon client (service-role in a cached reader risks leaking premium data
into a shared CDN entry). Write `getFinancialsForSecurity` in a new `src/lib/data/financials.ts`.
⚠️ **`DEF-TDWL-EPS-MAPPING` is live**: the TDWL XBRL extractor writes `net_income` into
`eps_diluted`, corrupting PE. Do not surface TDWL EPS/PE from this tab until that is fixed.
_Accept:_ real statements for a spot-checked non-TDWL name; TDWL EPS suppressed with a note.

**P1.7 — Ownership tab.** `getOwnershipForSecurity` exists and is dead, but `holders`,
`holder_positions`, `ownership_snapshots`, `company_people` are **all 0 rows**. Wire the adapter
so it lights up automatically, and ship `EmptyState awaitingFeed` today.
_Accept:_ tab renders the honest empty state; wiring proven by a fixture test, not by sample data.

**P1.8 — Register + document.** Seed the `surfaces` rows for 3a–3d; update `SCREENS-REGISTER`
status to `design-on-real-data`; narrow `DEF-STOCK-LIVE-DATA` to only what remains
(ownership, concalls, editorial fields).

---

### P2 — Market-data rails and calendars

**P2.1 — Home market rails.** In `src/app/(reader)/page.tsx`, replace the market half of
`SAMPLE_LEDGER` via `src/lib/data/adapters/ledger.ts`: `getIndexTape` → `indices`,
`getTopMovers` → `gainers`/`losers`, `getMarketState` + `getIndexTape` → `LiveMarkets`.
⚠️ **`MoverRow` has no `venueCode` field** — add it to the contract (a contract *extension* is
legal; a contract *edit to fit the DB* is not) so movers can link to `/stocks/{venue}/{ticker}`
instead of `href:"#"`.
The editorial half (lead, secondary, calls) stays sample until **P3**.
The macro row (Brent/gold/UST10Y/USDSAR) has **no source** — keep sample, file
`DEF-LEDGER-MACRO-SOURCE` (BRIDGE-PLAN O-6).
_Accept:_ indices and movers are live and clickable; 23 `href="#"` in `sample/ledger.ts` reduced
to only the editorial ones.

**P2.2 — Wire feed from filings.** `/wire` renders `SAMPLE_NEWSWIRE` today, and this
*replaced* a previously real-data-wired page. Build `src/lib/data/adapters/newswire.ts` — the
**canonical reference adapter** per `BRIDGE-PLAN §4`. Map `getWireFilings` → `feed`,
`getWireVenueFacets` + `getFilingTypeFacets` → `categories`/`venues`,
`getFilingsTodayCount` → `todayCount`, `venue_feed_status` → `connection`. The orphaned
`wire/feed.ts` already has `filingToWireItem` / `newsroomToWireItem` adapters — reuse them.
`corporateActions` and `mostRead` have no source → sample + `DEF-WIRE-CORPACTIONS`,
`DEF-WIRE-MOSTREAD`.
_Accept:_ real filings in the feed with working links; facet counts match a SQL count; the 26
`href="#"` in `sample/newswire.ts` are gone from the feed rows.

**P2.3 — Earnings calendar.** `getEarningsCalendar` / `getEarningsAhead` / `getEarningsKpis` all
exist and are dead. 9,180 rows are anon-readable. **But**: `eps_consensus`, `eps_marsad`,
`verdict` are **100% NULL** (0 of 9,180) and `report_date` is a uniform ingest stamp
(`DEF-EARNINGS-REPORTDATE`). So: wire the ledger to real rows, render `—` for the consensus and
MARSAD columns, and drop the confirmed/estimate chip to a single honest state until
`public.estimates` (0 rows) has a producer.
_Accept:_ real tickers and actuals; no fabricated consensus; day grouping documented as
unreliable until the backfill.

**P2.4 — Dividends calendar — deliberately NOT wired.** 1,229 rows exist but **0 are visible to
anon**: all sit at `state='pending_confirm'` with NULL `ex_date`. Wiring it produces a blank
page. Ship `EmptyState awaitingFeed`, keep the adapter written and tested against a fixture, and
make P7.1 (the confirmation producer) the trigger.
_Accept:_ honest empty state; adapter proven by fixture; `DEF-DIVIDENDS-CONFIRM` filed with the
row counts.

**P2.5 — IPO — deliberately NOT wired.** `ipo_offers`, `ipo_timeline_events`, `listing_debuts`
are all **0 rows**. Same treatment as P2.4; trigger is P7.2.

---

### P3 — Editorial seed + re-wire the reader (owner's point #1)

_Per **D-1(a)**: seed real rows, not TS constants. This makes the reader read the production
path today, and reduces the newsroom rebuild to a producer swap._

**P3.1 — Seed the analyst roster.** Migration + seed script creating `iam.principals` rows
(`kind='human'`, `handle`, `display_name`) and matching `public.analysts` rows (title,
credential, bio, `is_external`). Per **D-4(c)**, 4–6 desk analysts. `handle` **is** the public
slug consumed by `v_analysts_public` (P0.5).
_Accept:_ `/analysts/{handle}` resolves a real profile; unknown slug → `notFound()`.

**P3.2 — Seed analyst calls.** `public.analyst_calls` rows with `rating`, `price_target`,
`published_at`, `security_id`. The `fn_analyst_call_freeze` trigger snapshots
`price_at_publication` + `index_level_at_publication` automatically, and `call_return_pct` /
`vs_index_pct` are the leaderboard math — **the schema already models the entire 1i
leaderboard**; do not compute it in the FE.
_Accept:_ `getAnalystLeaderboard` (dead today) returns real rows with real win rates.

**P3.3 — Seed editorial content.** Hand-author 8–12 pieces as real
`content_items` + `content_blocks` rows: a mix of `WIRE`, `ARTICLE` and one `EXPLAINER`;
`status='live'`; real `slug` (via `fn_content_generate_slug`); populated `kicker`, `dek`,
`section`, `read_minutes`, `byline_chain`, `is_premium` + `premium_cut_after_block` on at least
two. Bind at least one block per piece to a real `lake.objects` row via
`content_blocks.bound_object_id` so citations render through `v_content_citations`.
**Mark every seeded row** (e.g. `byline_chain` carries `{"seed":true}`) so P5 can find and retire
them.
_Accept:_ as `anon`, `content_items` count goes 1 → 9+; every seeded piece renders at its slug.

**P3.4 — Re-wire `/research` + `/articles/[slug]`.** Un-orphan `data/editorial.ts`:
`listResearchArticles` + `getArticleSectionFacets` → `ResearchIndexData`; `getArticleBySlug` +
`getRelatedArticles` → `Article`. **Restore what the template collapse removed**: real
`generateStaticParams` over published slugs, per-article `generateMetadata`, `NewsArticle`
JSON-LD, and `notFound()` on unknown slugs. Today every slug renders the same baked sample —
shipping that against real data would emit wrong canonicals and duplicate-content SEO
(`BRIDGE-PLAN §6`).
⚠️ The premium cut is currently a **CSS mask — the full text ships in the HTML**. The real cut is
RLS-driven (`content_blocks.gated` + `jwt_tier()`), so gated blocks are simply absent for anon.
Wire the real one and delete the mask.
_Accept:_ each seeded article at its own URL with its own metadata; a gated block is **absent
from the HTML source** for anon, not merely hidden.

**P3.5 — Re-wire `/analysts` + `/analysts/[slug]`.** `getAnalystLeaderboard`,
`getCoverageBySector`, and the now-implemented `getAnalystProfileBySlug` → `CoverageDeskData` /
`AnalystProfile`. Real `generateStaticParams`, real metadata, `notFound()`.
_Accept:_ leaderboard ranks by real `call_return_pct`; profile 404s on unknown slug.

**P3.6 — Home lead + secondary + calls.** Adapter over `listNewsroomContent` (dead) →
`lead`/`secondary`, and `analyst_calls` → `calls`. The lead's `photoLabel`/`photoCaption` have
no column — either add `content_items.social_card` usage or degrade to the text-only lead.
`ops.front_page_versions` exists (0 rows) and is the *designed* home for curation — note it as
the P5.6 target rather than hardcoding selection logic now.
_Accept:_ home lead is a real article linking to a real `/articles/{slug}`; all 23
`href="#"` gone from `sample/ledger.ts`.

**P3.7 — Publish → revalidate.** Have the publish path call the P0.6 endpoint with
`["content","newsroom","articles"]`. Without this, a published piece is invisible until
`cacheLife` expires.
_Accept:_ publishing a row makes it appear on `/wire` within one request.

**P3.8 — Search + sitemap inclusion.** `fn_search` indexes only `doc_type in ('security','filing')`
— published content is **unsearchable**. Extend it to `content_items`. Wire the already-written
`listPublishedArticleSlugs` / `listPublishedWireSlugs` into `src/app/sitemap.ts`.
_Accept:_ a seeded article is findable at `/search?q=<its headline>` and present in the sitemap.

---

### P4 — Newsroom repair, part 1: supply and guardrails (owner's point #2)

_Nothing here is a writing problem. This phase makes it possible for a correct story to exist._

**P4.0 — File the missing backlog rows FIRST.** None of the newsroom's real defects has a `§7`
row, which is why it read as "done". Add, with triggers and homes (`03-agent-newsroom.md`):
`DEF-NEWSROOM-INTAKE-OFF`, `DEF-NEWSROOM-NO-VERIFIED-SUPPLY`, `DEF-RULES-R04-REGEX`,
`DEF-RULES-UNIT-NORMALIZATION`, `DEF-RULES-R04-LAKE-DRIFT`, `DEF-RULES-R03-PENDING`,
`DEF-NEWSROOM-TEMPLATE-PROMPTS`, `DEF-NEWSROOM-EDITOR-PROSE-PASS`, `DEF-NEWSROOM-DEDUP`,
`DEF-NEWSROOM-RANKING`, `DEF-NEWSROOM-BYLINE`, `DEF-NEWSROOM-BLOCK-RENDERERS`,
`DEF-FRONTPAGE-AUTOFLOW-HANDLER`, `DEF-WIRE-BRIEF-HANDLER`.
_Accept:_ 14 new rows; also clear `DEF-NEWSROOM-WIRE-SLUG-CITATIONS`, already fixed by
`20260722150000`.

**P4.1 — One number-token source of truth.** There are two regexes disagreeing about what a
number is: `MAG_RE` in `ingestion/src/rules/rules.ts:80` and `NUMBER_TOKEN` in
`ingestion/src/rules/text.ts:10`. `MAG_RE`'s `[\d,]*` swallows the trailing comma, so
"Q2 2026, revenue…" tokenizes as `"2 "` and `"2026,"` — the 4-digit year guard then fails and
**R-04 flags the year in every headline**. Delete `MAG_RE`; use `NUMBER_TOKEN` everywhere.
_Accept:_ a golden test asserts "Q2 2026, revenue up 11.2%" yields exactly one magnitude (11.2).

**P4.2 — Unit normalization layer.** The lake stores YoY growth as `0.1159`; the writer writes
`11.2%`; `parseMagnitude` compares 0.1159 to 11.2 and R-04 blocks. **Every percentage in every
story currently blocks.** Add `normalizeMagnitude(value, unitHint)` handling fraction↔percent,
scale (k/mn/bn/tn) and currency, and compare in a canonical unit.
_Accept:_ golden tests for 0.1159 ↔ "11.2%" (pass), 4.43e9 ↔ "QAR 4.43bn" (pass),
0.1159 ↔ "1.159%" (fail).

**P4.3 — Delete `findPayloadMagnitude`.** `rules.ts:130-138` scans *all* payload values and
picks whichever is numerically nearest the cited value. Recorded live result:
`{"kind":"lake_drift","live":2026,"cited":4430650000}` — it matched a **fiscal year** against a
QAR 4.43bn profit and declared drift, blocking every citation in both drafts. Replace with an
explicit `payload_path` recorded on the citation at draft time; compare only that path.
_Accept:_ `lake_drift` fires only when the *named* path actually differs.

**P4.4 — Reconcile R-03 with the lake's design.** R-03 requires `object_state='VERIFIED'`, but
`20260719175050_writer_context_pack.sql` states the lake **deliberately serves statements and
filings at `PENDING`**. Per **D-3(c)**, make the acceptable state set per-`object_type`.
_Accept:_ a citation to a `PENDING` `FILING.FINANCIALS` passes R-03; a citation to a
`PENDING` type not on the allowlist still fails.

**P4.5 — Fix the auto-marker ambiguity rule.** `automark.ts:92` attaches a key only when
*exactly one* frozen cite matches within 0.5% — so a figure stated twice yields **zero** markers
and R-03 then fires `number_without_citation`. Prefer the citation whose `claim` best matches
the sentence; tie-break deterministically rather than dropping the marker.
_Accept:_ the recorded failing dek now marks correctly; golden test covers the duplicate-figure case.

**P4.6 — Reconcile the materiality map with reality.** `ops.materiality_prefilter` has 11 rows;
5 of its 6 "material" types (`DIVIDEND.EXDATE`, `DISCLOSURE.DPS`, `EARNINGS.VERDICT`,
`IPO.OFFER`, and effectively `FILING.FINANCIALS`) describe object types that are **never
produced or never reach the required state**, while `COMPUTED.RATIOS` (736 VERIFIED) is **absent
from the table** and therefore routes to the paid LLM classifier on every ratio recompute. Add
`COMPUTED.RATIOS` as `not_material`; align the rest with what P4.7 actually produces.
_Accept:_ no VERIFIED object type is missing from the table.

**P4.7 — Build the missing object producers.** The newsroom is blind to 14,632 filings and
52,277 statements. Produce `lake.objects` of type `EARNINGS.VERDICT` (from `earnings_events`
once actuals + a consensus exist — depends on P7.3), `DIVIDEND.EXDATE` (P7.1), `IPO.OFFER`
(P7.2), and promote `FILING.REF` for market-moving filings (96 are flagged `is_market_moving`).
Use the shared `upsertLakeObject` helper (`scripts/researchers/lib/lake-objects.mjs`) — hand-rolled
read-modify-write into `lake.objects` is the race that `DEF-LAKE-OBJECTS-RACE` just fixed.
_Accept:_ ≥1 object of each type reaches the state the intake predicate accepts.

**P4.8 — Story-level dedup.** There is none. Two `FILING.FINANCIALS` objects for one company
produced two near-identical QNB stories three minutes apart (items #3 and #4). Add a unique
natural key per story trigger (`security_id` + `event_type` + fiscal period) checked before
`content_items` insert.
_Accept:_ replaying the QNB double-trigger yields one piece.

**P4.9 — Turn intake on, carefully.** Flip `pipeline_intake_enabled=true` with
`auto_publish_wires` **false** (D-5). Watch `ops.pipeline_items`, `ops.rule_violations` and
`ops.llm_runs` for one full cycle before widening.
_Accept:_ ≥5 pieces reach `approval` **without** rule blocks; LLM spend within the ladder.

---

### P5 — Newsroom repair, part 2: craft (owner's point #2, the real fix)

_P4 makes correct stories possible; P5 makes them worth reading. Today ~85% of the writer prompt
is compliance plumbing and there is **no editorial instruction in it at all**._

**P5.1 — Pass the angle to the writer.** The classifier already decides *why* a story matters
and writes `event_type`, `reason`, `confidence` to `ops.classifier_verdicts` — and
`draft.ts` **never reads it**. The writer literally does not know why the story exists. Thread
the verdict into the draft prompt as the required angle.
_Accept:_ the draft prompt contains the classifier's `event_type` and `reason`.

**P5.2 — Per-template prompt packs.** `ops.templates` has 8 rows with `block_keys[]`,
`max_words`, `always_premium`, `auto_publish_eligible` — **none of which any code reads**.
`ops.story_blocks` has 14 `BLK-*` rows naming renderer components that **do not exist**. One
`WIRE_MODE`/`STORY` line is the entire differentiation between a 40-word wire and a "Premium
Deep Dive", and `autoSelectTemplate` picks the template *after* the prose is written. Build a
prompt pack per template that reads `block_keys` and `max_words` from the registry, and select
the template **before** drafting (from the classifier's `suggested_template`).
_Accept:_ TPL-01 and TPL-08 produce structurally different pieces; template chosen pre-draft.

**P5.3 — Real editor pass.** `edit.ts` sends the editor **only the headline string** and never
the body; the design (`03-agent-newsroom.md §7.2`) specifies prose tightening + structure
enforcement + a mechanical numeric diff. Build the designed pass, with the diff asserting no
number or citation marker changed.
_Accept:_ editor receives blocks; any numeric drift between pre- and post-edit fails the stage.

**P5.4 — Structured blocks + renderers.** Every block is `kind:'text'`. Implement the block
kinds the registry already names (subhead, pull quote, table, exhibit, ticker, delta, verdict)
and their React renderers, and start setting `content_blocks.bound_object_id` — without it R-09's
premium-cut check can never pass and no block can be data-bound.
_Accept:_ a seeded and an agent-written piece both render ≥3 block kinds; citations bind to blocks.

**P5.5 — Byline and attribution.** `classify.ts:95` sets `author_id` to the **DATA-FILINGS triage
agent** — never the writer — and `byline_chain` stays `[]`. Set `author_id` to the writer agent,
build the `byline_chain` (writer → editor → approving analyst) per **D-4(c)**, and render it.
_Accept:_ a published piece shows a real byline chain; no piece is authored by the triage agent.

**P5.6 — Selection and front page.** `frontpage_autoflow` (pg_cron jobid 11) fires into
`q_maintenance` with **no handler**, and `ops.front_page_versions` has 0 live rows. Build the
handler: score newsworthiness, rank, write a versioned front-page config, flip `is_live`. Then
point P3.6's home adapter at it instead of "most recent".
_Accept:_ a live `front_page_versions` row drives the home lead.

**P5.7 — The newsletter.** Three `wire_brief` crons (jobids 5/6/7) fire into `q_email` with
**no handler** (`NEWSLETTER-1`, `03-agent-newsroom.md §10.1`). Either build it or disable the
crons — firing into a void is worse than neither.
_Accept:_ either a brief is assembled, or the crons are removed and a `§7` row records why.

**P5.8 — Quality telemetry.** `03-agent-newsroom.md §15` makes the model upgrade conditional on
"rules-fail > 15% or owner send-back > 30%" — **nothing measures either**. Build the ANALYTICS-1
rollups.
_Accept:_ a daily rollup reports rule-pass rate and send-back rate.

---

### P6 — Auth and member surfaces _(sequenced per D-2; owner-gated)_

Blocked on **O-3** (enable `custom_access_token_hook`). Schema is built and 0-rows.
Order: `PaywallModal` first (3 shipped screens already reference it) → `(auth)` route group
(6a–6e, 6l) → logged-in `MarsadNav` variant (a `user`+`plan` prop, not a second nav) →
`billing.consume_meter` wiring → Stripe (6h→6i→6j is one state machine) → per-user reads for
watchlist/alerts/notifications → gate `/watchlist` and `/alerts` → 2FA (17f) against
`auth.mfa_factors` → `search_history` (`DEF-SEARCH-HISTORY`).
Free tier is **3 reads / 3 scores / 5 AI answers** — add a **new** `billing.plan_versions` row;
never mutate v1.

---

### P7 — Remaining producers

**P7.1 — Dividends confirmation.** 1,229 rows stuck at `pending_confirm`, 0 with `ex_date`.
Find why `fn_dividend_confirm_guard` never passes; land the ex/pay-date source. Unblocks P2.4,
the 23a calendar, and `DIVIDEND.EXDATE` for P4.7.
**P7.2 — IPO producer.** `ipo_offers`/`ipo_timeline_events`/`listing_debuts` all 0. Unblocks
22a/22b/22c and `IPO.OFFER`.
**P7.3 — Consensus/estimates.** `public.estimates` = 0 rows (`DEF-ESTIMATES-AGG`). Unblocks the
8a consensus columns, the earnings BEAT/MISS verdict, `EARNINGS.VERDICT` objects, and the Score
Revisions factor.
**P7.4 — `report_date` backfill** (`DEF-EARNINGS-REPORTDATE`) — from each event's
`results_filing_id`. Unblocks true forward dates on 8a.
**P7.5 — Ownership + people** — `holders`, `holder_positions`, `ownership_snapshots`,
`company_people` all 0. Unblocks 3d.
**P7.6 — Transcripts** — 0 rows. Unblocks the concalls half of 3c.
**P7.7 — `DEF-TDWL-EPS-MAPPING`** — the extractor writes `net_income` into `eps_diluted`,
silently corrupting PE, a Value input to the Marsad Score. Fix before the screener/Score is
promoted on TDWL fundamentals.

---

### P8 — Hardening and reconciliation

**P8.1 — Rate limits + auth on public APIs.** `/api/pulse/*`, `/api/screener/run`, `/api/search`
and `/api/og` have **no auth and no rate limit**; `proxy.ts` only matches `/admin/:path*`.
**P8.2 — Nav coverage.** Desktop `NAV_TABS` (8) and mobile `NAV_LINKS` (9) are different sets:
desktop cannot reach `/markets /earnings /dividends /filings /search /learn`; mobile cannot reach
`/heatmap /research /analysts /watchlist /`. Reconcile against `surfaces`.
**P8.3 — Orphan routes.** `/ipo/[offerSlug]` (nothing links to it), `/datapoints/[seriesId]`
(only self-links), `/settings/two-factor`, `/styleguide`. Give each an entry point or mark it
intentionally unlinked in `surfaces`.
**P8.4 — Delete dead code** once its replacement is live: `data/wire.ts` if superseded,
`supabase/client.ts` (0 importers), orphaned components not adopted by P1–P3.
**P8.5 — Retire the sample fallbacks** (D-7): remove `withSampleFallback` per surface, delete the
`SAMPLE_*` const, keep the contract. Grep the `TODO(P8)` markers from P0.2.
**P8.6 — Reconcile `surfaces` with reality** and make CI assert every adapter still compiles
against its contract (the contract-drift guard, `BRIDGE-PLAN §3`).

---

## 5. Surface → source master map

Status: **READY** = data live, wire it · **PARTIAL** = wire with honest degradation ·
**BLOCKED-P** = producer empty · **BLOCKED-A** = needs auth.

| screen | route | contract | adapter / read | tables | status | phase |
|---|---|---|---|---|---|---|
| 1b Ledger (market half) | `/` | `LedgerData` | `adapters/ledger.ts` ← `getIndexTape`, `getTopMovers`, `getMarketState` | `indices`, `index_levels`, `mv_movers`, `quotes_latest` | **READY** | P2.1 |
| 1b Ledger (editorial half) | `/` | `LedgerData` | ← `listNewsroomContent`, `analyst_calls` | `content_items`, `analyst_calls` | PARTIAL → seed | P3.6 |
| 1b macro row | `/` | `MacroTicker` | — | **none** | BLOCKED-P | `DEF-LEDGER-MACRO-SOURCE` |
| 1d Newswire | `/wire` | `NewswireData` | `adapters/newswire.ts` ← `getWireFilings`, facets | `filings`, `venue_feed_status` | **READY** | P2.2 |
| 1d corp actions / most-read | `/wire` | — | — | **none** | BLOCKED-P | P7.1 / analytics |
| 1l Research index | `/research` | `ResearchIndexData` | ← `listResearchArticles` | `content_items` | PARTIAL → seed | P3.4 |
| 1k Article | `/articles/[slug]` | `Article` | ← `getArticleBySlug` (+RLS cut) | `content_items`, `content_blocks` | PARTIAL → seed | P3.4 |
| 1i Coverage Desk | `/analysts` | `CoverageDeskData` | ← `getAnalystLeaderboard` | `analysts`, `analyst_calls` | BLOCKED-P → seed | P0.5, P3.1–3.2, P3.5 |
| 1j Analyst Profile | `/analysts/[slug]` | `AnalystProfile` | ← `getAnalystProfileBySlug` | `v_analysts_public` | BLOCKED (no slug) → P0.5 | P0.5, P3.5 |
| 3a Stock Overview | `/stocks/[v]/[t]` | `Overview` | `adapters/stock.ts` ← `getStockOverview`, `getPeerComparison` | `securities`, `quotes_latest`, `v_key_ratios_public`, `v_scores_public`, `ohlcv_daily` | **READY (705)** | P1.1–1.4 |
| 3b Financials | `…/financials` | `Financials` | **new** `getFinancialsForSecurity` | `financial_statements` (worker_all → needs view) | PARTIAL | P1.6 |
| 3c Filings & Concalls | `…/filings` | `FilingsConcalls` | ← `getFilingsForSecurity` | `filings` (658 names) / `transcripts` **0** | PARTIAL | P1.5 |
| 3d Ownership & People | `…/ownership` | `Ownership` | ← `getOwnershipForSecurity` | `holders` etc. **all 0** | BLOCKED-P | P1.7 → P7.5 |
| 10d AI Thesis | `…/thesis` | `AiThesis` | **none — build** | `ai_theses` **0** (schema matches contract exactly) | BLOCKED-P | P5 / `DEF-THESIS-LIVE-DATA` |
| 8a Earnings | `/earnings` | `EarningsWeek` | ← `getEarningsCalendar` | `earnings_events` 9,180; consensus **0** | PARTIAL | P2.3 → P7.3 |
| 23a Dividends | `/dividends` | `DividendWeek` | ← `getDividendCalendar` | `dividends` 1,229 but **0 anon-visible** | BLOCKED-P | P2.4 → P7.1 |
| 22a/b/c IPO | `/ipo…` | `IpoPipelineData` etc. | ← `getIpoPipeline`, `getIpoOffer` | all **0** | BLOCKED-P | P2.5 → P7.2 |
| 1h Watchlist | `/watchlist` | `WatchlistData` | none | per-user **0** | BLOCKED-A | P6 |
| 5a Alerts / 16b Notifications | `/alerts`, nav | `AlertsData` | none | `alerts` **0** | BLOCKED-A | P6 |
| 17f Two-factor | `/settings/two-factor` | — | none | `auth.mfa_factors` | BLOCKED-A | P6 |
| 1e/1f/9a data room | `/heatmap` `/screener` `/screens` | — | live | — | **LIVE** | — |
| 16a/18a/20f | `/search` `/compare` `/learn` | — | live | — | **LIVE** | — |
| `/markets`, `/filings`, `/wire/[slug]`, `/earnings/[id]`, `/investors`, `/datapoints/[id]` | — | — | live | — | **LIVE** | — |

---

## 6. Risk register

| risk | mitigation |
|---|---|
| **Silent blanking** — wiring a surface to an empty producer replaces a beautiful page with nothing | `withSampleFallback` through P1–P3 (D-7); never wire a 0-row producer (P2.4, P2.5 are deliberately *not* wired) |
| **Template collapse → SEO damage** — 1k/1j/22b/22c currently render one baked entity for every slug; wiring without restoring `notFound()`/metadata/JSON-LD ships wrong canonicals + duplicate content | P3.4/P3.5 restore all three explicitly; acceptance criteria require a 404 on unknown slugs |
| **Contract drift** — an adapter quietly reshapes a view-model to match a DB column | Law #1; P8.6 CI guard asserting adapters compile against frozen contracts |
| **Premium leak** — the article cut is a CSS mask today; full text ships in the HTML | P3.4 replaces it with the RLS cut; acceptance requires the gated block to be **absent from source** |
| **Service-role in a cached reader** — a service-role read inside `use cache` can leak premium rows into a shared CDN entry | P1.6 prefers a public view over service-role; keep the anon client cookieless |
| **Newsroom publishes something wrong** | `auto_publish_wires` stays false (D-5); rules must measure clean before the human is removed (P5.8) |
| **Corrupt PE from `DEF-TDWL-EPS-MAPPING`** silently feeds the Score's Value factor | P1.6 suppresses TDWL EPS/PE until P7.7 |
| **Producer status is inferred, not verified** — VPS timers paused 2026-07-17 | O-2 must be answered before P4/P7 estimates are trusted |
| **Doc drift makes the ledger untrustworthy** | P0.8 + Law #4/#5; P4.0 files the 14 missing newsroom rows before any newsroom work |

---

## 7. Sequencing

```
P0 ──▶ P1 ──▶ P2 ──▶ P3 ──▶ P4 ──▶ P5 ──▶ P8
                       │
                       └────────────────▶ P7 (producers, parallel — worker fleet)
P6 (auth) ── owner-gated, independent, any time after P0
```

**Fastest path to a credible public reader:** P0 → P1 → P2 → P3. That yields 705 real stock
pages, a live wire, a live home page, real research and real analyst profiles — with no
dependency on the newsroom rebuild or on auth.

**The moat** (`FORWARD-BUILD §0` finish line C) is P4 → P5. It is the largest single body of
work in this plan and the one the owner has called out; it should not be compressed.

**Recommended first merge:** P0 + P1 together — foundations plus the single most visible fix
(705 real stock pages instead of Aramco everywhere).

# Marsad — Bridge Build Plan (backend ↔ front-end)

_Written 2026-07-26; amended 2026-07-27 (phases **PD**/**PE**, decisions **D-8…D-13**).
Executable plan for taking every front-end surface from sample-seeded to live data. Companion to
`BRIDGE-PLAN.md` (the **strategy** — the contract seam, the `surfaces` catalog, the phase idea),
`architecture/09-signal-to-article.md` (the **signal → article domain architecture**), and
`BUILD-STATUS.md §7` (the **ledger**). This document is the **execution** layer: numbered steps,
exact files, acceptance criteria._

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

### 2.0a Decisions added 2026-07-27 (signal → article planning; see `architecture/09-signal-to-article.md`)

| id | decision | options | recommendation |
|---|---|---|---|
| **D-8** | **Where does a published number come from?** | (a) the writer writes the number into prose and rules verify it after the fact; (b) the writer emits a **binding** `{block_code, object_id, field}` and the renderer reads the value from `lake.objects` at render time | **(b), and this is the load-bearing decision of the whole design.** It makes a fabricated figure *structurally impossible* rather than statistically unlikely, and makes R-07 corrections work by construction — fix the object once, every citing piece updates. (a) remains in force for inline prose numerals only, which is what R-03/R-04 are for. |
| **D-9** | **Document comprehension stack** | (a) keep `pdftotext`+tesseract+one LLM call; (b) a single hosted document-AI API; (c) tiered: deterministic first, model only on what it fails, validation mandatory | **(c).** Tier 0 LiteParse (Apache-2.0, native Node, bboxes) partitions the corpus and closes the `full_text` gap for born-digital PDFs at ~zero cost; Tier 1 PaddleOCR-VL (Apache-2.0, best-measured Arabic by 3×) handles image-only/tables/bilingual; Tier 2 repositions the existing LLM call to *map* structured tables rather than read digits; Tier 3 validates against XBRL. **marker/surya/Chandra are licence-blocked** (output-restricting OpenRAIL-M with a competing-product clause); Nougat is CC-BY-NC. |
| **D-10** | **Intake eligibility** — supersedes and sharpens **D-3** | (a) promote to VERIFIED; (b) accept PENDING broadly; (c) per-`object_type` state set **+ a provenance floor** | **(c).** D-3 already chose (c); ground truth now shows (a) is *not implementable* — researchers bypass `lake.staging_rows` entirely, so cross-check has nothing to gather and VERIFIED is structurally unreachable for every fundamentals object. Pair the broadened state with a provenance floor: allowlisted type **+** `parse_runs` lineage to bytes we still hold **+** passed Tier-3 validation. That is a *stronger* guarantee than "two scrapers agreed". |
| **D-11** | **Block vocabulary** | (a) grow `ops.story_blocks` organically as renderers land; (b) freeze all 61 from the design handoff up front, renderers to follow | **(b).** The registry is the refusal surface — the fit stage can only reject "block not permitted for this piece type" if the full vocabulary and its family permissions exist as data. Renderers land family-by-family behind it (G → A+C → D → B,E,F,H). |
| **D-12** | **Chart contract** | (a) agent emits a Vega-Lite spec; (b) agent emits `{shape, series[], caption}` and a deterministic compiler produces the spec | **(b).** A chart spec *is* layout, so (a) violates our own rule. The compiler owns the house theme — plus **SVG for web, PNG for email**, because Outlook retired inline SVG in late 2025. The design's D family is question-indexed ("WHAT MOVED IT?" → waterfall), so the agent picks a *question*. ⚠️ **Corrected 2026-07-27 (PD.3):** this decision originally said "six enum values", written before the block library was parsed. The design does **not** have one generic chart block with six shapes — it splits charts into **15**, one per question, and that split is the most useful thing the design gives an agent. The vocabulary is those 15, closed, each block pinning its own via `z.literal`; still trivially constrainable, still never a spec. |
| **D-13** | **Adopt a document/content format or CMS?** | (a) Portable Text / ProseMirror / MDX / a headless CMS; (b) keep rows in Postgres | **(b) — adopt nothing.** `content_blocks` rows already give per-block RLS (which is how the premium cut physically works), an FK target for `lake.citations`, and per-block revalidation. Borrow exactly two conventions: a stable `_key` per block, and `@portabletext/react`'s "unregistered kind is loud but non-fatal at render" posture. **MDX is disqualified** — it compiles to executable JS and `next-mdx-remote` 4.3.0–5.0.0 carries CVE-2026-0969 (RCE during SSR of untrusted MDX). Agent output is untrusted input. |

### 2.1 Owner-blocked items (cannot be executed by an agent)

- **O-1** Confirm `yjsncnpbjuueaoeejrqj` is the production project (BRIDGE-PLAN O-1, still open).
- **O-2** Fleet-verify producers: `systemctl list-timers 'marsad-*'` on the VPS. Timers were
  paused 2026-07-17; every producer status in the docs is inferred.
- **O-3** Enable `custom_access_token_hook` in Supabase Dashboard → Auth → Hooks (blocks the
  premium cut end-to-end; prerequisite for P6).
- **O-4** Confirm `SUPABASE_SERVICE_ROLE_KEY` is set in the Vercel production environment
  (`server-admin.ts` throws without it; needed for the financials tab if D-financials picks the
  service-role route in P1.6).
- **O-5** **Unblock GitHub Actions billing.** Every CI run since 2026-07-18 aborts in 3–5 s with
  *"The job was not started because recent account payments have failed or your spending limit
  needs to be increased"* — so **P0–P3 all landed with tsc / lint / next build / worker tsc /
  migration-ledger / RLS assertions unverified**. Running those jobs locally before pushing PE.0
  immediately surfaced a gate that had been red since 2026-07-20
  (`DEF-RLS-GATE-RED-SINCE-0720`). Until this is fixed, **the local gate run is the verification**,
  and it must be run deliberately — a green push means nothing.

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
| **PD** | **Block & template system** | 61 blocks render; the fit stage can refuse | **none** — front-end + registry; runs parallel to P1–P3 |
| **PE** | **Signal enrichment: comprehension + eligibility** | **P4 at all** — gives the newsroom something to write about and something that can trigger it | none (25 GB of bytes are already stored) |
| **P4** | Newsroom repair: supply + guardrails | agent-written content can exist | **PE** |
| **P5** | Newsroom craft: voice, structure, selection | content worth reading | PE, PD |
| **P6** | Auth + member surfaces | watchlist, alerts, 2FA, premium cut | owner (D-2, O-3) |
| **P7** | Remaining producers | IPO, ownership, consensus, dividends | worker fleet |
| **P8** | Hardening + doc reconciliation | launch readiness | none |

> **PD and PE were added 2026-07-27.** They are *inserted*, not renumbered — every existing
> `P{n}.{step}` id stays valid; P4 and P5 are amended in place (§P4.10–P4.12, §P5.9–P5.11).
> Rationale and full architecture: [`architecture/09-signal-to-article.md`](architecture/09-signal-to-article.md).

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

### PD — Block & template system _(parallel to P1–P3; no producer dependency)_

_Owner's point #4. The design system is stored in `docs/design/`; this phase turns it into a
runtime registry, renderers, and a refusal surface. It pays off before the newsroom produces
anything, because it also fixes how the P3 seeded content renders._

**PD.0 — The assets are stored (DONE 2026-07-27).** `docs/design/artifacts/` holds the 61-block
library and the 4 longform templates verbatim; `docs/design/block-registry.json` (61 blocks ×
8 families) and `docs/design/article-templates.json` (4 templates + chassis) are the
machine-readable extraction; `docs/design/README.md` is the consumption contract.
_Accept:_ ✅ `jq '.blocks|length' docs/design/block-registry.json` = 61; `.templates|length` = 4.

**PD.1 — Extend the registry schema.** Migration adding to `ops.story_blocks`: `family text`,
`family_name text`, `allowed_piece_types text[]`, `binding_rule text`, `payload_schema jsonb`,
`requires_binding boolean not null default false`, `constraints jsonb`, `rule_id text`,
`schema_version int not null default 1`. New `ops.article_templates` (`id`, `name`,
`access_tier`, `block_keys text[]`, `allowed_families text[]`, `section_sequence jsonb`,
`writer_metadata_fields jsonb`, `hard_rules jsonb`). Keep `ops.templates` (TPL-01…08) — it is the
*pipeline* template axis and is FK'd from four places; `ops.article_templates` is the *layout*
axis (1a/1b/3a/3b). Document the two-axis split in `02-data-lake.md §10`.
_Accept:_ migration applied **and committed as a `.sql`** (the MCP-apply drift trap); ledger reconciled.

**PD.2 — Seed 61 blocks + 4 templates from the JSON.** A generator script reads
`docs/design/*.json` and emits the seed migration, so the JSON stays the single source and drift
is a diff. Grandfather the existing 14 rows by `key` (do not delete — `lake_object_type` and
`consuming_templates` on them are already correct).
_Accept:_ `select count(*) from ops.story_blocks` = 61; every pre-existing key retained with its
`lake_object_type` intact.

**PD.3 — Payload schemas in Zod.** `src/lib/blocks/schemas/*.ts`, one Zod v4 schema per block,
`z.toJSONSchema()` → `ops.story_blocks.payload_schema`. Zod is the source; the DB column is the
projection. (Not `zod-to-json-schema` — unmaintained since Nov 2025.)
_Accept:_ every block with `requires_binding` has a schema whose binding field is required;
a CI check asserts DB `payload_schema` matches the emitted schema.

**PD.4 — Fix the live renderer bugs first. ✅ DONE 2026-07-27.**
`adapters/research.ts` matched `"pullquote"` while the DB holds `"pull_quote"`, and did not match
`"heading"` at all — so every heading and pull quote in every seeded article rendered as a plain
paragraph. Fixed by **normalising** the kind (`toLowerCase()` + strip non-alphanumerics) rather
than matching more literals, since `block_kind` is unconstrained `text` written by three producers
that disagree on spelling — a new spelling now degrades to prose instead of re-opening the bug.
Added `heading` to the `ArticleBlock` contract (a contract **extension**, legal under Law #1) and
rendered it at the design's `measure > section_subhead` spec — Newsreader 25px/700. Also moved the
drop cap from "index 0" to "the first **prose** block", so a piece opening with a heading still
gets one.
_Accept:_ ✅ `/articles/alba-quadrupled-its-first-quarter-profit-the-stock-is-down` renders
`p, p, div[pullquote: border-left 3px, italic], p, h2[25px/700], p, p` — matching its stored block
sequence exactly; `tsc --noEmit` and `eslint` clean; console clean.
⚠️ Found while verifying: the seeded `EXPLAINER` 404s at every route — `DEF-EXPLAINER-UNROUTED`,
picked up at PD.5.

**PD.5 — Block renderers, family order G → A + C → D → B, E, F, H.** Create
`src/components/blocks/` (does not exist today; `ops.story_blocks.renderer_component` names 14
components, **none of which exist**). G first — provenance, freshness and estimate markers are
prerequisites for every other family's footer. Unregistered block code = **loud, logged,
non-fatal** at render; the *publisher* hard-refuses, not the renderer.
_Accept:_ per family, a fixture story renders every block in it; visual diff against
`docs/design/artifacts/artifact-library-61-blocks.html`.

✅ **G, A, C shipped 2026-07-27 (20 of 61).** `src/components/blocks/` now exists: a
`Record<BlockCode, Component>` registry (`registry.tsx`) over the full 61-code union, with the 20
built codes typed per-payload and everything else resolving to `MissingBlock` — loud (amber dashed
marker), logged (`[blocks] …` on server and client), non-fatal. Hard rule 3 is centralised in
`constraints.ts` (`estimateLabel`/`estimateHeaderClass`/`estimateValueClass`), so the agent supplies
only `is_estimate` per period and the renderer owns the E suffix, the ink header and the bold value.
Hard rule 1 is enforced by `directionTextClass` being the only path to green/red. Missing bound
values render `—`, never a substitute figure. Fixture surface: **`/styleguide/blocks`**, verified at
1440px against the library file.
Remaining: **D** (blocked on PD.6), then **B, E, F, H** — 41 blocks.

**PD.6 — The chart compiler (D-12).** `src/lib/blocks/chart-compiler.ts`: `(shape, resolved
series) → themed Vega-Lite spec`. Web renders SVG; email/social render **PNG** via
`@resvg/resvg-js` (MPL-2.0, prebuilt napi binaries incl. linux musl — no node-gyp, no cairo).
⚠️ Do **not** add `vega-cli`: it declares `node-canvas` as a dependency, which means cairo/pango
system libs and a native build on the VPS. Use the `vl-convert` CLI as a subprocess, or `vega` +
canvas only if measured to be fine.
_Accept:_ one spec produces byte-stable SVG and PNG; the 15 D-family shapes each have a golden test.

**PD.7 — Stable block keys.** Add `content_blocks.block_key text` (opaque, stable) so citations
and corrections bind to block **identity** rather than `seq`, which reordering invalidates.
Backfill from `seq` for existing rows.
_Accept:_ reordering a piece's blocks leaves every citation resolving.

**PD.8 — The fit stage (the refusal surface). ✅ BUILT 2026-07-27 — switched OFF pending one
migration.** `worker/src/handlers/newsroom/fit-engine.ts` (pure, deterministic, no LLM) +
`fit.ts` (the `pipeline_fit` handler): resolve codes → check **piece-type** permission → check
binding → numeric-consistency over prose → apply per-block constraints → place the premium cut
(R-09) → **refuse on any failure**, never degrade. The first code in the repo that reads
`ops.templates` / `ops.story_blocks` — `max_words` and `always_premium` are now *read*, not
re-declared.

⚠️ **The plan said "family permission via `ops.article_templates.allowed_families`" and that column
does not exist — deliberately.** Permission lives on the **block**: join
`article_templates.piece_type` against `story_blocks.piece_types` (`{ALL}` = unrestricted, 39 of 61).
The four exported longform pages are specimens — only 2/2/1/4 blocks are stated on them — so a
template-derived family list would refuse a chart in a Feature. `'AI'` is an orthogonal piece type
(`BLK-CITE`, `BLK-FALSIFY` are "AI · NOTE"), so an agent-authored piece carries it *in addition to*
its layout type; without that, the block the design makes mandatory on every AI factual claim would
be refused on every agent-written feature.

⚠️ **Wiring is switch-gated, not merged-in.** `fit` is not a legal `ops.pipeline_items.stage` value
and `ops.fn_transition` hard-codes adjacency, so the DDL lives at
`worker/src/handlers/newsroom/fit-stage.sql` — **written, NOT applied, and deliberately not in
`supabase/migrations/`** (two other agents held `supabase/migrations.ledger` in the same worktree; a
.sql the ledger cannot see is a red CI for them). It adds the stage value, the `rules → fit → …`
adjacency, `ops.fit_reports`, and the `newsroom_fit_stage` switch **off**. `switchOn()` reads a
missing key as false, so the rules stage keeps its existing routing until the migration lands.

_Accept:_ ✅ a piece emitting `BLK-INFOGRAPHIC` is refused `FIT-BLOCK-UNKNOWN` naming the code;
✅ `BLK-FINTABLE` (DEEP DIVE · NOTE) on a WIRE is refused `FIT-BLOCK-PIECE-TYPE` naming both sides;
✅ a `requires_binding` block with no citation is refused `FIT-BIND-UNCITED`; ✅ prose saying 12.4%
against a bound object holding 12.1% is refused `FIT-NUMBER-MISMATCH` naming both values, the
source path and the 0.5% tolerance. 32 tests, `tsc --noEmit` clean, worker suite 57 → **89/89**.
**Live finding:** dry-run against pipeline item #7 (the only agent-written piece that is live)
refuses it twice — "QAR 4.22bn" and "11.2%" are backed by nothing in the object they cite; R-04
missed them because it only requires *one* magnitude per marked sentence to match.

---

### PE — Signal enrichment: comprehension and eligibility _(hard prerequisite of P4)_

_Owner's points #1 and #2. Today 14,409 filings carry a `pdf_storage_key` and **374 (2.6%) have
any text**; TDWL RESULTS is 7,133 PDFs with zero. The lake holds numbers and no meaning._

**PE.0 — Close the enqueue gap. ✅ DONE 2026-07-27** (`20260727113000_filing_extract_enqueue_gap`,
`20260727114500_filing_extract_sha_index_nonpartial`).

Ongoing enqueue is a **trigger on `public.filings`**, not edits to six researcher scripts —
deliberate, because the researchers run from the VPS's own checkout, so a code change there is
inert until someone pushes *and* pulls (the trap `DEF-LAKE-OBJECTS-RACE` is still open on). One
place, every producer, cannot be skipped by a stale deploy.

⚠️ **The plan's "~20 lines" was wrong**, and the reason is worth carrying forward: the queue's
`content_sha256 not null unique` identity does not hold for the corpus it now has to serve.
**9,251 rows (TDWL + QE) have no content hash anywhere** — not in the column, not in the key. The
fix makes `pdf_storage_key` the natural key and `content_sha256` an optional attribute, deduping
the backfill on `coalesce(pdf_sha256, pdf_storage_key)`. Two identities, and neither subsumes the
other: 44 storage keys repeat across 123 filing rows (same document announced twice, never across
two securities), while 9 shas appear under two different keys (same bytes, two archive paths).
Both collapse to one extraction. Filed `DEF-FILINGS-NO-CONTENT-HASH` for the underlying gap.

_Accept:_ ✅ pending **0 → 13,947**; TDWL **0 → 7,133**, QE **0 → 2,118**, BHB **0 → 366**;
0 stored-and-unextracted filings left unqueued; the 374 `done` rows preserved; drain order is
value-first (9,251 TDWL+QE RESULTS ahead of 4,696 others, verified against the extractor's
`order by enqueued_at`); the `public.filings` trigger fires on a new storage key (probed in a
self-rolling-back transaction, delta=1, no leaked rows); 57/57 worker tests pass.

⚠️ **Live-breakage caught pre-commit:** the first cut made the sha index *partial*, which silently
invalidated `filings-detail-poll.ts`'s `on conflict (content_sha256)` — `ON CONFLICT` cannot infer
a partial index, so the MSX/ADX/DFM detail chain would have started raising 42P10 on every new PDF.
Found by probing the exact statement shape. The follow-up migration restores a plain unique index
(Postgres treats NULLs as distinct, so the partial predicate was never needed), and the handler
moved to an untargeted `on conflict do nothing` so it is robust against **both** indexes.
Migration versions re-stamped live to match the committed filenames
(`supabase/reconcile/20260727_reconcile_migration_ledger.sql`) — the MCP-apply drift trap, caught
by `scripts/check-migration-ledger.mjs` before commit.

**PE.1 — Tier 0 triage.** 🔶 **PROBED 2026-07-27; the sizing question is answered, the VPS run is not.**

Tool verified, not assumed: `@llamaindex/liteparse` **v2.9.0, Apache-2.0**, napi prebuilds for
darwin-arm64 / linux-x64-gnu / **linux-x64-musl** / linux-arm64 / win32 — no node-gyp, no system
deps. Per text item: `text, x, y, width, height, fontName, fontSize, fontWeight, confidence,
rotation, words[]` — the page+bbox provenance `BLK-PROV` binds to.

**Measured on a 26-doc stratified sample across all six venues (1,120 pages), OCR off** — full
table in `architecture/09-signal-to-article.md §2.6`:

- **86% of pages already carry a text layer.** Tier 1 is a ~14% minority, not the bulk. TDWL scores
  the *highest* text rate (97%) — those 7,133 filings were never image-only, **just never
  extracted**.
- **Corpus ≈ 454,000 pages** (10,529 pending PDFs × 43.1 pages/doc). The prior estimate assumed
  ~8 pages/doc — the truth is **5× that**, and it drives every cost number.
- **536 pages/s** single-threaded on an M-series Mac ⇒ the whole corpus is ~2–4 h even at 10–20×
  slower. ⚠️ **Still unmeasured on the 4-core Hetzner box — that remains this step's gate.**
- **8,610 markdown table rows recovered from 1,120 pages with no model at all.**
- Cost consequence: Tier 1 over ~63,600 pages ≈ **$2–8**, not the ~$105 GPU figure (which was sized
  against both the wrong page count and the wrong assumption about how many pages need a model).

⚠️ **The probe caught a live trap:** `pdf_storage_key` is **not always a PDF** — TDWL archives XBRL
**HTML** under it, **3,418 of the 13,947 rows PE.0 enqueued (24.5%)**. The extractor checks a
`%PDF-` magic header and would mark every one permanently `failed`. They belong to
`tadawul-xbrl-replay.mjs`'s lane. Migration `20260727124500_filing_extract_content_kind.sql` is
written and tested but **NOT APPLIED** — the live DB exhausted its direct-connection slots
mid-apply. Held uncommitted so the repo never runs ahead of live. See `DEF-EXTRACT-HTML-LANE`.

**The runner is written and DB-verified (2026-07-27):** `scripts/researchers/tier0-triage.mjs` +
`tier0-triage-cron.sh` + `systemd/marsad-tier0-triage.{service,timer}` (20 min cadence),
`@llamaindex/liteparse` added to `worker/package.json` (lockfile carries the linux-x64 **gnu and
musl** prebuilds — no node-gyp, no system deps). Migration `20260727134500_filing_extract_tier0`
applied: the queue becomes a two-stage pipeline
(`pending → text_ready → done`, with `needs_ocr` branching to Tier 1) plus per-document triage
telemetry and the `ops.v_tier0_coverage` view that answers "does 86% hold across all 10,528?".

**Safe-rollout property, chosen deliberately:** the *deployed* `filing-extractor.mjs` claims
`state='pending'`. Once Tier 0 runs, those rows sit at `text_ready`, which the old extractor does
not match — so the paid `claude -p` lane **idles instead of racing or double-charging**, until the
updated extractor is deployed. The updated one claims `text_ready` and **reuses `full_text`**
rather than re-downloading ~1.5 MB per document (~16 GB of needless egress corpus-wide).

Verified without a VPS: module parses and both dynamic imports resolve; the Tier-0 and Tier-2 claim
predicates run against live (400 and 0 claimable respectively — correct); and the full write path
was exercised on a real queue row inside a self-rolling-back transaction — queue → `text_ready` with
`pages=74, digital_pages=67, text_chars=59790`, `filings.full_text`/`pdf_pages`/`pdf_sha256` all
written, zero residue.

**✅ DEPLOYED AND BENCHMARKED 2026-07-27.** `/opt/marsad` pulled `a83fb52` → `c181a86`;
`@llamaindex/liteparse` installed (`linux-x64-gnu` prebuild, loads); units installed;
`marsad-tier0-triage.timer` **enabled and active** at 20 min.

First supervised run — **this is the acceptance gate**:

```
claimed 400 (max 400, conc 3)
DONE 420s | text_ready 318 | needs_ocr 80 | failed 0 | retry 0
        | pages 22791 (81% with text) | sha backfilled 398 | 595MB | 54.2 pages/s
```

**Three published numbers were wrong and are corrected here:**

| | claimed | measured |
|---|---|---|
| the box | "4-core Hetzner" | **2 vCPU** (`nproc` = 2, 3.8 GB) |
| pages/doc | 43.1 (26-doc sample) | **57** (22,791 / 400) ⇒ corpus ≈ **600k pages**, not 454k |
| throughput | 536 pages/s (M-series) | **54.2 pages/s** — 10× slower, inside the predicted 10–20× band |

Holding up: **81% of pages carry text** across all triaged docs (90.2% within the `text_ready`
subset; the two differ because the 81% includes image-only documents at 0%) — against the 86%
sample estimate. **Zero failures, zero retries** over 400 documents. 1.49 MB/doc egress ⇒ ~15 GB
corpus-wide, matching the ~16 GB projection.

**398 of 400 rows had `pdf_sha256` backfilled in the same pass** — `DEF-FILINGS-NO-CONTENT-HASH`
is closing itself as Tier 0 walks the corpus, at zero extra I/O, exactly as designed.

Runway: 10,082 pending at 400/run × 72 runs/day ⇒ the corpus completes in **~9 hours**, ~3.1 h of
which is actual compute. `needs_ocr` is accumulating the Tier-1 backlog (80 of 398 docs, 20%).

_Remaining to accept:_ let the timer walk the corpus; confirm `ops.v_tier0_coverage` holds ~81%
across all six venues (only QE has been sampled at scale so far — it drains first by the value
ordering); `full_text` coverage rises from 2.6% toward the born-digital share.

**PE.2 — The bake-off (the highest-value experiment in this plan).** 100 real GCC filings,
including bilingual ones, through PaddleOCR-VL-1.6 vs docling vs DeepSeek-OCR-2, **scored against
our existing XBRL** (TDWL + QE) — we already own the labels. Also settle two open facts: whether
Novita serves PaddleOCR-VL **1.6** or the base model (its id is the base name; base is
94.18/90.65 TEDS vs 1.6's 96.34/94.76), and 1.6's **Arabic** performance (unmeasured; only the
base model's 0.122 edit distance is published).
_Accept:_ a scored comparison on our own documents with a per-tool table-accuracy number; a
decision recorded in `09-signal-to-article.md §2.5`.

**PE.3 — Tier 1 + Tier 2 in the extractor.** Route image-only pages, table-bearing born-digital
pages and **all** bilingual pages to the chosen model; reposition the existing `claude -p` call to
map already-structured tables (never to read digits). Respect the licence gate (D-9):
marker/surya/Chandra/Nougat are blocked.
_Accept:_ a TDWL RESULTS PDF yields structured income/balance/cashflow tables with page+bbox per
cell; the model never sees a page Tier 0 already handled.

**PE.4 — Tier 3 validation, mandatory.** Arithmetic identities (reuse the QE Islamic-bank/Takaful
three-taxonomy balance-sheet validator), XBRL cross-reconciliation as the scoring harness, and
two-model disagreement quarantine. **Never publish an unvalidated number** — prefer `NULL` plus a
provenance pointer, which is `BLK-CONFLICT`'s stated behaviour.
_Accept:_ a deliberately corrupted fixture is quarantined, not published; the XBRL-scored accuracy
number is recorded and tracked over time.

**PE.5 — New object families.** `DOC.PAGE`, `DOC.TABLE`, `DOC.SECTION` from PE.1–PE.3; then
`DISCLOSURE.DPS`, `FILING.SEGMENT.*`, `GUIDANCE.*` from Tier 2. ⚠️ `lake.objects.object_type` has
**no CHECK, no enum, no FK** — a new type is never rejected, it is **silently invisible**, because
every consumer is an exact string match. The registration checklist is: producer (Lane A mapper +
discriminator, or Lane B researcher) → `LIVE_LATEST_TYPES` / `isDividendKey` / `price_sensitive`
decision → `lake.fn_*_project()` + **two** triggers (INSERT *and* UPDATE) → target-table CHECK
widening → `ops.materiality_prefilter` row (absent ⇒ every object burns an LLM classifier call) →
`ops.templates` / `ops.story_blocks` binding → **`lake.fn_writer_context` top-level key** (it is a
hand-written jsonb literal; a new type is invisible to the writer without it) → cron `ops.beat` →
`ops.check_worker_function_grants` allow-list → docs. Copy `FINANCIALS.XCHECK` (full treatment) or
`DIVIDEND.EXDATE` (the 57-line minimum).
_Accept:_ ≥1 object of each new type flows end-to-end to a projection **and** appears in the
writer context pack.

**PE.6 — Intake eligibility (D-10).** Change `lake.fn_verified_enqueue` to a per-`object_type`
acceptable-state set plus the provenance floor: allowlisted type **+** `parse_runs` lineage
resolving to bytes we still hold **+** passed PE.4 validation. Keep R-03's
`distinct_lineage_roots >= 2` as the **auto-publish** gate — the intake gate and the auto-publish
gate are different bars, and conflating them is what produced D-3's confusion.
_Accept:_ a PENDING `FILING.FINANCIALS` with lineage enqueues; a PENDING object of a non-allowlisted
type does not; a PENDING object whose snapshot was purged does not.

**PE.7 — The human-confirm path for price-sensitive objects.** `fn_object_state_guard` requires a
**human** `verified_by` when `price_sensitive` — and **no code implements it**; the guard exists and
waits. One RPC mirroring `ops.desk_decide_approval`'s guard shape (capability check, `FOR UPDATE`,
audit row) plus a Desk queue view. Without this, `BLK-EXDATE`, `BLK-COUNTDOWN` and the entire
dividend wire class can never publish, regardless of P7.1.
_Accept:_ an owner confirms a `DIVIDEND.EXDATE` object; it reaches VERIFIED with a human
`verified_by` and enqueues; a non-human actor attempting the same raises.

**PE.8 — Register the HuggingFace provider. ✅ CODE COMPLETE 2026-07-27 — needs a token to switch on.**

Driven by a bottleneck that moved during PE.1: Tier 0 reads ~1,200 docs/hour, Tier 2 (the semantic
pass) does **12 per 45 min = 384/day**, and every one is a `claude -p` call on the metered seat.
The `text_ready` queue was 1,272 and climbing. Raising `EXTRACT_MAX` alone just buys the same
problem in seat spend, so the fix is to move the pass onto cheap open-weight inference first.

- `huggingface` is a fourth provider: base `https://router.huggingface.co/v1`, `Bearer` auth,
  keys `LLM_HUGGINGFACE_API_KEY` / `HUGGINGFACE_API_KEY` / `HF_TOKEN`, optional
  `LLM_HUGGINGFACE_BILL_TO` → `X-HF-Bill-To` (sent only when set — an empty value is rejected).
- **Every default model is provider-pinned** (`openai/gpt-oss-20b:novita`). Not stylistic:
  `supports_structured_output` varies by *(model, provider)* for the same model, and the router
  defaults to `:fastest`. An unpinned id works until the router reroutes to an upstream that cannot
  honour `response_format` — which reads as a model regression, not a routing change. The pin
  survives because `parseModelSpec` splits on the **first** colon only.
- `filing-extractor.mjs` now calls `chatComplete('summarizer', …)` with a real **JSON Schema**
  (`strict: true`) instead of a prose contract — a quality gain the `claude -p` path could not
  have. Spend lands in `ops.llm_runs`, which `claude -p` bypassed entirely, so the budget ladder
  can finally see this lane.
- **Safe rollout, same posture as Tier 0/2:** gateway first, `claude -p` on any unavailability, and
  `gatewayDown` latches so an outage costs one probe per run rather than one per document. With no
  token configured it behaves exactly as it does today.

⚠️ **Fixed en route — the budget ladder was blind.** `pricing.ts` returned `cost_usd = 0` for any
model absent from `PRICE_TABLE`, so `ops.newsroom_budget_state` read a newly-configured model as
free spend: the ladder stopped working precisely when it was needed, with only a console warning.
Unpriced models now charge a **pessimistic** Sonnet-tier fallback — over-counting is recoverable,
under-counting is not — and lookup strips the `:provider` pin (scoped to huggingface, because
Ollama tags legitimately contain colons).

_Accept:_ ✅ 10 gateway tests, ingestion 577/577, worker 89/89, tsc + eslint clean.
✅ **LIVE 2026-07-27.** Token configured, `EXTRACT_MAX` raised 12 → 60 **via `worker.env`, not by
editing the cron script** — a `sed` inside `/opt/marsad` dirties the git checkout and breaks the
next `git pull --ff-only` (the wrapper sources `worker.env` *before* applying its `:-12` default,
so config wins and survives pulls).

Two consecutive 60-document runs, the first of which hit a real outage mid-flight:

| | 13:04 — free credits exhausted | 13:35 — after top-up |
|---|---|---|
| duration | 885s | **292s** |
| via gateway | 8 ($0.0060) | **59 ($0.0503)** |
| via claude | 52 | **0** |
| failed | 0 | 0 |

**$0.00085/doc measured** ⇒ ~$2 for the standing Tier-2 queue, **~$8.50 for the whole corpus**,
~$0.05/day steady state. And **3× faster** on the gateway — the metered seat was the slow path,
not the model.

⚠️ **The free tier is $0.10/month and we exhausted it in one afternoon** (HTTP 402
`"You have depleted your monthly included credits"`). The failure behaved exactly as designed: the
402 classified as *transient*, `gatewayDown` latched so it cost one probe rather than one per
document, the run fell back to `claude -p` and still extracted all 60, and the attempts rollback
meant **zero rows burned toward the 3-strike cap**. A new lane degrading to the old one — tested by
a real outage within an hour of shipping.

Also fixed here: the fallback chain is pinned **inside** HuggingFace
(`LLM_ROLE_SUMMARIZER_FALLBACK=huggingface:openai/gpt-oss-120b:novita`). The built-in default ends
at `anthropic:claude-haiku-4-5` and `ANTHROPIC_API_KEY` is set in the same env file, so an HF
outage would have silently billed the metered Anthropic API instead of degrading to the free seat.
`ops.llm_runs` shows that path has been taken before (`degraded: true` on an older editor call).

**PE.8 (original scope) — Register the HuggingFace provider.** Add `huggingface` to `PROVIDER_NAMES` (base
`https://router.huggingface.co/v1`, `Authorization: Bearer`, optional `X-HF-Bill-To`). Four traps,
all load-bearing: **(a)** the gateway appends `/chat/completions` to the base — correct for the
auto-router, **wrong for pinned-provider routes** (Novita's is `/v3/openai/chat/completions`), so
pin via the *model string*, never by rewriting the base URL; **(b)** there is **no
`/v1/embeddings`** on the auto-router; **(c)** `supports_structured_output` varies by
*(model, provider)*, so pin the provider for every JSON role; **(d)** unauthenticated errors return
**HTML**, so guard `res.json()` on non-2xx. Plus one trap in our own code: **`pricing.ts` returns
`cost_usd = 0` for unknown models** with only a one-time warn — add a price row per configured
model or the budget ladder silently reads $0.
_Accept:_ a role routed to HF completes, returns strict JSON, and writes a **non-zero** `cost_usd`
to `ops.llm_runs`.

---

### P4 — Newsroom repair, part 1: supply and guardrails (owner's point #2)

_Nothing here is a writing problem. This phase makes it possible for a correct story to exist._

> **Amended 2026-07-27.** P4 is now gated on **PE**. Two of its original premises were wrong:
> **P4.7's "promote `FILING.FINANCIALS`/`FILING.REF` to VERIFIED" is not an available operation** —
> researchers bypass `lake.staging_rows`, so cross-check has nothing to gather (see D-10); and the
> **96 filings flagged `is_market_moving` are a measurement of the 374 documents the extractor
> processed**, not of the corpus, because the extractor sets that flag. Steps P4.10–P4.12 below are
> new.

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

**P4.10 — Fix the citation allow-set (a terminal-failure bug, added 2026-07-27).**
`draft.ts:156-170` `idsInPack()` collects **string** values under `source_object_id`, `row_id`,
`object_id`, `source_filing_id` — but in `lake.fn_writer_context` `row_id` and `source_filing_id`
are **bigints**, so only statement `source_object_id` survives. **The `price`, `ratios`, `score`,
`identity` and `filings` sections carry no citable id at all**, so any draft citing a share price,
a P/E or the Marsad Score is rejected as "invented" and sent terminally to `reassigned_human` —
which is how both recorded real drafts died. Fix by having the *server* construct the allow-set
alongside the pack (P5.9 removes the class entirely), not by widening the JSON walk.
_Accept:_ a golden test asserts a draft citing `price.quote.last` passes; the allow-set is built
from a typed structure, not by walking untyped JSON.

**P4.11 — `q_pipeline` concurrency contradicts its own contract.** `consumer.ts:22-27` states LLM
stages "must stay one-at-a-time at vt 600", but `q_pipeline` is the batching queue —
`pipelineReadQty` 25, `pipelineConcurrency` 12 — and newsroom LLM stages share it with
`cross_check`. Either honour the contract for the LLM handlers or amend the comment and the
`03 Revisions #2` claim it cites. Do not leave the code and its stated invariant disagreeing.
_Accept:_ the comment and the behaviour agree; whichever way it is resolved is recorded.

**P4.12 — Make the registry load-bearing.** `ops.templates` and `ops.story_blocks` have **zero
readers in the entire repo** (verified by exhaustive grep over every table *and column* name); all
four policy values are re-hard-coded in three or four places each — `max_words` 40 appears as
`AUTO_WORD_CAP_DEFAULT`, as a literal `autoWordCap: 40`, and again in
`fn_enforce_agent_publish_gate`. Point the rules engine and PD.8's fit stage at the registry and
delete the literals.
_Accept:_ changing `ops.templates.max_words` for TPL-01 changes the auto-publish behaviour with no
code edit; `grep -rn '40' ` on the gate paths finds no surviving literal cap.

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

**P5.9 — The research stage (added 2026-07-27; `09-signal-to-article.md §4`).** Today the writer
is one LLM call doing retrieval, analysis, editing and layout at once, over a context pack
truncated to 12,000 characters. Insert `worker/src/handlers/newsroom/research.ts` between
`classify` and `draft`: **deterministic SQL exhibit queries keyed by `event_type`**, each
returning an evidence bundle that already carries its `lake.objects` id and its natural block.
The LLM's job collapses to *selection and interpretation* over a bounded, auditable candidate set.
This also removes the P4.10 bug class rather than patching it — every bundle is constructed with
its object id, so the allow-set is built server-side.
_Accept:_ for `EARNINGS_RESULT`, ≥5 bundles are produced from SQL alone with zero LLM calls; the
draft prompt receives bundles, not a truncated blob.

**P5.10 — Compose against the closed vocabulary (needs PD).** Replace the single draft call with
two passes: outline `[{block_code, binding_object_id, one_line_intent}]` against **only** the
template's legal `block_keys` (~5–12 codes, not 61), validated against `ops.story_blocks` and
`lake.objects` before pass 2; then one constrained fill per block against its `payload_schema`.
Per **D-8**, the fill emits *bindings*, never numbers. Bound repair loops at 2, then human — a
block that needed repair twice is a block whose schema is wrong.
_Accept:_ TPL-01 and TPL-08 produce structurally different pieces; ≥3 block kinds per piece; every
data block carries a non-null `bound_object_id` (today **every agent-written block has NULL**,
which is why R-09 can only ever warn).

**P5.11 — Numeric-consistency check.** Extract every numeral from block prose; require each to
match a value reachable from that block's citations within tolerance, else refuse. No open-source
project does this well — it is ours to own. ⚠️ **Do not reach for MiniCheck / Bespoke-MiniCheck-7B**
as the entailment layer: the weights are **CC BY-NC 4.0** (the repo's Apache-2.0 covers code only,
and the HF model card governs). The smaller Flan-T5/RoBERTa/DeBERTa checkpoints must be
licence-checked individually.
_Accept:_ a fixture whose prose says 12.4% against a bound object of 12.1% is refused with both
values as evidence.

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
| **Licence contamination of a permanent data asset** — marker/surya/Chandra restrict their **Output**, with a competing-product clause and $5M/$2M revenue-or-funding thresholds; Nougat is CC-BY-NC. Extracting 29k documents with one of these builds an asset whose licence status flips on a funding round | D-9 blocks them by name; PE.3 states the gate as an acceptance criterion. Apache-2.0 alternatives (PaddleOCR-VL, docling, LiteParse) are at least as good |
| **A self-consistent wrong number** — a VLM misreads a line item and silently adjusts the subtotal to match its own arithmetic. The output passes a checksum | PE.4 is mandatory, not advisory: XBRL cross-reconciliation is the only check that catches it. Tier 1 is a discriminative-layout model, not a monolithic VLM, for exactly this reason |
| **Silently invisible object types** — `lake.objects.object_type` has no CHECK, no enum, no FK, so a new type is never *rejected*, it just does nothing | PE.5 carries the complete registration checklist; acceptance requires the type to appear in a projection **and** in `lake.fn_writer_context` |
| **The budget ladder silently reads $0** — `pricing.ts` returns `cost_usd = 0` for any unknown model with a one-time warn, so a newly configured model makes the ladder stop working exactly when spend starts | PE.8 acceptance requires a **non-zero** `cost_usd` row in `ops.llm_runs` |
| **Backfill cost is unmeasured** — every figure depends on a corpus page count nobody has | PE.1 produces the page count before PE.2 spends anything; the model tier is tens of dollars only if Tier 0 keeps the page volume down |

---

## 7. Sequencing

```
P0 ──▶ P1 ──▶ P2 ──▶ P3 ─────────────▶ PE ──▶ P4 ──▶ P5 ──▶ P8
       │               │                            ▲
       └──▶ PD ────────┴────────────────────────────┘   (PD is parallel; P5.10 needs it)
                       │
                       └────────────────▶ P7 (producers, parallel — worker fleet)
P6 (auth) ── owner-gated, independent, any time after P0
```

**Fastest path to a credible public reader:** P0 → P1 → P2 → P3. That yields 705 real stock
pages, a live wire, a live home page, real research and real analyst profiles — with no
dependency on the newsroom rebuild or on auth.

**The moat** (`FORWARD-BUILD §0` finish line C) is **PE → P4 → P5**, with **PD** running
alongside. It is the largest single body of work in this plan and the one the owner has called
out; it should not be compressed. PE was added because P4 could not otherwise succeed: the
newsroom has nothing to write about (2.6% of filings are readable), nothing that can trigger it
(VERIFIED is structurally unreachable for researcher-produced objects), and — without PD —
nothing that knows how to lay the result out.

**Recommended first merge:** P0 + P1 together — foundations plus the single most visible fix
(705 real stock pages instead of Aramco everywhere).

**Two cheap, high-leverage items landed early, ahead of their phases (2026-07-27):**
- **PE.0 ✅** — the extract-queue enqueue gap. 0 → 13,947 pending; the 25 GB corpus is now visible
  to the extractor, ordered TDWL/QE-RESULTS first.
- **PD.4 ✅** — the `pull_quote` / `heading` adapter mismatch, which flattened every heading and
  pull quote in every seeded article.

> ⚠️ **PE.0 makes work visible; it does not make it fast.** `filing-extractor.mjs` claims
> `EXTRACT_MAX` (default 12) per run at a 6h cadence ≈ 48 docs/day, so 13,947 pending is **~290
> days** at the current settings — and every one of those runs spends on the `claude -p`
> subscription seat, which is the lane the 2026-07-16 bandwidth incident was about. Two
> consequences: (a) **confirm `marsad-filing-extractor.timer` is actually enabled on the VPS**
> (owner item O-2 — timers were paused 2026-07-17 and the current state is inferred, not verified);
> (b) the trickle rate is the argument for PE.1–PE.3, not something to tune around — Tier 0 is
> deterministic, runs on the box, and has no per-document LLM cost at all.

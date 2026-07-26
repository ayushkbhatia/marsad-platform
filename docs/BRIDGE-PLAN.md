# Marsad — FE ↔ BE Bridge Plan

_Written 2026-07-22 from the `marsad-bridge-audit` ultracode workflow (6 parallel audits →
synthesis → adversarial critique). Grounded in a read-only schema audit of the live Supabase
project; corrected against the critique. Companion to `BUILD-STATUS.md` (§7 DEF ledger) and
`FORWARD-BUILD.md`._

## 0. The one idea

The frontend and backend **do not meet at the Postgres schema. They meet at the view-model
type.** Each of the 7 pixel-perfect reader screens renders from a single exported TypeScript
contract (`LedgerData`, `NewswireData`, `WatchlistData`, `ResearchIndexData`, `Article`,
`CoverageDeskData`, `AnalystProfile`) and never touches a DB row. The sample module and the
real adapter are just **two implementations of the same frozen contract** — swapping them is
one line in each `page.tsx`.

So "keep feeding screens, then connect backward" is right, with one correction: it's not a
_backward_ pass, it's **meet-in-the-middle at the contract**. Feed screens to complete the
contract surface (cheap, and each screen _is_ a spec); wire each screen the moment its
producer is live; freeze the contract types first so wiring can never break a pixel.

**Three-layer split (this is the "structural front-end schema"):**

| Layer | Lives in | Rule |
|---|---|---|
| **Layout** — the pixel-perfect component | **Code / git** (`src/components/reader/*`) | Never in the DB. Layout-in-rows is the schema-driven-UI trap. |
| **Contract** — the view-model type | **Code**, promoted to `src/lib/contracts/*` | The frozen interface both ends conform to. TS compiler enforces it. |
| **Content / instances** | **Schema rows** (`content_items`/`content_blocks`, `public.analysts`, `filings`, …) | The existing template→instance pattern. `1k` article = one layout, many `content_items` rows. |
| **Catalog** — `public.surfaces` | **Schema rows** (metadata only) | Governance: _which_ surfaces exist + their status. Does not render. |

## 1. Ground truth — what the live DB actually serves today

Read-only audit of project `yjsncnpbjuueaoeejrqj`, `public` schema. **⚠ Confirm this ref is
the production reader DB** — it differs from the ref in project memory (open item O-1).

**Access model:** reference/market tables carry a `world_read` (qual=true) RLS policy → anon
reads them directly. Premium tables (`financial_statements`, `key_ratios`, `scores`) have NO
anon policy — anon reaches them only through `SECURITY DEFINER` public views
(`v_scores_public`, `v_key_ratios_public`, `score_events_feed`). Those 6 views trip
ERROR-level `security_definer_view` advisors — **intended**, document as such.

| Table / view | Rows | Anon | State | Feeds |
|---|---|---|---|---|
| `filings` | 13,969 | yes | **full** | Newswire, stock pages |
| `ohlcv_daily` | 644k | yes | **full** (to 2026-07-21) | charts, markets, screener |
| `quotes_latest` | 702 | yes | **full** (0 null last; 702/762 secs) | movers, quote boards, Ledger |
| `mv_movers` | 661 | yes | **full** | Ledger movers, /markets |
| `mv_sector_heatmap` | 24 | yes | **full** | /heatmap |
| `index_levels` | 628 | yes | **full** | Ledger rail, /markets ✅ _(code comment saying "empty" is STALE)_ |
| `securities` | 762 | yes | **partial** | markets, screener, stock — sector 100%, **isin NULL in 486/762** |
| `earnings_events` | 8,967 | yes | **partial** | /earnings — forward full; `eps_actual` NULL in 515; 6,954 estimated vs 2,013 confirmed |
| `v_scores_public` | 529 | yes | **full** | stock score, screener, _(available to Coverage Desk)_ |
| `v_key_ratios_public` | 736 | yes | **partial** | stock, screener — **`dividend_yield` NULL in ALL 736**, pe NULL in 183 |
| `score_events_feed` | 3,458 | yes | **full** | _(available: a Newswire ratings/score-changes rail)_ |
| `content_items` | 3 (**1 live**) | yes | **thin** | Newswire/Ledger/Research/Article — a single published story |
| `content_blocks` | 5 | yes | **thin** | Article body |
| `dividends` | 1,168 | yes | **BROKEN** | /dividends, 1d corp-actions — **0 `state='live'` + ALL 1168 NULL ex_date/pay_date → renders empty** |
| `financial_statements` | 51k | **no (worker-only)** | full | stock financials tab (premium, via service-role — NOT anon) |
| `analysts` / `analyst_calls` | **0 / 0** | yes | **empty** | Coverage Desk, Analyst Profile — hard-blocked |
| `ipo_offers` / timeline / `listing_debuts` | 0 | yes | **empty** | /ipo |
| `estimates`, `transcripts`, `company_people`, `index_sector_weights`, `security_status` | 0 | yes | **empty, no producer** | earnings/ownership/index rails (silent) |
| `watchlists`/`alerts`/`notes`/`follows` + user state | 0 | — | **empty + no auth session** | Watchlist |

**Producer fleet:** the audit's fleet dimension came back a stub — **producer statuses below
are inferred from BUILD-STATUS + memory, NOT fleet-verified.** Memory notes all VPS timers
were PAUSED 2026-07-17. **Confirm with a live `systemctl list-timers marsad-*` on the VPS
before trusting any `producer_status`** (open item O-2).

## 2. Bridge-readiness matrix (critique-corrected)

| Surface | Contract | Readiness | Why | Effort |
|---|---|---|---|---|
| **1d Newswire** `/wire` | ✅ | **partial (core feed only)** | `filings` (13,969, full, anon) ready as the spine; **corp-actions dead** (dividends broken), **mostRead has no source**; `score_events_feed` (3,458) available for a ratings rail | M |
| **1b Ledger** `/` | ✅ | **partial** | market rails ready — `index_levels`(628)/`quotes_latest`(702)/`mv_movers`(661)/`mv_sector_heatmap`(24)/`filings`; newsroom lead **thin** (1 article); **macro row + lead photo/kicker/take unsourced** | M |
| **1l Research index** `/research` | ✅ | **partial** | `editorial.ts` read path live but `content_items`=1 live; subscribe cards no source | M |
| **1k Article** `/articles/[slug]` | ✅ | **partial** | `editorial.ts` + `content_blocks`(5) + RLS free/premium cut exist, **but the premium/masked-block cut needs `jwt_tier` from an auth session that doesn't exist yet**; must restore `notFound()`/`generateMetadata`/JSON-LD; every slug → a `content_items` instance | M |
| **1i Coverage Desk** `/analysts` | ✅ | **blocked-producer** (partial escape) | `analysts`=0, `analyst_calls`=0 → leaderboard/ratings hard-blocked; **a scores-based coverage view could ride `v_scores_public`(529)** | L |
| **1h Watchlist** `/watchlist` | ✅ | **blocked-producer AND blocked-auth** | row fields exist (`quotes_latest`/`v_scores_public`) but per-user tables 0 rows AND no `(auth)`/`(member)` session; surface is currently ungated | L |
| **1j Analyst Profile** `/analysts/[slug]` | ❌ | **hard-blocked** | `getAnalystProfileBySlug` is a stub _by construction_ — `public.analysts` has no `slug`/`display_name` column; needs a migration + producer + a charting lib before the contract is even mappable | L |

**Not in the 7-screen scope but note:** `/markets`, `/screener`, `/heatmap`, `/earnings`,
stock pages were built in wave-1/2 reading **real data already** — they're wired. The
`/stocks/[venue]/[ticker]/financials` tab is a `PremiumLock` shell over `financial_statements`
(anon=NO, worker-only) — correct as gated, but end-to-end premium needs auth.

## 3. The `public.surfaces` catalog (governance, not layout)

One row per client-facing **surface** (not per slug). Metadata only.

```
public.surfaces
  surface_key      text pk        -- 'ledger','newswire','article','research_index',
                                  --  'watchlist','coverage_desk','analyst_profile'
  title, description text
  route_pattern    text           -- '/', '/wire', '/articles/[slug]'
  route_group      enum(reader|dataroom|admin)
  kind             enum(index|detail|template)   -- template = one layout, every slug (1k,1j)
  view_model_type  text           -- NAME of the exported TS contract ('NewswireData'…);
                                  --  the shape is enforced by tsc, the row only cross-refs it
  adapter_module   text           -- 'src/lib/data/adapters/newswire.ts'
  content_model    enum(none|content_items)      -- do instances live as content_items rows?
  gating           enum(public|premium|member)
  producer_status  enum(live|partial|pending)
  wire_readiness   enum(ready-now|partial|blocked-producer|blocked-auth)
  def_backlog_id   text           -- link to DEF-*-LIVE-DATA in BUILD-STATUS §7
  is_live          boolean        -- real adapter bound vs sample fallback
  registered_by, registered_at, updated_at
```

- **Anon-readable subset** feeds nav/sitemap (fixes `nav_config_live` = 0 rows today). Writes
  = service-role / Desk only.
- **Registering a new page = one INSERT**, after (a) define the view-model type, (b) build the
  component, (c) write the adapter. Everything load-bearing stays in code; the row governs.
- **Template surfaces** (1k, 1j) register ONCE with `kind='template'` + `content_model='content_items'`; every slug is an instance row, never a `surfaces` row.
- **CI reads `surfaces`** to build nav/sitemap and to assert each `adapter_module` still
  compiles against its `view_model_type` — a **contract-drift guard** before it reaches a
  pixel screen.

## 4. Phase plan

- **Phase 0 — Freeze contracts + stand up catalog.** Promote the 7 view-model types to
  `src/lib/contracts/*`; keep sample modules as golden fixtures + runtime fallback; create +
  seed `public.surfaces` with the 7 surfaces. No behavior change.
- **Phase 1 — Adapters behind the sample seam (no regression).** Each adapter returns the
  exact view-model type, bound behind a fallback to sample so an empty read can never blank a
  pixel screen (guard: dividends `state='live'` gate, ipo/holders/datapoints 0-row reads).
- **Phase 2 — Wire ready-now.** Build the **reference adapter** `adapters/newswire.ts`
  (`filings → NewswireData`), swap `SAMPLE_NEWSWIRE` — this is the canonical pattern every
  later surface copies. Then Ledger market/filings/movers rails. Leave dead rails
  (corp-actions, mostRead, macro, lead photo) on sample fallback.
- **Phase 3 — Content-template surfaces.** Wire Research index + Article via `editorial.ts`;
  restore `notFound()`/metadata/JSON-LD on `/articles/[slug]`; register each slug as a
  `content_items` instance. (Premium masked-block cut lands fully in Phase 5 with auth.)
- **Phase 4 — Fill producer gaps** (see §5).
- **Phase 5 — Auth + entitlements + monetization (Batch 2).** See §5.5 — the schema is
  already built; this phase is wiring, not modelling. Stand up the `(auth)` route group
  (6a–6e, 6l) + a `(member)` group; move `/watchlist` into it, re-gate NavTabs and add the
  **logged-in nav variant**; enable `custom_access_token_hook` so `jwt_tier` is stamped;
  build `PaywallModal` (4a–4d) on `billing.consume_meter`; integrate Stripe (6h–6j) +
  dunning (6i); wire per-user state behind the existing `create_watchlist`/`create_alert`/
  `create_saved_screen` RPCs; light up the Article premium cut end-to-end.
- **Phase 6 — Desk authoring loop.** Desk lists `surfaces`, opens `content_items`/blocks
  authoring for content-backed surfaces; new page = type + component + adapter + one INSERT.

## 5. Producer gaps (the missing halves)

| Gap | What to build | Unblocks |
|---|---|---|
| **dividends (doubly broken)** | Producer must set `state='live'` on published rows AND backfill `ex_date`/`pay_date` (all 1,168 NULL today) | 1d corp-actions, /dividends, stock dividends tab |
| **analyst roster + calls** | Producer to seed `public.analysts` + `analyst_calls` + a desk-articles source (leaderboard win-rate/avg-return/last5/ratingsChanges derive from these) | 1i, 1j |
| **analyst slug/identity (schema)** | Migration: `slug` + `display_name` (+ bio/credential) on `public.analysts` + anon path, so `getAnalystProfileBySlug` stops returning null by construction | 1j (hard block), 1i |
| **Ledger macro + hero** | Macro-quotes producer (Brent/gold/UST10Y/USDSAR) + `content_items` hero fields (photo/kicker/take) — keep editorial in rows, not code | 1b |
| **mostRead analytics** | Page-view/read-count store + producer | 1d |
| **editorial depth** | Desk authoring loop to grow `content_items` beyond 1 live | 1l, 1k, 1b lead |
| **per-user state** | Auth + per-user CRUD producers | 1h |
| **silent empties (log, don't wire)** | `estimates`/`transcripts`/`company_people`/`index_sector_weights`/`security_status` = 0 rows, anon-readable, no producer — decide build-or-defer; `securities.isin` 64% NULL degrades ISIN joins | earnings/ownership/index rails |

## 5.5 Monetization spine (Batch 2 — 4a–4d + 6a–6l)

_Added 2026-07-23 after auditing the live DB against the Batch 2 handoff. **This corrects an
assumption in §2/§6: the earlier audit treated auth + entitlements as "entirely unbuilt". The
schema is in fact built and materially complete** — what is missing is wiring and rows._

**Already in the database** (`supabase/migrations/20260713000010_billing.sql`):
`billing.{subscriptions, plan_versions, invoices, payment_attempts, usage_meters,
article_unlocks, credit_ledger, promo_codes}`, `public.user_profiles`, `comms.push_devices`,
the full Supabase `auth.*` stack (users, sessions, identities, MFA), plus the functions
`billing.consume_meter`, `billing.live_plan`, `public.custom_access_token_hook`,
`public.jwt_tier`. The invoice table already carries **KSA VAT + ZATCA** fields
(`vat_rate`, `vat_amount_sar`, `seller_trn`, `buyer_vat_id`, `zatca_payload`) — exactly what
6h/6j require. **Every one of these tables has 0 rows; `auth.users` has 0 rows.**

The design's data model maps onto it almost 1:1 (full mapping table in
`SCREENS-REGISTER.md` §2.3), and the live `plan_versions` pricing **matches the design**:
premium monthly SAR 119; premium annual SAR 1228.20 VAT-incl → SAR 102.35/mo.

**Blocking gaps — wiring, not modelling:**
1. **No Stripe integration** — "stripe" exists only as column names. No SDK, no
   `supabase/functions`, no webhook handler, no checkout-session creation. This is the single
   largest build in the batch (6h → 6i → 6j is one state machine).
2. **`custom_access_token_hook` not enabled** in Supabase Dashboard → Auth → Hooks (a
   standing owner action item). Until it is, `jwt_tier` is never stamped, so the premium RLS
   cut on `content_blocks`/`scores` cannot fire — **the 1k paywall cannot be tested end-to-end.**
3. **No `(auth)` route group** and **no logged-in `MarsadNav` variant** (a `user` + `plan`
   prop, not a second nav).

**Sequencing note:** `PaywallModal` should be built **first** in this batch — it is already
referenced by three shipped Batch 1 screens (the 1k article fade-mask, 1f's export controls,
3c's phrase-alert limit), all of which currently render a static gate.

> ⚠️ **Conflict to resolve before building 4a/4d:** the designs read "3 OF 3 FREE READS", but
> the live plan row and the owner sign-off both say **`premium_reads_mo: 2`**. Schema is the
> system of record — either the copy or the plan row changes.

## 6. Risks

- **Silent-blank regression** — swapping an adapter onto a pixel screen without a
  sample/EmptyState fallback turns a polished surface blank (dividends/ipo/holders 0-row).
- **Template collapse** — 1k/1j currently render ONE baked sample for EVERY slug via
  `generateStaticParams`; wiring without restoring `notFound()`/metadata/JSON-LD ships wrong
  canonical + duplicate SEO on every slug.
- **Contract drift** — editing a view-model type to fit a DB shape breaks the pixel
  guarantee. Freeze types first; map DB→type inside adapters only.
- **Watchlist data leak** — binding real per-user data before the auth gate risks empty/500
  or cross-user state on an ungated route.
- **Advisor debt** — the 6 `security_definer_view` ERRORs are the intended anon path;
  document as intentional as reliance widens.
- **`nav_config_live` = 0 rows** — nav falls back to static defaults; a surfaces-driven
  `nav_config` must be seeded.

## 7. Open items to confirm before wiring

- **O-1** Confirm project ref `yjsncnpbjuueaoeejrqj` is the production reader DB (memory
  records a different ref).
- **O-2** Live `systemctl list-timers marsad-*` on the VPS — all timers were paused
  2026-07-17; no `producer_status` is fleet-verified.
- **O-3** Reconcile the stale `getIndexTape` "index_levels empty" code comment — the DB has
  628 live rows; the Ledger index rail is wireable.
- **O-4** Analyst producer + anon slug path (new columns vs a `SECURITY DEFINER` view?) —
  gates 1i + 1j entirely.
- **O-5** ~~Auth/entitlement model~~ — **largely ANSWERED 2026-07-23 (see §5.5):** the model is
  `auth.users` + `billing.subscriptions.plan_key` → `custom_access_token_hook` → `jwt_tier` →
  RLS. Remaining decisions: (a) enable the access-token hook in the Dashboard, (b) which route
  group hosts member surfaces (`(member)` vs extending `(reader)`), (c) resolve the
  2-vs-3 free-reads conflict.
- **O-6** Origin of Ledger macro ticker + editorial hero (scraper vs `content_items` fields vs
  external feed).
- **O-7** Should sample modules stay a permanent feature-flagged fallback, or retire per
  surface once `producer_status='live'`?

## 8. Recommendation, one line

Keep feeding screens (reader-first, then admin) — that completes the contract surface cheaply;
freeze the 7 view-model types + stand up `public.surfaces` now; build `adapters/newswire.ts`
as the reference and wire the ready-now rails (Newswire core feed, Ledger market rails);
spin the dividends + analyst + auth producer tracks in parallel; the view-model contracts are
the platform's structural front-end schema, mirrored by the `surfaces` catalog for governance.

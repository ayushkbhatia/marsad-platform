# 04 — Reader App & Public API Architecture

> Domain: the Next.js reader product (web + mobile-web + transactional email) for Marsad.
> Author: Reader App & Public API domain architect. Date: 2026-07-13.
> Source of truth honored: `docs/design-analysis.md` (full 181-screen synthesis). Locked decisions:
> scrape-only delayed data, all 6 venues day one, cheapest-possible run cost, provider-agnostic LLM
> gateway, English only.

---

## 0. Ground rules and corrections to the brief

1. **Framework version.** The brief says Next.js 15; the repo is actually **Next.js 16.2.10**
   (`package.json`) and `AGENTS.md` warns that conventions differ from prior versions. This
   document targets Next 16 conventions as shipped in `node_modules/next/dist/docs/`:
   - `proxy.ts` (Next 16's rename of `middleware.ts`) for session refresh and route protection.
   - **Cache Components** (`cacheComponents: true` in `next.config.ts`) with the `use cache`
     directive and `cacheLife(...)` profiles as the caching model, replacing the old
     `export const revalidate` idiom. GET route handlers follow the same prerender model.
   - Async `params` / `searchParams` / `cookies()` everywhere.
2. **Mobile is the same product.** All `12a–15g`, `m1a–m4f`, `m5a–m5c` mobile screens are the
   responsive rendering of the web routes below. There is no separate mobile route tree. The
   only mobile-specific artifacts are the 5-slot bottom nav (driven by the same `nav_config`
   the Desk publishes) and pull-to-refresh/back-grouping behaviors inside client components.
3. **Design-token artifacts.** `design-tokens.json` and `component-map.md` from the design
   handoff bundle are not yet committed. This document assumes they land at
   `src/styles/design-tokens.json` and `docs/design/component-map.md`. DEFAULTED — owner may
   override the location, nothing else depends on it.
4. **Cost posture.** Every choice below is justified against the locked "cheapest possible"
   constraint. Anything with a monthly invoice larger than single-digit dollars is called out,
   and a $0 alternative is named where one exists.

---

## 1. Route map (app router)

Top-level structure under `src/app/`. Route groups carry shared layouts; they do not appear in
URLs. The reader is one Next.js app deployed on the existing Vercel project — no second app,
no subdomain, no extra cost.

```
src/app/
├── layout.tsx                     # html shell, fonts, design tokens import
├── proxy.ts (at src/proxy.ts)     # Supabase session refresh + authed-route guard
├── sitemap.ts                     # securities + articles + filings sitemaps
├── robots.ts
├── not-found.tsx                  # 17d "This page has delisted." (global 404)
│
├── (reader)/                      # MarsadNav + footer layout; light editorial chrome
│   ├── layout.tsx                 # renders MarsadNav w/ plan tier (16d session-state spec)
│   ├── page.tsx                   # 1b  Front page "Ledger"
│   ├── markets/page.tsx           # 2b  Market Edition front page
│   ├── wire/page.tsx              # 1d  Newswire (facets via searchParams)
│   ├── articles/[slug]/page.tsx   # 1k  Article w/ server-side premium cut
│   ├── research/page.tsx          # 1l  Research index (soft meter wall 4d in-page)
│   ├── analysts/page.tsx          # 1i  Analyst hub
│   ├── analysts/[slug]/page.tsx   # 1j  Analyst profile
│   ├── analysts/apply/page.tsx    # 20d Apply to publish
│   ├── stocks/[ticker]/
│   │   ├── layout.tsx             # quote header + tab bar; polls /api/pulse/quote
│   │   ├── page.tsx               # 1g/3a Overview
│   │   ├── financials/page.tsx    # 3b
│   │   ├── filings/page.tsx       # 3c  (incl. concall archive)
│   │   ├── ownership/page.tsx     # 3d
│   │   └── loading.tsx            # 17e shimmer skeleton
│   ├── filings/page.tsx           # 7a  global register; 7b = ?ticker=2222
│   ├── filings/[filingId]/page.tsx# 7d  filing detail
│   ├── earnings/page.tsx          # 8a  calendar
│   ├── earnings/[eventId]/page.tsx# 8b  event detail
│   ├── earnings/estimates/page.tsx# 8c  estimates & revisions
│   ├── earnings/scorecard/page.tsx# 8d  surprise scorecard
│   ├── concalls/page.tsx          # 18c global feed
│   ├── concalls/[callId]/page.tsx # 18d transcript reader (audio sync client island)
│   ├── datapoints/[seriesId]/page.tsx # 18b series detail w/ provenance
│   ├── compare/page.tsx           # 18a (?t=2222,QNBK,FAB — up to 4)
│   ├── investors/page.tsx         # 20b directory
│   ├── investors/[slug]/page.tsx  # 20c investor detail (PIF)
│   ├── ipo/page.tsx               # 22a IPO Center pipeline
│   ├── ipo/[offerSlug]/page.tsx   # 22b detail; renders 22c listing-day variant by stage
│   ├── dividends/page.tsx         # 23a dividend calendar
│   ├── learn/page.tsx             # 20f explainers/help/legal/methodology hub
│   ├── learn/[docSlug]/page.tsx
│   ├── pricing/page.tsx           # 1m
│   ├── search/page.tsx            # 16a federated results (?q=)
│   └── market-closed handling     # 16c is a masthead state, not a route (see §4)
│
├── (dataroom)/                    # dark chrome layout; same MarsadNav, surface="dark"
│   ├── layout.tsx
│   ├── heatmap/page.tsx           # 1e dark treemap; 2a paper edition = ?edition=paper
│   ├── screener/page.tsx          # 1f (client-heavy; results via /api/screener/run)
│   ├── screens/page.tsx           # 9a Explore gallery
│   ├── screens/[screenId]/page.tsx# 9b preview (3-of-N truncation server-side)
│   ├── screens/community/page.tsx # 9c
│   └── screens/mine/page.tsx      # 9d
│
├── (member)/                      # requires session (guarded in proxy.ts)
│   ├── layout.tsx
│   ├── watchlist/page.tsx         # 1h
│   ├── alerts/page.tsx            # 5a Alerts Manager
│   ├── notebook/page.tsx          # 20a (list + note detail as client master-detail)
│   ├── ai/page.tsx                # 10a AI hub
│   ├── ai/threads/[threadId]/page.tsx # 10c answer / 10f refusal states
│   ├── ai/thesis/[ticker]/page.tsx    # 10d standing thesis
│   ├── account/page.tsx           # 6k settings (profile/billing/prefs/security)
│   ├── account/security/2fa/page.tsx  # 17f TOTP enroll (2 steps in one route)
│   └── checkout/
│       ├── page.tsx               # 6h Stripe checkout
│       └── welcome/page.tsx       # 6j premium welcome (6i decline = in-page state)
│
├── (auth)/                        # minimal chrome, dark value panel
│   ├── layout.tsx
│   ├── signup/page.tsx            # 6a
│   ├── signin/page.tsx            # 6b
│   ├── forgot-password/page.tsx   # 6c
│   ├── reset-password/page.tsx    # 6d (token in query)
│   ├── verify-email/page.tsx      # 6e
│   ├── onboarding/page.tsx        # 6f + 6g (2-step wizard, one route, step in state)
│   └── signed-out/page.tsx        # 6l
│
└── api/                           # route handlers (public API surface, §3.3)
    ├── pulse/[surface]/route.ts   # consolidated poll endpoints (§4)
    ├── screener/run/route.ts
    ├── search/route.ts
    ├── ai/ask/route.ts            # streaming; also /api/ai/thesis
    ├── meter/consume/route.ts
    ├── alerts/route.ts            # CRUD w/ quota enforcement
    ├── export/[kind]/route.ts     # CSV/XLSX/ICS/PDF exports (entitlement-gated)
    ├── og/[...slug]/route.ts      # 1200×630 social cards via next/og (free, on-demand)
    ├── stripe/webhook/route.ts
    ├── email/send/route.ts        # internal, CRON_SECRET-guarded (Wire Brief etc.)
    └── jobs/[job]/route.ts        # pg_cron → HTTP targets, CRON_SECRET-guarded
```

Screen-to-route notes:

- **Paywalls 4a–4d and 7c** are one `PaywallModal` client component parameterized by
  `variant`, mounted by the pages above when the server says "gated" — never routes.
- **Notifications 16b** is a client dropdown in `MarsadNav` reading `/api/pulse/notifications`.
- **10b company slide-over** is a client sheet inside the AI hub, fed by a small route handler
  (`/api/ai/grounding/[ticker]`), not a route.
- **10e credits paywall** is `PaywallModal variant="credits"` triggered by a 402 from
  `/api/ai/ask`.
- **17a–17c empty states** are in-page components; **17e** is `loading.tsx`; **17d** is
  `not-found.tsx`; error boundaries via per-group `error.tsx`.
- **2a vs 1e**: single `/heatmap` route; `?edition=paper` flips `surface` prop on the treemap.
  DEFAULTED — owner may prefer two routes for SEO; the treemap is `noindex` either way.
- **7b** (company-scoped register) is `/filings?ticker=2222` — one query, one page, plus the
  in-page quote rail. Canonical URL for SEO stays `/filings`.
- **22c listing day** is a stage-conditional rendering of `/ipo/[offerSlug]` (stage =
  `LISTED_TODAY` shows the 1-min debut chart and Score PENDING card).
- **6i payment declined** is checkout page state driven by Stripe error codes, with the mada
  guidance copy keyed off `decline_code`.
- Auth screens 11a–11f (mobile) are the same `(auth)` routes.

### proxy.ts responsibilities

`src/proxy.ts` (Next 16 convention) does exactly three things, all cheap. **Its matcher
excludes `/api/pulse/*`, `/api/og/*`, `/api/e` and static assets** (post-review): @supabase/ssr
token refresh emits `Set-Cookie`, which makes a response uncacheable at the CDN — running it on
pulse endpoints would silently collapse the §4 cost math from ~2 origin hits/min/surface to
per-user invocations for every signed-in reader.

1. Refresh the Supabase auth cookie via `@supabase/ssr` (the existing pattern in
   `src/lib/supabase/server.ts` expects this).
2. Redirect unauthenticated hits on `(member)` routes to `/signin?next=…`.
3. Stamp `x-marsad-tier: anon|free|premium` from the JWT claims into request headers so layouts
   can render the 16d nav states without an extra DB read. **This header is a rendering hint
   only — never an enforcement input.** Enforcement is always at the data layer (§5).

---

## 2. Rendering strategy: server vs client

Default is **React Server Components everywhere**; client components are leaf islands. With
`cacheComponents: true`, each page is composed of cached shells plus dynamic holes.

| Surface | Server-rendered (cached) | Client islands |
|---|---|---|
| Ledger `/` | Whole page shell, story grid, Select teaser — `use cache`, `cacheLife({revalidate: 60})` keyed on `front_page_config.version` | Index rail poller, wire module poller |
| Newswire `/wire` | First page of items per facet combination (`use cache` 30s) | Infinite scroll + 30s poll appender, "save view as alert" |
| Heatmap | Treemap geometry computed server-side from `sector_aggregates` (cache 60s) | Treemap interaction (hover, drilldown), period tabs, poll |
| Screener | Page shell, saved-screen list | Entire filter/results grid (calls `/api/screener/run`) |
| Stock pages | Everything except the quote header: stats, score card, financials, filings list, ownership (cache 10 min, tag `stock:2222`) | Quote header poller, lightweight-charts candle chart, ratio-strip editor |
| Article `/articles/[slug]` | Full article for premium at request time; truncated variant cached for anon/free (§5.1, §8) | Reading-progress, PaywallModal, in-piece ticker rail poller |
| Watchlist / Alerts / Notebook | Shells only (user-specific — dynamic, no cache) | Rows, alert composer, notes editor |
| AI hub / thread | Thread history (dynamic) | Ask bar, streaming answer renderer, credits chip |
| Calendars (earnings/dividends/IPO) | Whole page, cache 5 min | Alert/reminder toggles, ICS export button |
| Compare | Server-computed table for the `?t=` set (cache 5 min per combination) | Add/remove ticker control |
| Auth/checkout | Shells | Forms, Stripe Payment Element |

Rules of thumb enforced in review:

- A component may be a client component only if it (a) polls, (b) handles input, or
  (c) wraps a charting canvas. Everything else stays on the server.
- No client component ever receives gated data as props "hidden by CSS". If the server didn't
  send it, it isn't in the HTML. (Answers design open question 12: blur states in the mocks are
  presentational only — the underlying gated text is genuinely absent for free users; the blur
  sits over server-generated teaser stubs.)
- `lightweight-charts` (~45 KB gz) is loaded with `next/dynamic` only on routes with candle
  charts (stock pages, earnings detail, IPO debut). Sparklines everywhere else are **inline SVG
  paths generated in server components** from the last N closes — zero client JS, per README
  spec.

---

## 3. Data fetching: direct Supabase reads vs API routes

Three patterns, chosen per surface. The decision rule: **who owns the secret and who counts the
meter.**

### 3.1 Pattern A — RSC direct read with anon/session key + RLS (default for public data)

Server components call **`createAnonClient()` from `src/lib/supabase/public.ts` — a new
cookieless anon-key client** (plain `createClient(url, anonKey)`, no `cookies()` binding) and
read tables that have permissive anon `SELECT` RLS policies. This is a post-review correction:
the cookie-bound `createClient()` from `src/lib/supabase/server.ts` calls `cookies()`, which is
unavailable inside `use cache` scope — every "cached" read would silently opt out to dynamic
and run one Supabase query per visitor, destroying the biggest cost lever in this document.
The cookie-bound client remains the tool for *personalized* dynamic reads only. Cached public
reads cover: `securities`, `venues`, `venue_freshness`,
`quote_snapshots`, `ohlcv_daily`, `indices`, `index_snapshots`, `sector_aggregates`,
`filings` (metadata + extracted text), `earnings_events`, `estimates_agg`, `dividends`,
`ipo_offers`, `concalls`, `datapoint_series`/`datapoint_values`, `holders`/`holder_positions`,
`marsad_scores` (headline number only — grades are gated, §5), `articles` (free fields),
`analyst_profiles`, `screen_catalog`. All reads happen inside `use cache` functions in
`src/lib/data/*.ts` (e.g. `src/lib/data/stocks.ts#getStockOverview(ticker)`), so Supabase sees
a handful of queries per revalidation window, not one per visitor. This is the single biggest
cost lever on the $10 Supabase budget.

### 3.2 Pattern B — RSC/route handler with SECURITY DEFINER RPC (all gated or metered reads)

Anything entitlement-shaped goes through a Postgres function that checks the caller's plan and
meters **inside the database**, so there is exactly one enforcement point regardless of whether
the caller is a server component, a route handler, or (later) a public API client:

- `fn_article_render(p_slug text)` — returns blocks up to the premium cut for free/anon,
  full body for premium; consumes a metered read when it crosses the gate (§5.1).
- `fn_screener_run(p_criteria jsonb)` — full rows for premium, 3 rows + total count for free.
- `fn_screen_preview(p_screen_id)` — 3-of-N with blurred stubs (9b).
- `fn_score_detail(p_ticker)` — factor grades and percentile, meter-gated for free tier.
- `fn_alert_create(p_alert jsonb)` — quota check per bucket (§5.3).
- `fn_ai_debit` / `fn_ai_settle` — credit ledger (§7.3).
- `fn_meter_consume(p_meter text)` — generic monthly meter tap.

RLS on the underlying gated tables (`article_blocks` past the cut, `marsad_score_factors`,
`ai_credit_ledger`, `usage_meters`) is **deny-all to anon and authenticated**; only the
DEFINER functions read them. The service-role key exists only in route handlers that need
cross-user work (Stripe webhook, email jobs) via `src/lib/supabase/admin.ts` (server-only
module, `import "server-only"`).

### 3.3 Pattern C — Route handlers under `/api` (polling, mutations, streaming, exports)

Route handlers exist where RSC can't serve: client polling (`/api/pulse/*`, §4), streaming AI
(`/api/ai/ask`), file exports (`/api/export/*` — CSV/XLSX/ICS generated in-process, no storage
cost), Stripe webhooks, and cron targets. These are also the seed of the **Public API** for the
enterprise tier later ("Terminal + API from SAR 24,000/yr"): same handlers, API-key auth added
in front, so we don't build a second stack. DEFAULTED — public API productization is deferred
entirely; only the internal shape anticipates it.

**Recommendation per surface (summary):** public read-only pages → Pattern A; anything the
pricing page monetizes → Pattern B; anything that ticks, streams, or downloads → Pattern C.
Client components never hold a Supabase client for reads of market data — they poll Pattern C
endpoints, which are CDN-cacheable and shared across users (a browser-side
`createBrowserClient` read is per-user and uncacheable, which is wrong for cost). The browser
Supabase client (`src/lib/supabase/client.ts`) is used only for auth flows and user-owned
writes (notebook autosave, watchlist reorder) where RLS `owner_id = auth.uid()` policies are
the enforcement.

---

## 4. Freshness propagation and poll cadence (no websockets day one)

**Why no websockets/SSE:** the locked strategy is scrape-only, 15-min-delayed/EOD data. The
freshest any number can be is bounded by the scraper cadence (agents write snapshots every
1–5 min per venue at best). A 60-second poll adds at most 60s to a ≥15-minute floor —
imperceptible and honest, since everything is labeled DELAYED anyway. Websockets would add:
Supabase Realtime concurrency limits on the $10 plan, connection-state complexity (the design's
RECONNECTING state machinery), and Vercel doesn't host persistent sockets on serverless without
extra services. The design's SSE/WS mentions (1d, 22c) were written against a licensed-feed
assumption that decision #1 removed. **Deliberately deferred:** a realtime upgrade path exists
(swap the poller hook's transport) if licensing ever changes.

### 4.1 The pulse endpoints

One consolidated poll endpoint per surface family, `GET /api/pulse/[surface]`:

| Endpoint | Payload | Poll cadence (market hours) | CDN cache |
|---|---|---|---|
| `/api/pulse/indices` | 7 index levels + sparkline tails + per-venue freshness | 60s | `s-maxage=55, swr=30` |
| `/api/pulse/quote?t=2222` | one quote + ticker freshness + halt state | 30s | `s-maxage=25` |
| `/api/pulse/wire?after=<cursor>` | new wire items + venue freshness block | 30s | `s-maxage=25` |
| `/api/pulse/heatmap?period=1D` | sector aggregates + breadth + per-venue sync | 60s | `s-maxage=55` |
| `/api/pulse/watchlist` | quotes for the caller's tickers (authed, uncached) | 60s | private |
| `/api/pulse/debut?t=9615` | 1-min bars since open (listing day only) | 60s | `s-maxage=55` |
| `/api/pulse/notifications` | unread count + latest items (authed) | 90s | private |

Every pulse payload embeds a `freshness` block:
`{venue: "MSX", state: "delayed", lastSync: "2026-07-12T10:26:00+04:00", detail: "SYNCED 14:26"}`
sourced from the `venue_freshness` table that the scraper agents maintain (states:
`live|reconnecting|delayed|offline|halted|auction` per the 6-state machine; under scrape-only,
`live` means "our freshest delayed tier", and `delayed` is the steady state most of the time).
Ticker-level overrides (`HALTED`, `AUCTION`, `STALE`) ride on the quote rows
(`quote_snapshots.state`).

**Client plumbing:** one hook, `src/lib/hooks/usePulse.ts(surface, params)` — `setInterval` +
`fetch`, pauses on `document.hidden`, stops entirely when the market-calendar says all relevant
venues are closed (that same calendar drives the 16c weekend masthead: the Ledger layout reads
`market_calendar` server-side and swaps the masthead variant — 16c is a state, not a route).
`FreshnessBadge` receives the freshness block as props; recency-decay (flash → grey → amber)
is a purely client-side timer against `lastSync`.

**Cost math:** cached pulse endpoints collapse to ~1–2 origin invocations per minute per
surface regardless of audience size (Vercel CDN keying on URL+query). At 5 cached surfaces
that's ≈ 5 × 2 × 60 × 8 market-hours ≈ 4,800 function invocations/day from polling — well
inside Vercel's included quota. Authed pulses (watchlist, notifications) are per-user; at early
scale (hundreds of users) still negligible.

**Halted/auction propagation:** admin 33a actions write `venue_freshness` / halt rows; readers
see it on the next poll ≤60s later. Incident banners are a row in `incident_banners` included
in `/api/pulse/indices`, auto-expired by the ops job — the reader renders whatever is active.

---

## 5. Server-side entitlement enforcement

Entitlements are **config-driven rows**, not code: `plan_entitlements(plan, key, value)` seeded
from the 33c monetization config (e.g. `('free','articles_monthly',3)`,
`('free','ai_credits_monthly',20)`, `('premium','alerts_stock',800)`). One loader,
`src/lib/entitlements/index.ts#getEntitlements(userId)`, is used by RPCs via a SQL twin
(`fn_entitlement(p_key)`). Changes apply next cycle per 33c; the loader snapshots the values
onto the subscription row at cycle start.

**Meter conflict (design open question 1) — DEFAULTED:** the 33c admin config is the source of
truth. v1 meters: `premium_articles: 3/mo` (reconciling 1m/4a copy "3 free reads" with 33c's
"2" in favor of the reader-visible promise — owner may override to 2), `scores: 3/mo`,
`ai_credits: 20/mo` (the 33c "5 AI answers" line is expressed through credits, not a separate
answer counter). Meter rows live in `usage_meters(user_id, meter, period_start, used)` with a
unique key per (user, meter, month); reset is a no-op — the RPC lazily rolls the period, so no
monthly reset job can miss (the "1st of month" reset in the jobs inventory becomes implicit).
Anonymous readers get a **cookie-scoped soft meter** (signed httpOnly cookie counting article
gate hits) — trivially evadable, which is fine: the hard asset (full text) is never sent.

### 5.1 Article truncation at the premium cut

- Articles are stored as ordered blocks: `article_blocks(article_id, idx, kind, payload)` with
  `articles.premium_cut_idx` (set by the Desk editor's draggable cut, honoring R-09).
- `fn_article_render(slug)` returns: all blocks for premium; blocks `idx < premium_cut_idx`
  plus `{gated: true, remaining_blocks: n, remaining_words: w}` for free/anon. For **metered**
  premium pieces, if the free user still has `premium_articles` meter budget the function
  consumes one unit (insert-or-increment on `usage_meters`, `SECURITY DEFINER`, single
  statement) and returns the full body with `{metered: {used: 3, cap: 3}}` for the "3 OF 3 FREE
  READS USED" banner.
- The page is `dynamic` for authed users; for anonymous it serves a cached truncated render
  (also what crawlers get — §8). The full text of a gated article **never leaves Postgres** for
  a non-entitled caller. Check lives in: the RPC (enforcement) + `articles/[slug]/page.tsx`
  (presentation only).

### 5.2 Screener and screen-preview row caps

`fn_screener_run` executes the criteria AST (a constrained JSONB → SQL builder over the
`fundamentals_wide` materialized view; AND-chains of `field op value` only — no raw SQL from
clients, allowlisted fields) and applies `LIMIT 3` + `count(*)` for free callers, full result
+ CSV eligibility flag for premium. Save/alert/export actions each re-check entitlements in
their own RPCs (`fn_screen_save` enforces the 5-saved-screens free cap). The 4c paywall fires
off the flags in the response, never off client logic. Check lives in: `fn_screener_run` /
`fn_screen_save` (enforcement), `/api/screener/run/route.ts` (transport).

### 5.3 Alert quotas

`fn_alert_create` buckets the ~12 trigger types into three quota pools —
`stock` (price/score/event/ratio/ex-date/transcript/holder/IPO-books-open), `screen`
(screen-match), `phrase` — per the 5a caps (free 10/2/2, premium 800/75/50). DEFAULTED
taxonomy for the unlabeled types (design open question 7): everything ticker- or
entity-scoped counts against `stock`. Existing free phrases are grandfathered on upgrade-down
by never deleting, only blocking creation. Check lives in: `fn_alert_create`.

### 5.4 AI credits

See §7.3. Debit is a ledger transaction inside Postgres; the route handler cannot "forget" to
charge because settlement is the same function that unlocks answer persistence.

### 5.5 Watchlist/notebook caps and everything else

Free watchlist cap (1 list × 10 names) enforced by a `BEFORE INSERT` trigger on
`watchlist_items` reading `fn_entitlement('watchlist_items')` — cheapest possible enforcement,
zero app code. Same trigger pattern for saved screens and notes if caps appear later.

---

## 6. Search: Postgres FTS (no external engine)

**Choice: Postgres full-text search + `pg_trgm`, inside the existing $10 Supabase instance.
Cost: $0 incremental.** Rejected: Meilisearch/Typesense (cheapest credible hosting ≈
$10–25/mo + ops), Algolia (order of magnitude more). The corpus is small: 812 securities,
low-thousands of articles, tens of thousands of filings — Postgres FTS with proper GIN indexes
answers this in single-digit milliseconds, comfortably inside the 0.04s the design brags about.

Implementation:

- One denormalized table `search_documents(doc_type, doc_id, ticker, title, body_tsv tsvector
  GENERATED, trigram_label text, weight, url, premium boolean)` maintained by triggers on
  `securities`, `articles`, `filings`, `analyst_profiles`, `holders`. GIN index on `body_tsv`,
  GIN `gin_trgm_ops` on `trigram_label` for ticker/name prefix and fuzzy matches ("aramco",
  "2222", "QNBK").
- `fn_search(p_q text)` runs `websearch_to_tsquery('english', p_q)` union-ranked with a trigram
  pass, returns grouped hits with per-type counts (16a facets). Premium research hits return
  metadata + `premium: true` chip only — body never in the index payload for anon.
- Per-user recents: `search_history(user_id, q, at)` capped at 20 by trigger. Zero-result
  logging into `search_misses(q, at)` feeds the Desk's product-gap panel (26a) for free.
- English-only (locked decision #4) keeps this simple: one `english` config, no Arabic
  analyzer work. A note in the migration marks where an `arabic` tsvector column would attach.

Served via `/api/search/route.ts` with `s-maxage=300` for anonymous queries.

---

## 7. Marsad AI: grounded Q&A over the lake

### 7.1 Provider-agnostic LLM gateway (locked requirement)

Single module `src/lib/llm/gateway.ts`, speaking the **OpenAI-compatible chat-completions
interface** to whatever `LLM_BASE_URL` points at:

```
LLM_BASE_URL=https://openrouter.ai/api/v1        # or https://api.anthropic.com/v1/  (OpenAI-compat)
                                                  # or http://localhost:11434/v1      (Ollama on the Mac)
LLM_API_KEY=…
LLM_MODEL_GENERAL=nousresearch/hermes-3-llama-3.1-70b   # ≈8–18 CR answers
LLM_MODEL_DEEP=anthropic/claude-sonnet-4-5              # ≈20–40 CR answers, thesis regen
LLM_MODEL_UTILITY=…                                      # summaries, embeddings-adjacent chores
```

`gateway.ts` exports `complete()`, `stream()`, and `completeJSON()` (schema-validated), plus a
per-call `route` name (`general | deep | utility`) resolved from env. No provider SDK anywhere
else in the codebase; swapping Anthropic ↔ OpenRouter ↔ local Ollama/LM Studio is an env edit
and a redeploy — zero code change. Anthropic is reached through its OpenAI-compatible endpoint
to keep one client. Timeouts, retry-once, and token accounting live here; every call writes a
row to `llm_calls(route, model, tokens_in, tokens_out, cost_estimate, latency_ms, purpose)` so
the owner can watch spend from the Desk.

### 7.2 Grounded answering (retrieval-first, refuse-if-thin)

The AI answers **only from the data lake**. Pipeline in `src/lib/ai/answer.ts`:

1. **Scope resolve** — `ALL GCC | watchlist | ticker` → candidate object set.
2. **Retrieve** — Postgres FTS over `lake_objects` (VERIFIED only) + `filings` extracted text +
   `concall_segments` + `datapoint_values`, scoped and recency-boosted. No vector DB day one:
   at this corpus size FTS retrieval is adequate and free. DEFAULTED — `pgvector` (already
   available in Supabase at $0) is the designated upgrade if answer quality demands embeddings;
   the retrieval function signature already returns the same `GroundingChunk[]` either way.
3. **Confidence gate** — if top-k retrieval score/coverage falls under threshold, or the
   question needs post-cutoff data, return the **10f refusal**: templated response citing what
   *is* known (e.g. the scheduled Q2 call date from `concalls`), an offer to set a
   transcript-arrival alert, `credits_charged: 0`. The refusal is generated deterministically —
   no LLM call, so refusals genuinely cost us $0 too.
4. **Generate** — `gateway.stream()` with a system prompt that forbids uncited numbers and
   requires `[n]` markers bound to the supplied chunks; answer streamed over
   `/api/ai/ask` (route handler, `ReadableStream`).
5. **Post-verify** — cheap regex pass: every number in the answer must appear in a cited chunk
   (mirror of publishing rule R-04 for the AI surface); violations trigger one regeneration,
   then a refusal. Grounding-cutoff timestamp stamped on the answer.
6. **Persist** — `ai_threads` / `ai_messages(citations jsonb)`; citations render as the 10c
   sources panel with page/slide anchors from chunk metadata.

**Thesis (10d):** same pipeline with a fixed section schema (bull/bear/FV band/catalysts/
invalidation) via `completeJSON()`, cost 40 CR, persisted to `ai_theses(ticker, version)`.
Regeneration triggers: user demand, or the newsroom's material-filing event inserting a row in
`ai_thesis_stale` (consumed by a job). DCF scenarios come from lake `COMPUTED.*` objects, not
the LLM inventing math.

### 7.3 Credit accounting

Append-only `ai_credit_ledger(user_id, delta, reason, thread_id, balance_after)`.

- `fn_ai_debit(p_user, p_mode)` runs **before** generation: locks the balance row, checks
  `remaining >= max_cost(mode)` (18 general / 40 deep), inserts a HOLD row. Insufficient →
  the route returns 402 → `PaywallModal variant="credits"` (10e).
- `fn_ai_settle(p_hold_id, p_actual_cost)` after generation replaces the hold with the actual
  cost (token-derived: `ceil(total_tokens / 400)` bounded to the advertised 8–18 / 20–40
  bands — DEFAULTED formula, owner may override). Mid-answer failure or refusal settles at 0.
  Crash-orphaned holds are voided by a 15-minute sweep in the same monthly-ledger job.
- Monthly allowance is a ledger credit on first use each period (lazy, like meters):
  free +20, premium +500 with 1-month rollover cap (`min(prior_remaining, 500)` carried).
  Top-ups are Stripe one-time payments crediting the ledger. DEFAULTED: top-up SKUs
  SAR 25 = 100 CR, SAR 50 = 220 CR.

**LLM run-cost estimate** at early scale (500 answers/mo, ~3k tokens in / 700 out each via
OpenRouter Hermes-70B at ≈$0.3/$0.3 per Mtok): **≈ $0.60/mo**; even routing Deep to a
frontier model keeps AI under **$5–10/mo**. Local Ollama on the owner's Mac is the $0
fallback for dev and can serve production Deep-mode overnight batch (thesis regen) if desired.

---

## 8. SEO strategy

- **Articles are public-crawlable with honest truncation.** Anonymous requests (including
  Googlebot) get the same server-truncated article as any free reader — no cloaking risk.
  We emit `NewsArticle` JSON-LD with `isAccessibleForFree: false` and `hasPart` →
  `cssSelector: ".paywalled"` per Google's paywalled-content spec, so truncation isn't
  penalized. Free articles emit `isAccessibleForFree: true`. Metadata via `generateMetadata`
  (title ≤90-char headline per R-10, dek as description); social cards from `/api/og` using
  `next/og` (satori) with the 25b social-card fields — no image storage cost.
- **Stock pages are the SEO backbone.** All 812 `/stocks/[ticker]` pages prerendered via
  `generateStaticParams`, cached with `cacheLife({revalidate: 3600})`, tag-invalidated by the
  score batch and filings ingest (`revalidateTag('stock:2222')` called from `/api/jobs/*`).
  `Corporation` + `FAQPage`-style key-stats JSON-LD. Quote header hydrates client-side, so
  crawlers see yesterday's close — correct for a delayed product.
- **Indexable:** ledger, wire (first page), articles, research index, stock pages + subpages,
  filings register + filing details (machine-extracted text is excellent long-tail SEO),
  earnings/dividend/IPO calendars, analyst profiles, learn docs, investor directory.
  **`noindex`:** heatmap, screener, all `(member)` routes, search results, compare (canonical
  chaos), AI surfaces.
- `sitemap.ts` emits split sitemaps (securities / articles / filings) regenerated daily;
  `robots.ts` blocks `/api`, `(member)` paths. Sun–Thu trading week means content freshness
  peaks Sunday — the daily sitemap ping cadence is uniform anyway.
- Canonical host + trailing-slash normalization in `next.config.ts` redirects; no www.

---

## 9. Component architecture

### 9.1 Tokens → Tailwind

`src/styles/design-tokens.json` (from the handoff bundle, S0) is the single source. Tailwind v4
is CSS-first: a tiny build script `scripts/tokens-to-css.mjs` (run in `prebuild`) emits
`src/styles/tokens.css` containing an `@theme` block (`--color-paper`, `--color-ink`,
`--color-score-buy`, the oklch 7-step heatmap scale, spacing/radius/elevation), imported by
`globals.css`. No runtime token plumbing; classes like `bg-paper text-ink` fall out of the
theme. Chart colors are read from the same CSS variables at chart-mount time so
lightweight-charts matches the tokens.

### 9.2 The five extracted components (per component-map.md, S2)

`src/components/ui/`:

| Component | Props (spine) | Notes |
|---|---|---|
| `TickerChip` | `ticker, name, last, changePct, surface, delayed` | server-renderable; free tier always `delayed` per BLK-TICKER rule |
| `RatingBadge` | `rating, surface, size` | vocabulary Buy/OW/Hold/UW/Sell (+ Strong Buy for human analysts only — DEFAULTED per open question 8) |
| `FreshnessBadge` | `state, lastSync, detail, surface` | 6-state; amber=degraded, red never used for feed failure (S1 color law) |
| `DataTableRow` | `cells, emphasis, surface` | the workhorse of screener/watchlist/registers |
| `ScoreModule` | `score, rating, grades, percentile, asOf, pending, surface, locked` | `locked` renders the 4b gate face; `pending` renders 22c's 90-day state |

**`surface="light" | "dark"` is a prop, not a theme context** (S0's explicit rule: data rooms
are always dark, editorial always light — it's a property of the surface a component sits on,
not a user preference). Implementation: each component maps `surface` to a token-alias class
(`surface-dark` sets `--c-bg: var(--color-ink-900)` etc. via CSS variable scoping), so there is
no `dark:` variant explosion and no ThemeProvider. New components are extracted forward-only,
matching the S2 extraction tracker.

### 9.3 Charts

- `src/components/charts/CandleChart.tsx` — client, `next/dynamic`, wraps lightweight-charts;
  used on 1g/3a, 8b, 22c, 1j cumulative-return. Overlay series (TASI compare) supported.
- `src/components/charts/Sparkline.tsx` — **server component**, emits inline `<svg><path>`
  from an array of closes; used in index strips, watchlist rows, movers, email fallbacks are
  plain numbers (no images in email sparklines — deliberate, keeps emails light and free).
- Treemap (1e/2a) — server-computed layout (squarify in `src/lib/charts/treemap.ts`), rendered
  as absolutely-positioned divs; only hover/drill interactions are client. No charting lib
  needed.

---

## 10. Email

- **Rendering:** React Email components in `src/emails/` — `WireBrief.tsx` (19a),
  `PriceAlert.tsx` (19b), `Receipt.tsx` (19c), `VerifyEmail.tsx` (21a), `PasswordReset.tsx`
  (21b), `TrialEnding.tsx` (21c), `PaymentFailed.tsx` (21d), `NewSignIn.tsx` (21e),
  `IpoBooksOpen.tsx` (22d). 600px, three sender identities (`brief@`, `alerts@`, `billing@`,
  `security@` — four From addresses on one domain), shared token-derived styles.
- **Provider:** one interface `src/lib/email/sender.ts` with `EMAIL_PROVIDER=resend|ses`
  drivers. **Recommendation: start on Resend free tier (3,000/mo, 100/day) for all
  transactional mail; move the Wire Brief (and only it) to Amazon SES the week the daily list
  exceeds ~90 recipients.** SES costs $0.10 per 1,000 sends — the fixture's 42,180-recipient
  daily Wire Brief would be ≈ $127/mo on SES vs ≈ $650+/mo on Resend's volume tiers; at
  realistic launch scale (≲300 subscribers) SES is ≈ $0.90/mo. Resend stays for auth/billing
  mail because its deliverability setup and DX are worth $0. SES requires production-access
  approval and DKIM/SPF setup on the sending subdomain (`mail.marsad.com`) — do this in week 1
  regardless, it takes days to warm.
- **Sending path:** `/api/email/send` (CRON_SECRET-guarded) renders React Email → HTML and
  hands to the driver. Wire Brief assembly personalizes per user (watchlist digest section) in
  batches of 50 to stay inside route-handler time limits; the job is idempotent per
  (user, edition-date) via `email_sends` unique key. Suppression list and per-user newsletter
  toggles checked in the same query. Quiet hours don't apply to the Wire Brief (13g).
- **Send-time conflict (open question 5) — DEFAULTED:** one daily reader-facing edition at
  07:30 GST (`30 3 * * *` UTC) day one; the 33c AM/PM 06:00/16:30 pair is a later Desk-config
  upgrade. Owner may override.

---

## 11. Stripe, VAT, and the mada reality check

- **Integration:** Stripe Billing subscriptions with Payment Element embedded at `/checkout`
  (6h). Products: `premium_annual` SAR 1,068 + 15% VAT = SAR 1,228.20, `premium_monthly`
  SAR 119 incl. VAT presentation per 33c; 14-day trial via `trial_period_days`, card collected,
  SAR 0 today, first charge date shown from the subscription schedule (this resolves open
  question 2 in favor of the checkout flow: **card required, SAR 0 due** — the pricing-page
  "no card" copy should be corrected; DEFAULTED). VAT as a fixed 15% `tax_rate` object +
  optional VAT-ID field stored on the customer (Stripe Tax's per-invoice fee is skipped —
  single-jurisdiction VAT doesn't need it; cheapest wins).
- **Webhook:** `/api/stripe/webhook` maintains `subscriptions` (states mirroring the design's
  machine: `trialing → active → past_due → paused`), writes invoices (hosted invoice PDF URLs
  retained ≥10y for ZATCA — Stripe retains them; we also store the PDF URL + totals in our
  `invoices` table), and drives dunning emails off `invoice.payment_failed` with the
  +2d/+5d/+7d schedule configured in Stripe's Smart Retries settings rather than custom cron.
- **mada / regional constraint — FLAGGED:** Stripe has **no Saudi entity and does not process
  mada**, and mada is how a large share of KSA cards actually authorize online. Marsad FZ-LLC
  is a DIFC (UAE) entity, so Stripe UAE works, can present and settle SAR-denominated prices,
  and supports Apple Pay/Google Pay — but the 6h/15d mada logo cannot be honored through
  Stripe. **Pragmatic v1 (DEFAULTED — owner may override):** ship Stripe UAE with
  card + Apple Pay + Google Pay in SAR; drop the mada mark from checkout copy; keep the 6i
  decline-help copy generic. Phase 2, if KSA conversion demonstrably suffers: add a Saudi PSP
  (Moyasar ≈ 1% + fees, or Tap/HyperPay) *only* for mada, behind the same `subscriptions`
  table — this is real work (their subscription billing is weaker) and is deliberately
  deferred. ZATCA e-invoicing integration (FATOORA phase 2) applies to KSA-resident taxpayers;
  as a DIFC entity we retain invoices 10 years and show TRN, and defer FATOORA onboarding to
  the finance workstream.

---

## 12. Reader-owned scheduled jobs

Vercel Hobby allows only daily-precision crons and Vercel Pro crons are coarse; **pg_cron +
pg_net inside the existing Supabase instance is the scheduler ($0)**, calling
`https://<app>/api/jobs/<name>` with `Authorization: Bearer $CRON_SECRET`. All times below are
UTC (GST = UTC+4, no DST).

| Job | Cron (UTC) | Route | Notes |
|---|---|---|---|
| Wire Brief assemble+send | `30 3 * * *` | `/api/jobs/wire-brief` | 07:30 GST; batched, idempotent |
| Sitemap/article-cache refresh | `15 0 * * *` | `/api/jobs/revalidate-daily` | after 04:00 GST score batch lands; `revalidateTag('scores')` |
| Trial T-3 reminders | `0 5 * * *` | `/api/jobs/trial-reminders` | 09:00 GST |
| Alert digest (07:30 daily email pref) | `30 3 * * *` | shared with wire-brief run | quiet-hours: instant push held 18:00–03:00 UTC except halt alerts |
| AI hold sweep + ledger housekeeping | `*/15 * * * *` | `/api/jobs/ai-sweep` | voids orphaned credit holds |
| ICS/meter lazy-rollover safety net | `0 0 1 * *` | `/api/jobs/monthly` | credits rollover audit, Select teaser refresh |

The 04:00 GST score batch, scraping, lake verification, dividend/ownership refreshes, and
dunning retries are **owned by the newsroom/data and billing domains** — the reader only
consumes their outputs and exposes `revalidateTag` endpoints for them to poke
(`/api/jobs/revalidate?tag=stock:2222`, CRON_SECRET-guarded).

Alert **evaluation** (price-cross etc. against delayed snapshots) is a data-domain concern;
delivery lands in `notifications` + email sends that this domain renders. Web push
(lock-screen mocks 13f) is **deferred** — day one channels are in-app inbox + email; WhatsApp
(open question 14) is explicitly out of v1 scope. Both flagged as deliberate cuts.

---

## 13. Table inventory touched by this domain (shared schema, reader-relevant slice)

`venues, market_calendar, venue_freshness, securities, quote_snapshots, ohlcv_daily, indices,
index_snapshots, sector_aggregates, fundamentals_wide (matview), filings, filing_facts,
concalls, concall_segments, earnings_events, estimates_agg, dividends, ipo_offers,
listing_debuts, datapoint_series, datapoint_values, holders, holder_positions, marsad_scores,
marsad_score_factors, marsad_select, articles, article_blocks, article_citations,
front_page_config, nav_config, analyst_profiles, analyst_calls, screen_catalog, saved_screens,
watchlists, watchlist_items, alerts, alert_triggers, notifications, notes, ai_threads,
ai_messages, ai_theses, ai_credit_ledger, usage_meters, plan_entitlements, profiles,
subscriptions, invoices, email_sends, search_documents, search_history, search_misses,
incident_banners, llm_calls, analytics_events`.

Analytics: the 8 reader event types + `paywall_hit`/`trial_start` are inserted fire-and-forget
via `navigator.sendBeacon('/api/beacon')` into `analytics_events` (partitioned monthly).
No third-party analytics — $0 and PDPL-clean (contextual only, no cross-site anything).

---

## 14. Monthly cost model (steady early-stage)

| Line | Cost |
|---|---|
| Supabase Pro (existing, sunk — "$10" mapped to no real tier) | $25.00 |
| Vercel Pro (commercial use requires Pro; Hobby is $0 but ToS-noncompliant once monetized) | $20.00 |
| Amazon SES (all email incl. Wire Brief at ~1k subs; Resend dropped per Revisions) | ~$1–3 |
| LLM via OpenRouter (open-source routing; Deep on frontier) | $2–10 |
| Stripe | per-transaction only (2.9%+ ish, no fixed) |
| Domain/DNS | ~$1.50 |
| **This domain's share** | **≈ $50–60/mo** (platform-wide single source of truth: 06 §7.2, which adds the $5 VPS) |

Explicitly avoided: external search engine (−$15+), Realtime/websocket infra (−$10+),
image/CDN service (next/og + Vercel CDN suffice), analytics SaaS (−$9+), email-marketing
platform (React Email + SES).

## 15. Deliberate deferrals (do not build in v1)

1. WhatsApp alert channel (premium promise in 5a/7c) — needs WhatsApp Business API, template
   approval, per-message fees. Ship push-inbox+email; keep the toggle hidden.
2. Web push notifications — service-worker + VAPID work; in-app inbox covers day one.
3. Public/Enterprise API productization — route handlers are shaped for it; no keys/billing yet.
4. pgvector embeddings for AI retrieval — FTS first; upgrade path documented in §7.2.
5. mada via local PSP — §11.
6. SSE/websocket realtime — §4; delayed data makes it pointless day one.
7. Arabic fields/RTL — locked out; schema comments mark attachment points only.
8. Community-screen moderation tooling (open question 15) — publishing screens is
   premium-only, volume will be ~zero at launch; manual Desk retraction suffices.
9. Boursa Kuwait (open question 6) — reader copy says seven venues; locked decision says six.
   BK renders as a "coming soon" venue row where designs show it. DEFAULTED.

## 16. DEFAULTED decisions index (owner may override)

| # | Decision | Section |
|---|---|---|
| D1 | Free meter follows 33c config (`billing.plan_versions` per 02: **2** premium reads + 3 scores + 20 AI credits monthly) — the "3 free reads" copy is stale marketing per 02 D1; this doc's earlier "3" is superseded | §5 |
| D2 | Trial requires card, SAR 0 today (checkout flow wins over pricing copy) | §11 |
| D3 | Password-reset TTL 30 min single-use (mobile/6c copy wins over 21b's 60) | §1 auth routes |
| D4 | One Wire Brief edition daily 07:30 GST at launch (assembly + send owned by the newsroom/worker per 03/06; PM edition later) | §10 |
| D5 | Heatmap paper edition = `?edition=paper`, one route | §1 |
| D6 | Alert quota taxonomy: all entity-scoped types share the `stock` bucket | §5.3 |
| D7 | Strong Buy valid for human analyst calls only, not ScoreModule | §9.2 |
| D8 | AI credit formula `ceil(tokens/400)` bounded to advertised bands; top-ups SAR 25=100 CR | §7.3 |
| D9 | Token artifacts live at `src/styles/design-tokens.json` | §0 |
| D10 | No mada in v1; Stripe UAE with SAR presentment | §11 |
| D11 | BK venue rendered "coming soon" | §15 |

---

## Revisions (post-review)

Blocking issues resolved (fixes inline above where marked "post-review", otherwise binding
here). **Table names throughout this document map to 02-data-lake.md, which owns all DDL**:
`articles`/`article_blocks`/`article_citations` → `public.content_items`/`content_blocks`/
`lake.citations`; `quote_snapshots` → `public.quotes_latest`(+`quotes_intraday`);
`venue_freshness` → `public.venue_feed_status`; `marsad_scores(+factors)` → `public.scores`;
`index_snapshots` → `public.index_levels`; `market_calendar` → `public.market_sessions`/
`market_holidays`; `concalls`/`concall_segments` → `public.transcripts`/`transcript_segments`;
`datapoint_values` → `public.datapoints`; `estimates_agg` → `public.estimates` (+MVs);
`profiles` → `public.user_profiles`; `usage_meters`/`ai_credit_ledger` →
`billing.usage_meters`/`billing.credit_ledger`; `plan_entitlements` → `billing.plan_versions`;
`subscriptions`/`invoices` → `billing.*`; `notifications`/`email_sends` → `comms.*`;
`analytics_events` → `analytics.events`; `incident_banners` → `ops.incident_banners`;
`llm_calls` → `ops.llm_runs`; `fundamentals_wide` → `public.key_ratios`.

1. **Wire Brief single ownership**: the newsroom domain (03 §10.1, running on 06's VPS
   worker) assembles and enqueues; email dispatch is the worker's SES sender via `q_email`.
   This document's `/api/jobs/wire-brief` route and §10's Vercel-side batching are
   **deleted** — the reader domain owns only the React Email template (`WireBrief.tsx`) and
   the in-app send-history mirror. No Vercel invocation limits apply to sends anymore.
2. **Email infrastructure unified on Amazon SES day one** (06 is authoritative): one sender
   infrastructure, one suppression list, DKIM/SPF/DMARC on `mail.marsad.com`, Supabase Auth
   SMTP pointed at SES (built-in auth email is rate-limited to a handful/hour — a day-one
   need, not newsletter-scale). Resend is dropped entirely; `EMAIL_PROVIDER` driver interface
   stays (SES primary, Resend as a break-glass alternative driver).
3. **Reader realtime**: polling wins platform-wide for reader surfaces (this doc's §4
   argument stands); 06/02 revised to drop the reader-facing Realtime channels. One
   freshness pipeline: `public.venue_feed_status` written by the ingestion sweep (01 §8),
   read via `/api/pulse/*`.
4. **Pattern A caching fixed** (§3.1): cookieless `createAnonClient()` for all `use cache`
   reads; cookie-bound client only in dynamic personalized scope. This was the single
   biggest cost-model bug in the review set.
5. **Ads are now specified** (previously absent; ~10% of fixture revenue): a server-side
   ad-selection module `src/lib/ads/select.ts` called from RSC layouts renders the 6 fixed
   named slots (`ops.ad_slots`/`ad_campaigns`/`ad_creatives` per 02 §15) for
   anon/free tiers only (premium ad-free via the same tier claim). Enforcement server-side:
   3 impressions/reader/day cap checked against a per-session counter cookie + logged
   `ad_impression` analytics events (reconciled nightly); adjacency bans evaluated at
   selection time from page context (never beside halts/retractions/death wires, never in
   Takes/notes); `conflict_tickers` filtering by page ticker; house fallback when no
   campaign qualifies. Slots render as static islands inside cached shells via a small
   dynamic hole (`Suspense`), keeping page caching intact. Impression pacing feeds 32a from
   `analytics.events` rollups.
6. **Anonymous metering simplified — the cookie soft-meter is deleted.** Anonymous readers
   always get the truncated teaser (never metered full reads); the metered "free reads"
   experience begins at sign-in, where `fn_article_render` is dynamic and countable. This
   removes the CDN-cache/Set-Cookie contradiction outright, keeps anon pages fully
   CDN-cacheable, and matches 4a's "3 OF 3 FREE READS USED" (a signed-in surface).
7. **Metered reads are idempotent per article**: `fn_article_render` records
   `billing.article_unlocks(user_id, content_id, period_month)` (02 Revisions) and only
   consumes the meter on first unlock; refreshes and re-reads within the period are free.
8. **SEO paywall markup made real** (§8): full article text is served to **verified
   Googlebot** (UA + reverse-DNS/IP verification in the article route, the documented
   flexible-sampling pattern — not cloaking) with `isAccessibleForFree:false` +
   `hasPart.cssSelector:".paywalled"`; all other anonymous callers get the truncated render.
   If the owner prefers teaser-only indexing, delete the Googlebot branch and the JSON-LD
   `hasPart` claim together.

Improvements adopted: **pgvector alignment** — FTS-only at launch (this doc wins); 06's
day-one `doc_chunks` provisioning moves to the AI phase, embeddings computed in-process on
the VPS (03 Revisions); **Vercel cron dismissal corrected** (§12): Pro supports 40
per-minute-precision crons — pg_cron still wins on $0 and co-location, but for the right
reason; **retention added**: `analytics.events` 13-month partitions and `ops.llm_runs`
12-month pruning ride 02 §20's retention job (no unbounded growth); cost table below
corrected — "Supabase (existing) $10" was a fiction, the platform is on **Pro $25 (sunk)**,
and the platform-wide table in 06 §7.2 is the single cost source of truth; **fx_rates**
added to the §13 inventory (Compare needs USD normalization; table lives in 02 §7);
**trading-week copy is venue-aware** — 16c masthead copy renders per-venue reopen times from
`market_sessions` (DFM/ADX trade Mon–Fri; no blanket "reopens Sunday"); **WhatsApp stripped
from paywall/pricing copy** in v1 (not merely hidden — an undelivered paid feature may not
be advertised); **score-batch coupling removed**: the newsroom's score batch calls
`/api/jobs/revalidate?tag=scores` on completion; the 00:15 UTC fixed-offset cron is deleted;
**RPC surface hardened**: `EXECUTE` revoked from `anon` on all debit/settle/meter functions,
and `/api/screener/run` rate-limited per session/IP (anon-invokable arbitrary-criteria
queries are a CPU-burn vector); **VAT posture softened** (§11): UAE 5% VAT for UAE consumers
and KSA non-resident digital-services registration for the 15% are open finance-workstream
items — the flat 15% `tax_rate` object is a launch simplification, documented as such, and
Stripe Tax remains a candidate once multi-jurisdiction sales are material; **Workbench
(1n/1o/20e) ownership assigned**: it belongs to the **Desk domain (05)** — staff tooling
under `src/app/workbench/**` on Vercel, sharing Desk auth/authz; the reader domain excludes
it; cosmetics fixed (four sender identities, `/api/beacon` → `/api/e` per 05, Next 16
references consistent).

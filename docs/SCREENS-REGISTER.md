# Marsad — Screens Register

_The running ledger of every design screen shared → its route, build status, and the schema
that feeds it. Organised in **batch modules** (the unit in which designs are handed over).
Human-readable precursor to the `public.surfaces` catalog (`BRIDGE-PLAN.md` §3)._

**Status:** `design-received` → `pixel-sample` (built, sample-seeded) → `design-on-real-data`
(built, live data, no placeholder seam) → `live`.

| Batch | Module | Screens | Built | Data |
|---|---|---|---|---|
| **1** | Reader core + data room | 16 | 16 | mixed — 3 live, 13 sample-seeded |
| **2** | Monetization spine | 16 | 0 | schema exists, **0 rows**, no Stripe wiring |
| **3** | Calendars + IPO Center | 5 | 5 | sample-seeded (event tables thin/empty) |
| **4** | Utility surfaces | 8 | 8 | 3 design-on-real-data, 4 sample-seeded, 1 nav-state |

---

# Batch 1 — Reader core & data room

## 1.1 Reader surfaces (sample-seeded)

Built pixel-perfect, rendering from `src/lib/data/sample/*`. Each carries a `DEF-*-LIVE-DATA`
row in `BUILD-STATUS.md` §7 describing the exact swap.

| ID | Screen | Route | Status | Feeds (schema) | Sample module / DEF |
|----|--------|-------|--------|----------------|---------------------|
| 1b | Ledger / Today (home) | `/` | pixel-sample | `content_items`, `index_levels`, `mv_movers`, `quotes_latest`, `filings` | `sample/ledger.ts` · DEF-LEDGER-LIVE-DATA |
| 1d | Newswire | `/wire` | pixel-sample | `filings` (ready), `dividends` (broken), `score_events_feed` | `sample/newswire.ts` · DEF-NEWSWIRE-LIVE-DATA |
| 1h | Watchlist | `/watchlist` | pixel-sample | `quotes_latest`, `v_scores_public` + per-user tables (empty) | `sample/watchlist.ts` · DEF-WATCHLIST-LIVE-DATA |
| 1i | Coverage Desk | `/analysts` | pixel-sample | `analysts` (0), `analyst_calls` (0) | `sample/analysts.ts` · DEF-ANALYSTS-LIVE-DATA |
| 1j | Analyst Profile (template) | `/analysts/[slug]` | pixel-sample | `analysts` — no slug column (migration needed) | `sample/analysts.ts` · DEF-ANALYSTS-LIVE-DATA |
| 1k | Article (template) | `/articles/[slug]` | pixel-sample | `content_items` + `content_blocks` (RLS premium cut) | `sample/research.ts` · DEF-RESEARCH-LIVE-DATA |
| 1l | Research index | `/research` | pixel-sample | `content_items` (1 live) | `sample/research.ts` · DEF-RESEARCH-LIVE-DATA |
| 3a | Stock — Overview | `/stocks/[venue]/[ticker]` | pixel-sample | `securities`, `quotes_latest`, `ohlcv_daily`, `v_key_ratios_public`, `v_scores_public` | `sample/stock.ts` · DEF-STOCK-LIVE-DATA |
| 3b | Stock — Financials | `…/financials` | pixel-sample | `financial_statements` (51k, worker-only → premium) | ″ |
| 3c | Stock — Filings & Concalls | `…/filings` | pixel-sample | `filings` (ready), `transcripts` (0) | ″ |
| 3d | Stock — Ownership & People | `…/ownership` | pixel-sample | `holders`/`ownership_snapshots`/`company_people` (all 0) | ″ |

## 1.2 Data room (dark) — **design applied ON real data**

The first surfaces where the design landed without a sample seam: already correctly wired, so
the pass changed layout + aesthetic only. **The working model for the bridge.**

| ID | Screen | Route | Status | Feeds (schema) | Notes |
|----|--------|-------|--------|----------------|-------|
| 1e | Sector Heatmap | `/heatmap` | **design-on-real-data** | `quotes_latest`, `securities`, `sectors` via `getSectorHeatmap`/`getHeatmapConstituents` | 1W/1M/YTD inert (needs historical sector aggregation); tile area = move magnitude, not free-float mcap |
| 1f | Stock Screener | `/screener` | **design-on-real-data** | `getScreenerUniverse` via `/api/screener/run`; presets w/ live counts | 762-name universe; premium ratio cols stay locked stubs; ranges are min/max inputs, not slider handles |
| 9a | Explore Screens | `/screens` | live | `getPresetScreenSummaries` | Shares the data-room shell |

**Shell rule:** per the 1e/1f handoff the data room deliberately **drops `MarsadNav`** — a
full-bleed focus mode with its own 54px `DataRoomChrome`. Entering from the reader is a mode
switch, not a page nav.

---

# Batch 2 — Monetization spine (4a–4d + 6a–6l)

**Status: design received, digested, NOT built.** 16 screens covering the reusable paywall in
all four contexts plus the complete sign-up → verify → personalize → checkout → account →
sign-out journey.

## 2.1 Paywalls — ONE component, four prop sets

`PaywallModal` is **not four designs** — it is the same 560px card over four blurred
backdrops. Props: `dark?`, `eyebrow`, `chip?`, `title`, `sub`, `b1/b2/b3`, `cta`, `note`.
Backdrop is fixed: real page at `filter: blur(2.5px); pointer-events:none`, scrim
`rgba(20,18,14,.55)`. Dark variant → card `#14120e` on `#33302a`, bullets `#4fc47f`, CTA
inverted.

| ID | Screen | Trigger context | Eyebrow / chip | Feeds |
|----|--------|-----------------|----------------|-------|
| 4a | Article Gate | mid-read over 1k | `PREMIUM RESEARCH` / `24 MIN READ` | `billing.usage_meters` (`premium_reads_mo`), `billing.article_unlocks` |
| 4b | Score / AI Gate | over 3a stock page | `MARSAD SCORE · AI RATING` / `✦ AI` | meters `scores_mo`, `ai_answers_mo`, `ai_credits_mo` |
| 4c | Screener Export | over 1f data room (**dark**) | `DATA ROOM · EXPORT` / `CSV + ALERTS` | plan `limits.saved_screens`, alert limits |
| 4d | Metered Soft Wall | monthly meter exhausted | `FREE MONTHLY LIMIT` / `3 / 3 READ` | `billing.usage_meters` + reset date |

**Already referenced by shipped screens:** the 1k article fade-mask, 1f's export controls, and
3c's phrase-alert limit all point at this component — build it first.

## 2.2 Account journey

| ID | Screen | Shell | Feeds |
|----|--------|-------|-------|
| 6a | Sign Up (SSO + email) | auth shell | `auth.users`, `auth.identities` |
| 6b | Sign In | auth shell | `auth.users`, `auth.sessions` |
| 6c | Forgot Password | auth shell | `auth.one_time_tokens` — never reveals if an address exists |
| 6d | Set New Password | auth shell | ends all other sessions; forbids reuse |
| 6e | Verify Email | auth shell | resend is a **disabled cooldown** (`Resend — 0:42`) |
| 6f | Personalize (1 of 2) | auth shell | `public.user_profiles.market_prefs[]`, `sector_prefs[]`, `currency_pref` |
| 6g | You're Set (2 of 2) | auth shell | reads 6f back as prose; both steps skippable |
| 6h | Checkout | reader | `billing.plan_versions.plans`, `billing.invoices`, Stripe Payment Element **re-skinned** |
| 6i | Payment Declined | reader | `billing.payment_attempts` (`decline_code`, `attempt_no`) |
| 6j | Welcome to Premium | reader | `billing.invoices` receipt; returns user to the article they were reading |
| 6k | Account Settings | **logged-in nav** | `user_profiles`, `billing.subscriptions`, `billing.invoices`, `auth.mfa_factors`, `comms.push_devices` |
| 6l | Signed Out | auth shell | offers sign-back-in **and** the free edition |

**Two shell rules this batch introduces:**
1. **Auth shell drops `MarsadNav`** (6a–6e, 6l) — quiet `#f6f4ee` page, wordmark only, centred
   card. Nothing to wander off to mid-signup.
2. **Logged-in `MarsadNav` variant** (6k and *every* signed-in screen) — "Sign in" + "Go
   Premium" replaced by a `PREMIUM` chip + 32px circular avatar. It is a `user` + `plan` prop
   on the existing nav, **not a separate nav**. A signed-in user seeing "Sign in" is the exact
   bug this state prevents.

## 2.3 Backend reality check (audited 2026-07-23, live DB)

**The monetization schema is BUILT — and materially more complete than the bridge audit
assumed. It is entirely UNPOPULATED.**

| Design structure | Real table / column | Rows |
|---|---|---|
| `session.plan` | `billing.subscriptions.plan_key` + `.status` | **0** |
| `session.meter {articlesRead, limit, resetsOn}` | `billing.usage_meters (user_id, meter_key, period_month, used)` + plan limits | **0** |
| `plan {basePrice, vatRate, effectiveMonthly, trialDays}` | `billing.plan_versions.plans` (jsonb, **versioned**) | 1 |
| `invoices[]` | `billing.invoices` — incl. `vat_rate`, `vat_amount_sar`, `seller_trn`, `buyer_vat_id`, `zatca_payload`, `pdf_path` | **0** |
| `declineState {code, attemptsRemaining}` | `billing.payment_attempts (decline_code, attempt_no, outcome)` | **0** |
| `onboarding {markets, sectors, currency}` | `public.user_profiles (market_prefs[], sector_prefs[], currency_pref, onboarded_at)` | **0** |
| trial / dunning / cancel | `subscriptions.trial_ends_at`, `.dunning_state`, `.next_retry_at`, `.cancel_at_period_end` | **0** |
| 4a per-article unlock | `billing.article_unlocks (user_id, content_id, period_month)` | **0** |
| promos / credits | `billing.promo_codes`, `billing.credit_ledger` | **0** |
| user accounts | `auth.users` (Supabase Auth, MFA + sessions tables present) | **0** |

**Functions that already exist:** `billing.consume_meter` (the metering RPC behind 4a/4b/4d),
`billing.live_plan` (resolves the active plan version), `public.custom_access_token_hook`
(stamps the JWT claim), `public.jwt_tier` (the RLS entitlement read used by
`content_blocks`/`scores`). Migration: `supabase/migrations/20260713000010_billing.sql`.

**Live pricing (`plan_versions` v1) — matches the design:**
- `premium_monthly` **SAR 119** ✅ design's "VS SAR 119 ON MONTHLY"
- `premium_annual` **SAR 1228.20** `vat_incl:true` → **÷12 = SAR 102.35** ✅ design's "≈ SAR 102.35 / MONTH"
- `enterprise` from SAR 24,000 · `free` price 0

> ✅ **RESOLVED (owner, 2026-07-26): keep 3 free reads.** The design copy ("3 OF 3 FREE READS")
> wins. **Action:** `billing.plan_versions` free meter `premium_reads_mo` must change **2 → 3**
> (via a new `plan_versions` version row when Batch 2 is built — the table is versioned; do not
> mutate v1 in place). Free tier is now **3 reads / 3 scores / 5 AI answers**.

**What is genuinely missing** (not schema — wiring):
1. **No Stripe integration at all** — "stripe" appears only as *column names*; no SDK, no
   `supabase/functions`, no webhook handler, no checkout session creation.
2. **`custom_access_token_hook` is not enabled** in Supabase Dashboard → Auth → Hooks (a known
   owner action item) — so `jwt_tier` never gets stamped and the premium RLS cut can't fire.
3. **No `(auth)` route group** in the Next app — no sign-in/up/reset routes exist.
4. **No logged-in nav variant** — `MarsadNav` ships anon-only today.
5. Zero rows everywhere — no user has ever been created.

# Batch 3 — Calendars + IPO Center (8a + 23a + 22a–22c)

**Status: built pixel-perfect, sample-seeded.** The forward-looking event surfaces —
the earnings/dividend weeks and the full IPO pipeline → offer → listing-day arc. Each
renders from `src/lib/data/sample/*`; the real reads already exist in
`src/lib/data/calendars.ts` (this batch is a **layout pass over an existing real-data
scaffold** — the prior `/ipo` pages rendered those queries behind an `EmptyState`).

| ID | Screen | Route | Status | Feeds (schema) | Sample module / DEF |
|----|--------|-------|--------|----------------|---------------------|
| 8a | Earnings calendar | `/earnings` | pixel-sample | `earnings_events` (has rows; `eps_consensus`/`eps_marsad` NULL, `report_date` uniform) | `sample/calendars.ts` · DEF-CALENDARS-LIVE-DATA |
| 23a | Dividend calendar | `/dividends` | pixel-sample | `dividends` (**0** `state='live'`, ex/pay dates NULL) | `sample/calendars.ts` · DEF-CALENDARS-LIVE-DATA |
| 22a | IPO pipeline | `/ipo` | pixel-sample | `ipo_offers` (**0 rows**) via `getIpoPipeline`/`getIpoJustListed`/`getIpoKpis` | `sample/ipo.ts` · DEF-CALENDARS-LIVE-DATA |
| 22b | IPO offer detail (template) | `/ipo/[offerSlug]` | pixel-sample | `ipo_offers` via `getIpoOffer` | `sample/ipo.ts` · DEF-CALENDARS-LIVE-DATA |
| 22c | IPO listing-day (template) | `/ipo/listing/[slug]` | pixel-sample | `listing_debuts` (0) + intraday `quotes` | `sample/ipo.ts` · DEF-CALENDARS-LIVE-DATA |

**Signature contract columns unbacked today** (why sample, not real): the earnings screen's
street **consensus** and the **Marsad desk estimate** (`eps_consensus`/`eps_marsad`) plus the
confirmed/estimate week-forward `Δ EST` state; the dividend **ex-date ledger** (all ex/pay
dates NULL) and payout-> 100% cut-risk flag; the entire IPO tier (0 offers, 0 debuts).
The premium-gated **Marsad Take** (22b) and **Marsad Score · PENDING** card (22c) reuse the
existing entitlement/score seams. Wiring path is one DEF row: **DEF-CALENDARS-LIVE-DATA**.

**Route note:** 22c is a **new** route (`/ipo/listing/[slug]`) — the listing-day view is
distinct from the offer detail (`[offerSlug]`), so it does not collide with the single-segment
`[offerSlug]` matcher.

# Batch 4 — Utility surfaces (16a–16c + 5a + 18a + 10d + 17f + 20f)

**Status: ingested + built (2026-07-26).** The journey-integrity surfaces. Three were
**already built as design-on-real-data** and only needed registering; four are net-new
sample-seeded builds; one is a nav-level state enhancement.

## 4.1 Net-new builds (sample-seeded)

| ID | Screen | Route | Status | Feeds (schema) | Sample module / DEF |
|----|--------|-------|--------|----------------|---------------------|
| 5a | Alerts manager | `/alerts` | pixel-sample | `usage_meters`/`billing.consume_meter` caps (0 rows) + per-user alert store (none) | `sample/alerts.ts` · DEF-ALERTS-LIVE-DATA |
| 16b | Notifications panel | nav island (`NotificationsBell`) | pixel-sample | shares the alert source model (0 rows) | `sample/alerts.ts` · DEF-ALERTS-LIVE-DATA |
| 10d | AI thesis | `/stocks/[venue]/[ticker]/thesis` | pixel-sample | LLM over `filings`/`transcripts`, credit-gated (none) | `sample/thesis.ts` · DEF-THESIS-LIVE-DATA |
| 17f | Two-factor enable | `/settings/two-factor` | pixel-sample | `auth.mfa_factors` + `(auth)` group (neither built) | inline · DEF-TWOFACTOR-LIVE-DATA |

- **16b** is an **anchored panel, not a page** — a `NotificationsBell` client island added to
  `MarsadNav`'s utility cluster (bell + unread count → 392px overlay, light scrim + 1.5px blur).
  Footer hands off to 5a. Additive; ships with a shared sample set (member surface, ungated).
- **10d** added an **"AI Thesis" tab** to the shared `StockHeader` tab bar (additive) — two
  independent lenses (quant Score vs narrative thesis); every claim carries a numbered citation.
- **5a** caps ARE the monetisation surface (stock 8/10→800, screen 2/2→75, phrase 2/2→50,
  turning red at the limit); composer is a sentence of pills; states TRIGGERED/●ARMED/PAUSED.
- **17f** is self-contained; `Account` (6k) + `Cancel` are inert (no `(auth)` group → no 404).

## 4.2 Already design-on-real-data (registered, not rebuilt)

| ID | Screen | Route | Status | Notes |
|----|--------|-------|--------|-------|
| 16a | Search results | `/search` | **design-on-real-data** | Federated FTS (`fn_search`/`runSearch`); top-match + filings + research + people + 17c no-results. Verified live (nav change didn't break it). |
| 18a | Compare | `/compare?t=…` | **design-on-real-data** | Server-computed from `resolveSecurity`+`getCompareEntity`; up to 4 venue:ticker pairs, USD-normalised mcap. `noindex`. |
| 20f | Learn / Help & policies | `/learn` | **design-on-real-data** | Authored docs (`learn/docs.ts`) + the master-disclaimer "Important" callout. Deliberately scoped down from 20f's broader help-center (FAQ grid / support ticket not built — would document features that don't exist yet). |

## 4.3 Nav-level state

| ID | Screen | Where | Status | Notes |
|----|--------|-------|--------|-------|
| 16c | Market-closed masthead | `NavIndexStrip` + `NavTabs` | **built (real-state-gated)** | GCC trades Sun–Thu. When `useMarketOpen()` is false the index strip **desaturates** (grey levels, colour dropped — Thursday's close must not read live), the clock chip flips **LIVE → CLOSED**, and the status label carries a reopen hint (`nextOpenLabel()` → "Closed · opens Mon 10:00", TDWL-referenced). Gated on real trading hours (`lib/market/hours.ts`), so open-hours rendering is unchanged. Holiday-aware answer stays server-side (`getMarketState()`); this mirror is the client fast-path. |

---

_Every new screen the owner shares gets a row here first (`design-received`), then flows
through the lifecycle. Mirrored by `public.surfaces` once that catalog lands (BRIDGE-PLAN
Phase 0)._

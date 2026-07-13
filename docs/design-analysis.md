# Marsad Platform — Design Analysis

> Synthesized from the full design canvas (`Marsad Platform.dc.html`, ~181 screen analyses), `README.md`
> and `admin-plan.md` in the design handoff bundle. This document is the backend/product-shaping
> read of the designs: catalog, entity model, state machines, jobs, and business rules as observed.
> Date of synthesis: 2026-07-13.

---

## 1. Product summary

**Marsad** ("observatory" in Arabic) is a GCC-focused equities intelligence platform covering the
six/seven Gulf exchanges — **TDWL (Tadawul), DFM, ADX, QE/QSE, MSX, BHB** (plus Boursa Kuwait on
reader surfaces) — across a universe of **812 GCC listings**. It blends an editorial-grade markets
newsroom with quantitative data products (Marsad Score, screener, AI copilot) under a
subscription-first business model (free metered tier → Premium at SAR 89/mo billed annually,
SAR 1,228.20/yr incl. 15% KSA VAT).

Three products share one design language:

1. **Reader product** (web + mobile + transactional email). Front page ("Ledger"), Newswire,
   dark-room Heatmap and Screener, stock workspaces, watchlists, alerts, earnings and dividend
   calendars, IPO Center, analyst hub with public track records, Marsad AI (grounded, cited,
   credit-metered), Notebook, Learn/explainers, auth/billing, and a full email suite.

2. **Marsad Desk** (admin console, desktop-only, dark AdminRail + paper canvas). Dashboard,
   navigation manager, CMS (library/editor/front-page curation), editorial analytics, agent
   operations + owner approval queue, data lake browser, publishing rules, subscribers/revenue,
   team & roles (humans + agent service accounts), ads manager, market data ops, listings &
   payouts desk, monetization & comms.

3. **Agent newsroom** — the operating model connecting the two:

   ```
   DATA AGENTS → datapoint lands in the DATA LAKE (typed, verified objects)
     → WRITER AGENT drafts, citing only VERIFIED lake objects
       → DESIGN & PUBLISHING AGENT edits, runs PUBLISHING RULES (R-01…R-10), fits a TEMPLATE (TPL-01…08)
         → APPROVAL QUEUE → the human owner approves → LIVE
   ```

   Hard lines: **agents never publish** (single exception: wire briefs ≤ 40 words via the
   publishing agent), **never touch billing**, **never change rules**. Every price-sensitive data
   change (dividends, IPO facts) requires a human confirm before fan-out. Humans and agents are
   principals in one permission model and produce identical audit records.

The design fixture is internally consistent around a single moment — **SUN 12 JUL 2026, 09:41 GST**
— with two threaded incidents: the MSX vendor feed timeout (since 09:19) propagating from feed ops
to reader DELAYED badges to the agent roster, and the stc (7010) interim DPS raise 0.50→0.55
(disclosure 09:08 → lake object verified 09:09 → auto-published TPL-01 wire 09:12).

---

## 2. Complete screen catalog

Format per entry: **id — name**: purpose · key data · gating · backend notes.

### 2.1 Reader web (74 screens)

**Front pages & market surfaces**

- **1b — Front page "Ledger"**: editorial front page mixing lead feature, story grid, analyst-call
  strip, live TASI/macro rail, wire module, movers, MARSAD SELECT promo. Gating: MARSAD SELECT
  (5 AI-ranked names, monthly rebalance) premium-only teaser. Backend: `/frontpage` aggregation of
  CMS + quotes + movers + wire; monthly Select rebalance job.
- **2b — Front page, Market Edition**: data-forward variant — Score daily-move feed, index strip
  with sparklines, sector band with index weights (Energy 41.2% … Transport 2.6%), movers by abs
  move across venues, live wire, week-ahead calendar. Backend: score-change event log, composite
  index weights, cross-venue movers ranking.
- **1d — Newswire**: real-time wire firehose with category/venue facets, DEVELOPING items,
  degraded-feed banner (LAST SYNC/RETRYING), raw filings rail, corp-actions rail, most-read;
  "turn this view into an alert". Backend: SSE/WS feed with connection health; filter-set→alert
  persistence; per-facet counts.
- **1e — Sector heatmap (dark data room)**: GCC treemap sized by free-float mcap, colored by
  1D/1W/1M/YTD return; per-venue freshness (MSX DELAYED · SYNCED 14:26); breadth stats
  (312 ADV/198 DEC/44 UNCH). Backend: cross-venue snapshot with per-venue sync state, sector
  aggregates, export endpoint.
- **2a — Heatmap, paper edition**: light variant of 1e with sector-row treemaps, 7-index strip,
  oklch 7-step scale. Gating: free tier limited to daily view (1W/1M/YTD implied premium).
- **1f — Stock screener (dark)**: 812-listing universe, saved screens, filters incl. Marsad Score
  ≥ threshold, live "APPLY — N MATCH", CSV export, save-as-alert, send-to-watchlist, community
  Explore tab. Backend: screening query engine with count-only fast path; saved-screen store.
- **1g — Stock page (Aramco 2222)**: quote (15-min delayed free tier), key stats, candle chart
  with TASI overlay, analyst consensus (14 ratings, avg PT), Marsad Score dark card (76 · BUY,
  5 factor grades, sector percentile, 04:00 GST stamp), 43 analyst-maintained tracked datapoints,
  financials summary, dividend card, news/filings, premium research, peers. Gating: full
  statements/segments/models premium; premium research chips. Backend: quote+FX, OHLCV, consensus
  aggregation, nightly score batch, datapoint series store, entitlement-tiered financials.
- **1h — Watchlist**: multi-list, venue-grouped rows with score/PT-upside/next-event/alert bell;
  equal-weighted daily summary; active-alerts panel (ARMED/TRIGGERED); private notes panel.
  Backend: watchlist CRUD, alert engine (price cross, score change, ex-div reminder, index
  drawdown), events-calendar join.
- **16a — Global search results**: federated results (stocks incl. AR names, filings, research,
  people) with per-type counts, 0.04s latency, AI handoff, recent searches. Gating: PREMIUM chips
  on research hits. Backend: federated index, per-user search history.
- **16b — Notifications panel**: bell dropdown — price alerts, earnings, phrase matches, research
  follows; unread state, mark-all-read. Backend: notification fan-out + read-state sync.
- **16c — Market-closed state**: weekend masthead variant — "reopen Sunday 10:00 AST", Thursday's
  close, weekend reading, opens-Sunday events. Backend: per-venue market calendar/clock service.
- **17a–17e — Empty/error/loading states**: empty watchlist (quick-add suggestions), empty alerts
  (4 trigger types × 3 channels), zero-result search (GCC-only coverage + coverage-request
  intake), 404 ("This page has delisted."), stock-page shimmer skeleton.
- **17f — 2FA enable (step 1 of 2)**: TOTP QR + manual key, 6-digit confirm, 10 single-use
  recovery codes on step 2. Backend: TOTP provisioning, recovery-code issuance.

**Stock workspace (3a–3d)**

- **3a — Overview**: editable 9-cell ratio strip, AI-generated profile with citations,
  machine-generated pros/cons + disclaimer, desk view (analyst rating/PT quote), multi-metric
  chart tabs (Price/P/E/Sales&Margin/EV·EBITDA/P/B), peer table with median-ex-self. Backend:
  LLM profile pipeline with provenance, peer-group service, per-user ratio preference.
- **3b — Financials**: 8 rolling quarters (incl. `JUN '26E` desk estimate) + 10-year annual P&L,
  CAGR cards, selected BS/CF, per-quarter Tadawul PDF links, XLSX export, SEGMENTS/Y-Y views.
- **3c — Filings & concalls**: company-scoped announcement feed with category chips + phrase-alert
  saving (meter 2/2 free, 50 premium), earnings-call archive (Transcript/Deck/AI summary·PREMIUM),
  annual reports, next events, related research. Backend: per-ticker phrase alerts against shared
  meter; concall asset store.
- **3d — Ownership & people**: quarterly shareholding matrix by category, foreign-ownership record
  badge (1.19%), top holders with q/q change, float-watch callout, board (11 seats · 5 indep.) and
  management. Backend: ownership snapshots, record detection, holder entity linkage.

**Filings register (7a–7d)**

- **7a — Announcements register (global)**: all disclosures across 7 venues; facets by type/venue/
  date; phrase search; save-view/save-as-alert; market-moving "big" rows; most-tracked phrases;
  top filers; CSV/PDF export. Gating: 2 free phrase alerts (meter shown 2/2 red) vs 50 premium.
- **7b — Register filtered to one company**: 2222-scoped register with quote+score rail,
  company-scoped alert creation. Backend: issuer-parameterized queries, quarterly filing counts.
- **7c — Phrase-alert cap paywall**: PaywallModal at 3rd phrase alert; premium = 50 phrase / 800
  stock / saved-screen alerts, WhatsApp delivery, CSV export, SAR 89/mo; existing free phrases
  grandfathered. Backend: server-side entitlement check at alert creation.
- **7d — Filing detail**: full machine-extracted text, type-specific fact grid (DPS/ex/record/pay),
  Marsad AI summary with cross-filing context, provenance to source ID (TADAWUL CG-1-2026-4471),
  bilingual AR/EN PDF, related filings/coverage. Backend: bilingual PDF pipeline → typed
  extraction → AI summary; market-moving classification.

**Paywalls (4a–4d)** — one shared PaywallModal component, parameterized:

- **4a — Article mid-read gate**: hard gate after 3 visible paragraphs; "3 OF 3 FREE READS USED".
- **4b — Score & AI gate on stock page**: Marsad Score/factor grades/Select/AI copilot premium;
  "AI RATINGS UPDATED 04:00 GST DAILY".
- **4c — Screener save/export gate (dark variant)**: viewing results free; save/alert/CSV/terminal
  export premium; "FILTERS STAY APPLIED AFTER YOU UPGRADE".
- **4d — Research index soft meter wall**: 3/3 monthly reads used, resets on the 1st; explicit
  "come back next month" option.

**Alerts**

- **5a — Alerts Manager**: single ledger for stock (price/score/events/ratios), screen-match, and
  phrase alerts; inline composer; caps free 10/2/2 vs premium 800/75/50; delivery prefs (push,
  instant email, 07:30 daily digest, WhatsApp·PREMIUM); quiet hours 22:00–07:00 GST with
  market-hours-trigger exemption; live trigger log. Backend: condition evaluation engines per
  type, quota service, multi-channel dispatch, quiet-hours suppression.

**Auth, billing, account (6a–6l)**

- **6a — Sign up**: Google/Apple SSO or email+password (8+ chars/number/symbol), Wire Brief
  opt-in, dark value panel with live indices, language switcher.
- **6b — Sign in**: remember-me 30 days; personalized "TASI +0.42% since you left".
- **6c — Forgot password**: signed 30-min single-use link; anti-enumeration (unknown addresses get
  sign-up instructions).
- **6d — Set new password**: strength meter incl. not-a-prior-password check; revokes all other
  sessions; confirmation email.
- **6e — Verify email**: 30-min link, ~60s resend cooldown, edit address.
- **6f — Onboarding step 1**: markets (7-venue grid with live changes), sectors (min 1),
  LOCAL/USD currency — tunes front page, screener defaults, Wire Brief.
- **6g — Onboarding step 2**: follow analyst / seed watchlist (4 tickers) / run starter screen
  (Gulf Dividend Aristocrats, 10 matches).
- **6h — Checkout**: Stripe Payment Element; card/Apple Pay/Google Pay, mada; KSA VAT 15%, VAT ID;
  annual/monthly toggle; promo code; SAR 0 due today, first charge 19 Jul 2026 = SAR 1,228.20;
  refund of unused full months on cancel.
- **6i — Payment declined**: CARD_DECLINED mapping, 3 attempts then 24h hold, mada e-commerce
  guidance, order reserved, trial starts only on verification.
- **6j — Welcome to Premium**: order MP-2026-08114, receipt + PDF invoice, T-3 reminder promise,
  unlock cards, return-to-article context.
- **6k — Account settings**: profile, membership & billing (invoice history incl. scheduled
  charges, SAR 0 auth on card update), preferences (currency, newsletter toggles), security
  (password, 2FA flag, device sessions with revoke, log-out-all).
- **6l — Signed out**: single-device session end; data-persists reassurance.

**Earnings (8a–8d)**

- **8a — Earnings calendar**: week-paginated MENA calendar — consensus vs Marsad estimate vs
  prior, PRE/POST session, ● CONF/○ EST date states, already-reported rail with surprise +
  next-session reaction, ICS export, watchlist filter.
- **8b — Earnings event detail (SNB Q2)**: BEAT +4.2% verdict; EPS actual/consensus/Marsad
  ("closest of 14"); P&L-vs-consensus table with polarity-aware surprise; segment bars; desk take;
  links to FS-1 filing, concall (SOON), coverage, revisions; overnight Revisions grade B→B+.
- **8c — Estimates & revisions**: Marsad-vs-street FY26 EPS revision series (90d), leaders/laggards
  with breadth, Revisions-grade changes feeding the Score, coverage positioning (31 above street /
  18 in line / 12 below).
- **8d — Surprise scorecard**: season stats (28/58 reported, 68% beat, +1.6% avg), beat-rate by
  sector, surprise histogram, 12-quarter serial beaters, "screen this" hook.

**Screens/Explore (9a–9d)**

- **9a — Explore gallery**: curated hero themes, grouped screens, sector chips, trending-by-runs,
  library entry. Backend: screen catalog + run-count analytics.
- **9b — Screen preview**: criteria DSL (`Sector = Banks AND P/B < 1.0 AND …`), 3 of 7 matches
  free with blurred locked rows, 3Y equal-weight backtest vs TASI (+41% vs +18%, 73% hit rate,
  quarterly rebalance) with disclaimer, fork/follow/alert. Gating: full results premium.
- **9c — Community & analyst screens**: analyst vs member badging, followers/forks; publishing
  screens is premium-only.
- **9d — My screens**: saved library (free cap 5), per-screen match alerts, run history,
  fork/build/follow onboarding.

**Marsad AI (10a–10f)**

- **10a — AI hub**: ask bar with scope (ALL GCC/watchlist/one company) and mode (GENERAL/DEEP);
  credit card 417/500 monthly, GENERAL ≈8–18 CR, DEEP ≈20–40 CR, resets 1 AUG, top-ups; recent
  threads; corpus stats (812 companies · 7 venues · filings since 2018); privacy default.
- **10b — Company slide-over (2222)**: grounding inventory (FY25 AR · 4 concalls · 214 filings ·
  ratings), filing-driven suggested questions, jumps to thesis/concall summary/risk extract.
- **10c — AI answer**: cited prose + generated table with per-row source refs; sources panel with
  page/slide anchors and pull-quotes; follow-ups incl. "Turn this into a screen"; CSV export, add
  to Notebook; helpful/flag feedback; 14 CR charged.
- **10d — AI thesis (2222)**: standing per-company thesis — cited bull/bear cases, DCF × 3 oil
  decks fair-value band (23.50/29.80/34.20 vs last 27.15), 90-day catalysts, invalidation
  conditions; regenerates on material filings or on demand (40 CR); quant-vs-narrative divergence
  is itself a desk signal.
- **10e — Credits-exhausted paywall**: free 20/mo vs premium 500/mo (~40 answers) + Deep mode +
  thesis regeneration; premium credits roll 1 month; top-ups from SAR 25.
- **10f — Low-confidence refusal**: "CAN'T GROUND THIS — 0 CREDITS CHARGED"; knows the scheduled
  Q2 call date; corpus-negative assertion ("no filing since 2018 contains a buyback commitment");
  one-tap transcript-arrival alert.

**Analysts & research (1i–1m, 20d)**

- **1i — Analyst hub ("The Coverage Desk")**: 6 analysts · 61 names; trailing-24-month
  leaderboard (win rate = calls beating venue index over holding period), ratings changes this
  week, sector coverage bars, premium coverage-initiation voting, apply-to-publish.
- **1j — Analyst profile (Noor Al-Suwaidi)**: rank #1, 71% win rate, +9.4% avg call return vs
  TASI, cumulative chart, current coverage with per-call returns, pinned call, 84 pieces,
  disclosure ("no positions; track records cannot be edited retroactively").
- **1k — Article premium gate**: premium research article with visible thesis box, rating
  attachment strip (1120 Overweight PT 112), body fade → PaywallModal; in-piece live ticker rail;
  related PREMIUM/FREE items.
- **1l — Research index**: topic/venue/sort filters, featured hero (model file attached), card
  grid with PREMIUM/FREE chips, email-series subscription blocks (Wire Brief daily 07:30 GST,
  Deposit Wars weekly Sunday, Vision 2030 Monitor monthly).
- **1m — Pricing**: the monetization spec — Free (15-min delay, 3 research/mo, 1 watchlist × 10,
  daily heatmap, Wire Brief) vs Premium SAR 89/mo annual · SAR 119 monthly, 14-day trial no card;
  enterprise "Marsad Terminal + API from SAR 24,000/yr"; FAQ (refunds, not-advice, AR roadmap).
- **20d — Apply to publish**: external analyst application (coverage focus, credentials, 300-word
  sample thesis); revenue share on subscriptions; desk-lead review ~5 business days.

**Compare, datapoints, concalls (18a–18d)**

- **18a — Compare**: up to 4 names cross-venue, USD-normalized at spot, sector-aware metrics
  (banks add NIM), best-in-row bold, AI handoff, export.
- **18b — Datapoint series detail**: analyst-maintained series (Gas production, BCF/D quarterly);
  per-value provenance to a filing; named maintainer; 24h revision SLA; series alerts; peer
  overlay.
- **18c — Concalls global feed**: lifecycle UPCOMING → TRANSCRIBED → AI SUMMARY READY; this-week
  schedule with local timezones; cross-transcript AI ask.
- **18d — Transcript reader (SNB Q2)**: synced audio + diarized, desk-reviewed transcript;
  chapters; AI summary with cross-quarter novelty ("first buyback mention in 4 quarters");
  in-transcript search; Marsad's own analyst appears in Q&A.

**Notebook & people (20a–20c, 20f)**

- **20a — Notebook**: private ticker-tagged notes with pinning; clip-from-anywhere captures source
  link + automatic price snapshot; PDF export per ticker; AI summarize-my-notes hook; private
  unless published.
- **20b — Investor & shareholder directory**: sovereigns/institutions/family offices/funds from
  disclosed >5% stakes and fund filings; holdings counts, AUM (self-reported flag), last-change
  events.
- **20c — Investor detail (PIF)**: 18 GCC holdings, $186B disclosed, positions with QoQ stake
  deltas, sector tilt, recent moves, holder-disclosure alerts.
- **20f — Help & legal center**: help topics, policies, methodology docs (Score, AI grounding,
  data sources), regulatory identity (Marsad FZ-LLC, DIFC, regulated by DFSA), 1-business-day
  support SLA.

**IPO Center & dividends (22a–22c, 23a)**

- **22a — IPO Center pipeline**: stage-grouped ledger (subscription open / bookbuilding /
  announced & filed), coverage ratios (≥1× green), urgency chips, just-listed aftermarket rail,
  alert + ICS hooks, how-subscribing-works education.
- **22b — IPO detail (OQBI)**: 5-stage timeline with per-stage coverage (inst 4.6× / retail 3.1×),
  offer-facts grid, use of proceeds, prospectus financials with implied P/E 7.9× / yield 11.4%,
  broker APPLY list (Marsad takes no orders), close countdown + reminder toggle, blurred premium
  Marsad Take (fair value OMR 0.128).
- **22c — Listing day (Bina 9615)**: live 1-min debut chart vs offer, opening auction/VWAP/free-
  float-traded, allocation recap, wire tie-in, **Marsad Score PENDING** (90-trading-day rule,
  first score 28 Nov 2026, grades seed from prospectus), listed-peers compare.
- **23a — Dividend calendar**: week ledger grouped by ex-date ("own before the ex-date open"),
  DPS in local ccy, FINAL/INTERIM/SPECIAL, per-row alert set state, watchlist cross-ref, yield
  leaders with payout>100% cut-risk flags, ICS export, 2-day reminder promise.

### 2.2 Marsad Workbench — analyst/reviewer console (3 screens)

- **1n — Workbench analyst dashboard**: today's tasks (due, stale series >30d, rating REVIEW DUE
  at 90 days / PT-gap), datapoint quick-add (publishes to the Wire, computes vs-prior delta,
  requires source), coverage health with freshness dots, drafts (DRAFT/IN REVIEW/SCHEDULED),
  30-day audience stats incl. 31% read→trial, editorial queue (reviewer R. Khalifa, 24h SLA),
  compliance status.
- **1o — Workbench coverage editor**: block composer (paragraph/heading/pull quote/exhibit/data
  table/**live datapoint embed**/rating box/ticker mention), members-only XLSX attachments,
  access PREMIUM/FREE toggle, schedule vs publish-on-approval, attached rating with follower
  fan-out warning (pings 2,140 QNBK followers), disclosure checklist as submit precondition.
- **20e — Workbench reviewer queue**: REVIEWER role; submissions (Article/Rating/Datapoint/Note)
  with 24h SLA countdowns, near-SLA red at ≤6h, versioned edits + disclosure flags, median
  turnaround 6.2h.

### 2.3 Article templates & story blocks (9 screens)

All templates carry auto-select rules evaluated by the Design & Publishing (Editor) agent:

- **28a — TPL-01 Wire brief**: single event, <90 words, **auto-publish eligible** (only
  human-free path); BLK-TICKER + BLK-DELTA; specimen live 4 min after source disclosure.
- **28b — TPL-02 Chart-led brief**: one dominant numeric series in cited lake data; BLK-CHART +
  BLK-STATSTRIP; full agent byline chain (WRITER-2 → EDITOR-2).
- **28c — TPL-03 Ticker deep-dive**: ≥70% citations on one ticker + >500 words; sticky
  BLK-KEYSTATS + BLK-SCORE rail; serves ARTICLE · NOTE.
- **28d — TPL-04 Earnings recap**: results event with consensus table in lake; BLK-BEATMISS
  (verdicts derived from BLK-RVC deltas, thresholds in rules 29b) + BLK-RVC + BLK-QUOTE.
- **28e — TPL-05 Ranked list**: screener-snapshot citation + ordered entities; repeating
  BLK-RANKROW (yield/payout/cover/score/raises-5y), timestamped snapshot methodology.
- **28f — TPL-06 Explainer**: evergreen flag + NO price-sensitive citations; BLK-DEF/STEPS/
  GLOSSARY; quarterly desk review; reading level metadata.
- **28g — TPL-07 IPO/offer profile**: offer-facts object in citations; BLK-FACTS + BLK-TIMELINE
  bound live to IPO pipeline objects ("TRACKS IPO CENTER LIVE", day-of-window counter);
  premium-gated Marsad Take block within a free page.
- **28h — TPL-08 Analyst note / Marsad Take**: verdict object (fair value + rating) in citations;
  **ALWAYS PREMIUM**; BLK-VERDICT/SCENARIO/RISK; "VERIFIED VS LAKE 14/14"; probability-weighted
  fair value computed from scenario table.
- **28i — BLK-\* registry**: 14 reusable blocks, each bound to a data-lake object type
  (writer agents cite the object, editor agents place the block; CMS "+ ADD BLOCK" uses these
  IDs). Notable: BLK-TICKER 15-min delayed for free readers; BLK-EXDATE shares the dividend
  entries source with calendar 23a; BLK-FACTS/TIMELINE share IPO pipeline objects with 22a/22b.

### 2.4 Emails (9 screens, 600px send width, three sender identities)

- **19a — Wire Brief daily** (brief@marsad.com, 07:30 GST): index snapshot, lead + 3 briefs,
  personalized watchlist digest (triggered alerts, filings count on followed names).
- **19b — Price-alert email** (Marsad Alerts): trigger context + news enrichment + Score/desk
  rating at send time.
- **19c — Receipt/trial-started** (Marsad Billing): order line items, VAT, scheduled first charge,
  TRN footer, PDF invoice.
- **21a — Verify email**: 6-digit OTP, 15-min TTL, single use.
- **21b — Password reset**: one-time 60-min link + request forensics (device/GeoIP); 2FA cross-sell.
- **21c — Trial-ending T-3**: charge summary, per-user trial usage recap (14 Scores · 3 screens ·
  22 AI answers), keep/switch-to-monthly CTAs.
- **21d — Payment failed / dunning**: decline reason, retry schedule (+2d, +5d final, pause +7d),
  grace with full access, data-never-deleted promise.
- **21e — New sign-in security alert** (Marsad Security): fires on every new device; masked IP;
  "This was me" trust action; conditional 2FA nudge.
- **22d — IPO books-open alert** (Marsad Alerts): event-driven send on retail-subscription-open
  to venue followers, with trigger rationale ("You follow MSX listings").

### 2.5 Reader mobile (61 screens, 390×812)

- **11a–11f — Splash/auth/onboarding**: splash with live ticker; sign up (OAuth, Wire Brief
  opt-in); sign in ("TASI +0.42% since you left"); verify (30-min TTL, resend cooldown);
  personalize (markets/sectors/currency); welcome (starter actions).
- **12a–12e — Core loop**: Today feed (hero, indices, Score moves, sections); Markets (indices,
  sector grid); Newswire (typed wire incl. DEVELOPING/DATAPOINT items); Stock overview (score
  chip, key stats, 1Y chart, desk view, AI thesis link); Article reader with in-flow metered
  paywall (3/3 free reads).
- **13a–13g — Screener & alerts**: dark screener + filter bottom sheet with live match count;
  Explore themes/trending; watchlist grouped by venue; create-alert sheet (price/score/filing ×
  push/email/WhatsApp); lock-screen push mocks (context-enriched alert + 07:30 Wire Brief);
  alerts manager (ARMED/TRIGGERED, FREE 6/10, quiet hours 22:00–07:00 holding push but not the
  Wire Brief).
- **14a–14f — Research & filings**: research feed (PREMIUM/FREE, model files); analyst profile
  (#1, pinned call, coverage); announcements register (phrase search, form codes CG-1/M-2/FS-4/
  CG-7); filing detail (extracted facts + AI summary + PDF); earnings calendar (PRE/POST, EPS
  estimates); earnings event (BEAT verdict, actual/consensus/Marsad, desk take).
- **15a–15g — AI, billing, account**: AI home (417 CR, prompt cards); cited AI answer (14 CR,
  generated table, CSV, →Screen); pricing (annual save 25%); checkout (Apple Pay + mada, VAT,
  SAR 0 today); premium active (T-3 reminder, back-to-article); account (membership, Face ID,
  currency); notification inbox (unified send history).
- **m1a–m1i**: stock financials (TTM + swipe FY columns; full models PREMIUM); stock filings;
  stock ownership; AI thesis (40 CR, bull/bear, FV band); AI refusal (0 CR); AI credits paywall
  (0/20); forgot password; set password; payment declined (mada fixes).
- **m2a–m2f**: heatmap; compare (2-up + swipe to add third); datapoint series (provenance SRC =
  filing); estimates (Marsad vs street, revision leaders → Score); surprise scorecard; transcript
  reader with synced audio.
- **m3a–m3f**: screen preview (rule chain, blurred rows, "+5 more · Premium", fork); community
  screens (ANALYST/MEMBER badges); my screens (FREE 4/5, per-screen alerts, run recency);
  analyst hub leaderboard; notebook list; note detail (attachments, AI summarize, PDF export).
- **m4a–m4f**: search results; search no-results (coverage request); 404; loading skeleton;
  2FA enrollment; market closed.
- **m5a–m5c**: IPO pipeline cards (stage chips, window-progress bars, DAYS LEFT); IPO detail
  (countdown card, facts grid, blurred Take, reminder toggle); dividend calendar (compact
  day-ledger + alert hook).

### 2.6 Marsad Desk — admin (20 screens)

- **24a — Desk dashboard**: KPI strip (on-site 1,284 · views 96.4K · signups 212 · MRR SAR 1.94M ·
  incidents 1); needs-attention queue (MSX delay, dunning spike 41 vs avg 12, review backlog,
  OQBI deadline); publishing schedule (SENT/LIVE/SCHEDULED/DRAFT/IN REVIEW); 6-venue feed health;
  AWAITING YOUR APPROVAL (3, SLA 3:00); live-now pages; audit tail.
- **24b — Navigation manager**: drag-reorder desktop tabs with EN + AR (RTL) labels, VISIBLE/
  PREMIUM/NEW-PILL toggles; mobile 5-slot bar with More-sheet overflow; live real-component
  preview; versioned config (V11–V14) with restore; instant publish; removed-tab routes redirect
  to Today.
- **25a — Content library**: 1,842 items across 5 content types; 8+ lifecycle statuses incl.
  RULES CHECK/APPROVAL/RETRACTED (struck-through, dimmed); agent (◦) vs human authors; premium ◆;
  bulk schedule/unpublish/change-section/retract; due dates tied to market events.
- **25b — Article editor**: block editor with live ticker-card blocks and draggable
  "PREMIUM CUT — FREE READERS STOP HERE"; workflow trail; distribution toggles (premium, front
  page, push to $ticker watchers, PM Wire Brief); social card (1200×630, 70-char title);
  revisions; provenance & rules box (RUN RULES NOW; disclaimer auto-appends on publish);
  corrections policy (append visible note, no silent rewrites).
- **25c — Front-page curation**: slot map (PINNED vs AUTO by recency × read-velocity; pins expire
  12h), wire-rail drag order, module toggles, staged unpublished changes → instant publish,
  scheduled takeover (Aramco 10:30 → auto-enable earnings strip until call ends), versioned page
  history incl. SYSTEM auto-flow refresh.
- **26a — Analytics overview**: 7d KPIs ending in paywall hits → trials (38.4K → 412, 1.1%);
  8-event reader datapoint stream; live event tail + on-site-now; top content ranked by trials;
  traffic sources (WhatsApp 15%); no-result search terms as product gaps ("sukuk etf").
- **26b — Content drilldown**: hourly curve vs section median with PINNED/PUSH annotations;
  scroll-depth funnel; embed clickthrough; referrers; share mix; 96th-percentile card; audience
  splits (device/geo/tier).
- **27a — Agents console**: fleet strip (11/12 online, 348 runs, lake→live median 14 min); three
  class panels with per-agent state; pipeline stage strips (DRAFT→EDIT→RULES→**YOU**); error
  queue (RETRY/MUTE 1H/RE-RUN/→HUMAN; confidence-0.61 kickback); live run log; guardrails
  (auto-publish short wires ON, kill switch OFF); 7-day throughput; template usage counts.
- **27b — Approval review**: queue tabs with 3:00 SLA timers; piece rendered in its template with
  selectable alternates; 6-rule checklist with evidence; lake-citation provenance per claim;
  agent trail with confidence + diff stats; Approve & publish / Approve for 12:00 / Send back +
  note / Reassign to human.
- **29a — Data lake browser**: 4.2M objects, 99.2% verified, 7 in conflict; typed object ledger
  (DIVIDEND.EXDATE, DISCLOSURE.DPS, FILING.FINANCIALS, IPO.COVERAGE, TRANSCRIPT.QUOTE,
  FILING.PROSPECTUS, COMPUTED.YIELD); conflict inspector (held from writers; primary source wins
  unless overridden); lineage to raw HTML snapshot; coverage board with SLAs and gaps (MSX
  estimates 41%); citation contract (corrected object auto-flags citing pieces).
- **29b — Publishing rules**: Ruleset V9; R-01…R-10 with BLOCK/WARN/AUTO-FIX/AUTO modes, 7d pass
  rates, per-rule toggles; EN+AR banned-phrase lexicon; violations feed (agents AND humans);
  test console; versioned deploys (owner-only).
- **30a — Subscribers overview**: 96.4K accounts · 61.2K MAU · 19,420 paying · MRR SAR 1.94M ·
  ARPU 100 · churn 2.1%; funnel 590K→6,140→1,908→1,183; cohort retention grid; dunning card (41
  failing, retries 21/24 Jul, SAR 31.2K recovered); plan mix (annual 38% +6pts); GCC geography.
- **30b — Member detail**: LTV, billing history (VAT invoices, mada, promo attribution), 30-day
  usage profile, support log, role-gated actions (comp/refund/cancel — Support+, audit-logged),
  PDPL export + 30-day deletion flow, ZATCA 10-year invoice retention, churn-risk score.
- **31a — Team roster**: 6 humans (2FA required Editor+) + 12 agent service accounts with scope
  strings, human owner, key rotation, per-account kill switch; DATA-MSX erroring; break-glass
  freeze-all (audit-logged, notifies editors).
- **31b — Permissions matrix + audit**: 11 capabilities × 5 human roles + 3 agent classes;
  conditional amber grants (WIRE ≤40W, FLAG ONLY, W/ OWNER OK); unified append-only audit log
  (48,211 events/7d, 96.8% by agents, 7-year retention, exportable); policy versions V5/V6
  (owner-only changes).
- **32a — Ads campaigns**: 4 active campaigns, 5/6 slots filled, SAR 214K MTD = 9.9% of revenue
  (cap ≤15%); pacing vs flight goal; creative approval (passes R-05 too); house fallback;
  premium ad-free.
- **32b — Ad slot inventory**: 6 fixed named slots with frequency/audience/status; in-situ
  preview inside real layouts; adjacency rules (never beside halts/retractions/death wires, never
  in Takes/notes, broker conflict lists); contextual-only targeting per PDPL, 3/reader/day cap,
  no individual/watchlist targeting.
- **33a — Market data ops**: 6-venue feed cards (latency, 30d uptime, owning agent; MSX TIMEOUT
  incident with retry 4, 90s fallback, backup-feed switchover); halts desk (auto-detected,
  desk-annotated, resume times); incident banner composer (surface targeting, auto-expiry on
  recovery); market hours & holidays incl. Ramadan 1448 reduced sessions and Hijri-date human
  confirm; 30-day ops stats.
- **33b — Listings & payouts desk**: agent-maintained IPO offer objects (AGENT-CURRENT / NEEDS
  REVIEW / DRAFT OBJECT) and dividend entries (LIVE / CONFIRM→, verified vs registrar or
  disclosure); price-sensitive changes require human confirm; one confirm fans out to IPO
  Center, calendar, stock pages, ex-date alerts, and BLK blocks in pending pieces; deadlines;
  append-only publish log (agent vs human actors).
- **33c — Monetization & comms**: owner-only, versioned — free-tier meter (3 scores / 5 AI
  answers / 2 premium articles per month), plan prices (SAR 119/mo · SAR 1,228/yr), promo codes
  (incl. event-conditioned activation), email templates + today's send queue, throttles (max 4
  pushes/reader/day, quiet hours 22:00–07:00 GST, halt-alert bypass, suppression list 1,842),
  30-day deliverability; changes effective next billing cycle, never retroactive.

### 2.7 Design system & spec sheets (4)

- **S0 — Tokens & component boundaries**: full color/type/spacing/radius/elevation tokens
  (mirrored in `design-tokens.json`); extraction map; **surface prop, not theme toggle** (data
  rooms always dark, editorial always light).
- **S1 — Interaction states & chart library**: every control state; the 6-state freshness
  vocabulary with per-screen placements; color law (amber = degraded-not-broken; red reserved for
  price-down); recency decay; score as-of/next-recompute; rating REVIEW DUE ≥90d; AWAITING FILING
  series; estimate REVISED TODAY; AI grounding cutoff; mobile pull-to-refresh/offline/background-
  alert patterns; real SVG chart specimens (implement with lightweight-charts).
- **S2 — Component specimens**: TickerChip, RatingBadge, FreshnessBadge, DataTableRow,
  ScoreModule (prop-driven, light+dark); chart primitives spec; extraction tracker (10 extracted,
  13 still inline, forward-only policy).
- **16d — Session-state consistency spec**: nav rule for anonymous / free member (avatar, Go
  Premium persists) / premium (avatar + PREMIUM chip); plan tier passed to MarsadNav on every
  authed route.

**Screen totals**: reader web 74 · workbench 3 · templates/blocks 9 · emails 9 · mobile 61 ·
admin 20 · design-system/spec 4 → **180 unique screens** (181 catalog entries incl. one
duplicated 20a analysis).

---

## 3. Derived data-entity model

### Market reference & prices

| Entity | Fields observed | Relationships |
|---|---|---|
| **Venue/Exchange** | code (TDWL/DFM/ADX/QE·QSE/MSX/BHB, + BK reader-side), name, trading week (Sun–Thu, staggered weekends), session times, timezone (GST/AST), delay class (realtime vs 15-min per licensing), feed latency ms, 30d uptime, owning data agent | has Feeds, MarketHours, Stocks, Indices |
| **MarketHours/Holiday** | venue, regular session, next closure (National Day, Hijri New Year), Ramadan 1448 reduced session (10:00–13:00 from ~8 Feb 27), Hijri-confirm flag | drives nav clock, closed states (16c/m4f), auction OPENS times |
| **Stock/Instrument** | ticker (numeric Saudi 2222/1120 or alpha QNBK/FAB), nameEn, nameAr, venue, currency, sector (11-sector taxonomy), industry, board/segment (IPO-1), free float %, listing date, covered-by count | belongs to Venue; has Quotes, Financials, Filings, Score, Dividends, Ownership, Peers |
| **Quote** | last, change, %chg, USD equivalent, asOf + delay class, volume, open, day range, 52w range, VWAP (debut), tick direction, updated-ago | per Stock; feeds TickerChip/DataTableRow/watchlists; freshness state attached |
| **FeedStatus/Freshness** | state (live/reconnecting/delayed/offline/halted/auction), detail (count, LAST hh:mm, NEWS PENDING, OPENS 10:00), lastSync, retry count | per Venue and per Ticker; propagates from 33a incidents to all reader surfaces |
| **Index** | code (TASI/DFMGI/FADGI/QSI/MSX30…), level, chg, H/L, value traded, sparkline series, sector weights (composite) | per Venue; index-drawdown alerts |
| **FxRate** | pair (USDSAR pegged 3.7500; SAR/AED/QAR/OMR/KWD spot for normalization) | used by Compare, checkout display conversion |
| **OHLCV series** | date, O/H/L/C, volume, currency; intervals 1-min (debut) to daily; ranges 1D–5Y | per Stock/Index |
| **HeatmapTile / SectorAggregate** | sector, aggregate %chg, member count, aggregate mcap, breadth (adv/dec/unch, median move) | computed from Quotes + free-float mcap |

### Fundamentals, filings, events

| Entity | Fields | Relationships |
|---|---|---|
| **FinancialStatement** | statement type, period (8 quarters + 10 years + TTM + desk estimate flag `E`), currency, line items, y/y deltas, segment views, source-filing PDF link | per Stock; premium depth gating; XLSX export |
| **KeyRatios/Fundamentals** | mcap, P/E, P/B, EPS, book value, div yield, ROE/ROCE/NIM, net debt/EBITDA, EV/EBITDA, backlog coverage etc. | per Stock; screener fields; BLK-KEYSTATS source |
| **Filing/Announcement** | source ID (TADAWUL CG-1-2026-4471), venue, reg/form code (CG-1, M-2, FS-1, FS-4, CG-7), type (DIVIDEND/CAPEX/RESULTS/RATING/GOVERNANCE/OPS/CONTRACT), filed_at, title, machine-extracted full text, type-specific structured facts, market-moving flag, PDF (pages, AR/EN), AI summary | per Stock; cited by lake objects; parse SLA T+9 min |
| **ConcallTranscript** | event, date/local time, duration, status (UPCOMING/TRANSCRIBED/AI-SUMMARY-READY), review state (machine-transcribed, desk-reviewed), diarized timestamped segments (speaker, role), chapters, audio track, AI summary bullets with novelty flags | per Stock; transcript SLA T+40 min AR+EN; quotes feed BLK-QUOTE and TRANSCRIPT.QUOTE lake objects |
| **EarningsEvent** | ticker, period, report date + confirmation state (CONF/EST), session (PRE/POST), consensus/Marsad/prior EPS, actuals, verdict (BEAT/IN-LINE/MISS/HELD), surprise %, next-session reaction, line-item RVC table, segment breakdown, desk take, house-estimate rank ("closest of 14") | joins Filing (FS-1), Concall, Score (Revisions grade change) |
| **Estimate/Revision** | metric (FY26 EPS), consensus + Marsad series (90d), 30d/90d deltas, breadth (n up / n down), thin-coverage flag (2 analysts), REVISED TODAY chip, Marsad-vs-street banding (above/in-line ±1%/below) | feeds Revisions factor of Score |
| **Dividend** | ticker, type (FINAL/INTERIM/SPECIAL), DPS local ccy, yield, ex-date, record, pay date, payout ratio (+ >100% cut-risk flag), verification provenance (REGISTRAR ✓ / DISCLOSURE ✓), state (LIVE / CONFIRM→) | desk-confirmed object (33b) fanning out to 23a, stock pages, alerts, BLK-EXDATE |
| **IPOOffer (pipeline object)** | ticker (or —), company, venue, stage, price range, offer size %, shares, raise, implied mcap/P/E/yield, retail tranche, min lot, dividend policy, refunds-by, timeline stages with coverage multiples (inst 4.6×, retail 3.1×), brokers, filing milestone, target window, maintainer agent + state (AGENT-CURRENT/NEEDS REVIEW/DRAFT OBJECT) | single source for 22a–22c, m5a/b, BLK-FACTS/TIMELINE, 22d alerts |
| **ListingDebut** | offer price, open, last, day range, turnover, opening auction (price × volume), VWAP, free-float-traded %, allocation recap (retail % of applied, coverages, refund date) | per IPO; Score-pending rule (90 trading days) |
| **DatapointSeries** | name, ticker, unit, cadence, maintainer (analyst), description, revision SLA (24h post-disclosure), staleness (>30d), values {period, value, Δ, source filing FK} | analyst-maintained (43 for Aramco); alertable; publishes to Wire; LIVE embeds in articles |
| **Holder/Owner** | name, monogram, type (Sovereign/Institution/Family office/Fund), country, established, holdings count, disclosed value/AUM (self-reported flag), positions {ticker, stake %, value, Δ QoQ pp}, sector tilt, recent moves | built from >5% disclosures; holder-disclosure alerts; Ownership tab matrices per Stock |

### Scoring & AI

| Entity | Fields | Relationships |
|---|---|---|
| **MarsadScore** | value 0–100, rating (Buy/Overweight/Hold/Underweight/Sell — UI also shows Strong Buy in analyst context), weekly delta, 5 factor grades (Value, Growth, Profitability, Momentum, Revisions; letters A…D ±), sector percentile + peer count, computedAt (04:00 GST), pending state (needs 90 trading days; grades seed from prospectus) | per Stock; nightly batch + event-driven recompute (earnings beat → Revisions B→B+ overnight); score-change event log feeds front page, alerts |
| **MarsadSelect** | 5 AI-ranked names, monthly rebalance, rebalance notes | premium-only module |
| **AIThread/Answer** | scope (ALL GCC/watchlist/company), mode (GENERAL/DEEP), credit cost (variable; 0 on refusal), narrative + generated table with row-level source refs, citations {doc, page/slide, quote, open-filing link}, feedback (helpful/flag), grounding cutoff date | debits CreditBalance; can convert to Screen, export CSV, attach to Notebook |
| **AIThesis** | ticker, headline, cited bull/bear points, DCF fair-value band (3 scenarios), catalysts (dated), invalidation conditions, generated date, regeneration trigger (material filings) + cost (40 CR), stance | citations span filings, transcripts, and internal desk models; divergence vs Score flagged to desk |
| **CreditBalance** | monthly allowance (free 20 / premium 500), used, remaining, reset date (1st), premium 1-month rollover, top-up SKUs (from SAR 25) | per User |

### Data lake, rules, agents, templates

| Entity | Fields | Relationships |
|---|---|---|
| **LakeObject** | object_type (DIVIDEND.EXDATE, DISCLOSURE.DPS, FILING.FINANCIALS, IPO.COVERAGE, TRANSCRIPT.QUOTE, FILING.PROSPECTUS, COMPUTED.YIELD…), ticker, value/summary, source agent(s), state (VERIFIED/PENDING/CONFLICT), revision pairs (old→new), cited_count, lineage (raw snapshot → parse run → cross-check → verified → cited-by) | 4.2M objects, 14 sources; writers may cite VERIFIED only; conflicts held pending human resolution (primary source wins unless overridden); citation graph drives correction auto-flags (R-07) |
| **Conflict** | object ref, competing values + sources, policy, actions (accept primary / escalate) | subset of LakeObject |
| **Citation** | claim → lake object, source agent, timestamp, row counts/verification meta | joins Draft/Article ↔ LakeObject; powers 27b provenance and "VERIFIED VS LAKE 14/14" |
| **PublishingRule** | id R-01…R-10, text, scope (ALL/NOTES·TAKES/PREMIUM), enforcement (BLOCK/WARN/AUTO-FIX/AUTO), 7d pass rate, on/off; banned-phrase lexicon EN+AR; ruleset version (V8, V9 live) | evaluated identically for agents and humans at submit + publish; test console endpoint; violations log |
| **Template (TPL-01…08)** | id, name, served content types, auto-select rule, block list, auto-publish eligibility (TPL-01 only), premium rule (TPL-08 always premium) | Draft renders into template; alternates switchable in 27b |
| **StoryBlock (BLK-\*)** | id (14 blocks), renders, data-lake source binding, consuming templates | block picker in 25b; blocks re-render as bound objects update |
| **Agent (service account)** | id (DATA-TDWL/-FILINGS/-NEWS/-GULF/-MSX, WRITER-1/2/3, EDITOR-1/2 = 12 accounts), class (DATA/WRITER/PUBLISHING), scope string (e.g. `drafts:create · lake:read (verified only) · never publish`), human owner, key rotation date, run toggle (kill switch), status (active/idle/erroring), current task, next run, run counts | principals in the same identity store as humans; audit-logged identically |
| **PipelineItem** | piece ref, stage (DRAFT→EDIT→RULES→APPROVAL "YOU"), assigned agents (Wn·En), age timer, queued flag, SLA (3:00), confidence score | approval outcomes: publish / schedule / send back / reassign-to-human |
| **AgentError** | severity (infra vs quality), agent, type (feed parse timeout, low confidence 0.61, rules fail), retry count, actions (RETRY/MUTE 1H/RE-RUN/→HUMAN), state (RESOLVING) | error queue on 27a |
| **RunLogEntry** | timestamp (sec), agent, event | live stream on 27a |

### Content & editorial

| Entity | Fields | Relationships |
|---|---|---|
| **ContentItem/Article** | type (WIRE/ARTICLE/EXPLAINER/NOTE/TAKE), section, kicker/dek/headline (≤90 chars), body blocks, tagged tickers (multi), author (human or ◦agent), byline chain (drafted-by, reviewed-by), status (see §4), premium ◆ + paywall-cut position, read minutes, evergreen flag + review cadence + reading level, due date, scheduled_at, views/analytics join, social card (1200×630, 70-char title), revisions, correction notes, retraction notice (URL stays live), rating attachment, model-file attachments (members-only), disclaimers auto-appended | rendered in a Template from Blocks; citations to LakeObjects; front-page slots; push targeting via ticker watchers |
| **FrontPageConfig** | version (V39–V41), slots (PINNED/AUTO, occupant, pending replacement), wire-rail order (top-4 pinnable), module toggles, staged changes, scheduled takeovers (event-bounded), history with actor (human/SYSTEM) | pins expire 12h; auto slots ranked recency × read-velocity; retracted never auto-flow |
| **NavConfig** | tabs {position, key, labelEn, labelAr, visible, premium, newPill}, mobile 5-slot bar + More sheet, version (V11–V14), draft/live, restore | instant publish; removed-tab routes redirect; premium tab → lock state 4b |
| **AnalystProfile (human)** | name, rank, title, credential, bio, followers, win rate, avg call return, closed calls, coverage list {rating, PT, since, call return}, pinned call, published pieces, disclosures (no positions), review-due flags (90d) | immutable timestamped call ledger; call returns vs venue index from publication date |
| **AnalystApplication** | name, credentials, coverage focus, 300-word sample thesis, review SLA ~5 business days | grants Workbench role + revenue share |
| **Screen (saved screener query)** | name, criteria AST (field/op/value AND-chain), author (desk/analyst/member), update cadence, fork count, followers, match count, last run, alert enabled, backtest (equal-wt, quarterly rebalance, 3Y vs TASI, hit rate) | free cap 5 saved; publishing premium-only; fork graph; match-diff alerts |
| **Note (Notebook)** | ticker, title, body, pinned, edited, attachments (price snapshot at clip time, filing/source link) | private by default; per-ticker PDF export; AI summarization input |
| **Watchlist** | name, members (venue-grouped), column prefs, aggregate day change, best/worst | free 1 × 10 names; premium unlimited |

### Users, money, comms

| Entity | Fields | Relationships |
|---|---|---|
| **User/Member** | name, email (verified), avatar, member since, member ID (M-48213), plan status, location, device sessions, 2FA flag, Face ID, currency pref, market/sector prefs, churn risk, LTV, internal notes, support log | PDPL export/delete; usage meters; follows (analysts, screens, venues) |
| **Plan/Entitlements** | Free (SAR 0: 15-min quotes, 3 premium reads/mo, 3 scores/mo + 5 AI answers/mo + 2 premium articles/mo per 33c meter, 1×10 watchlist, 10/2/2 alerts, 20 AI credits, 5 saved screens) · Premium Monthly SAR 119 · Premium Annual SAR 1,228.20 incl VAT (default; 89/mo equiv) · Enterprise Terminal+API from SAR 24,000/yr; trial 14 days; promo codes (redemption counts, event-conditioned starts) | versioned config in 33c; changes next-cycle only |
| **Subscription/Order** | order id (MP-YYYY-NNNNN), plan, payment method (VISA/MC/AMEX/mada, Apple/Google Pay), VAT 15% + optional VAT ID, trial end, first-charge schedule, invoices (PDF, incl. scheduled rows), dunning state, refunds (unused full months) | Stripe-managed; ZATCA 10-yr invoice retention; TRN on invoices |
| **Alert** | type (price cross / score change / event·filing / ratio / screen match / phrase / ex-date reminder / index drawdown / transcript arrival / IPO books-open / holder disclosure / series update), scope (ticker/watchlist/venue/entity), threshold, channels (push/email/WhatsApp), state (ARMED/TRIGGERED ts/PAUSED), last fired, quota bucket | evaluated by respective engines; quiet-hours-aware |
| **Notification/InboxItem** | type, title, body, deep link, read state, send channel, delivery + open tracking | mirrors every send; 16b/15g |
| **EmailTemplate/Send** | template (Wire Brief AM/PM, alert, IPO alert, account suite, dunning), trigger type (scheduled/event/lifecycle), audience, status (SENT · open% / SCHEDULED / ASSEMBLING), sender identity (Accounts/Billing/Security/Alerts/brief@), suppression list, deliverability stats | send queue in 33c |
| **AdCampaign / AdSlot** | campaign: sponsor, creative status (approved + approver / in review), slots, flight, pacing vs flight-to-date, CTR, value; slot: id (6 fixed), placement, frequency rule, audience (free tier; email = all), status (SOLD/BOOKED/HOUSE FILL) | adjacency rules + per-sponsor conflict lists; contextual targeting only; revenue-mix cap ≤15% |
| **AnalyticsEvent** | 8 reader event types (page_view, click, share, save, watchlist_add, alert_create, ai_answer, screener_run) + paywall_hit, trial_start; context (channel, ticker, geo, platform, tier) | powers 26a/26b, per-analyst read→trial, live tails |
| **AuditLogEntry** | time, actor (human / ◆agent / SYSTEM), category (QUEUE/CONTENT/PUBLISH/LAKE/NAV/BILLING), description, before-value on overrides | append-only, 7-yr retention, exportable, identical schema for all actor types |
| **IncidentBanner / Halt** | banner: message, severity, target surfaces, publisher, auto-expiry-on-recovery; halt: ticker, state (HALTED/AUCTION), resume time, annotation, linked wire | desk-operated in 33a; halts auto-detected by agents |

---

## 4. State machines (as observed)

**Pipeline item (agent newsroom)**
```
QUEUED → DRAFT (writer agent, confidence score)
       → EDIT (editor agent; diffs logged)
       → RULES (R-01…R-10; fail ⇒ auto-return to writer)
       → APPROVAL ("YOU"; 3:00 SLA)
           → Approve & publish → LIVE
           → Approve for hh:mm → SCHEDULED → LIVE
           → Send back + note → back to agent (DRAFT/EDIT)
           → Reassign to human editor → human editorial flow
Exception path: TPL-01 wire, single event <90 words → AUTO-PUBLISH (no approval), revocable toggle.
```

**Content status (25a superset)**
```
DRAFT → IN REVIEW → SCHEDULED (hh:mm) → LIVE → UPDATED (correction note appended)
Agent branch: RULES CHECK → APPROVAL → LIVE/SCHEDULED
Newsletter branch: → SENT
Terminal: RETRACTED (URL stays live with notice; struck-through in library; excluded from auto-flow)
```

**Lake object**
```
(ingested) → PENDING → cross-check → VERIFIED (citable)
                    ↘ CONFLICT (held from writers; cited=0)
CONFLICT → human resolve (accept primary | override | escalate) → VERIFIED
Value change ⇒ revision pair; correction of a cited object ⇒ auto-flag all citing live pieces (R-07).
```

**Desk data objects (33b)**
```
IPO offer: AGENT-CURRENT ⇄ NEEDS REVIEW (price-sensitive change filed) → human confirm → published
           DRAFT OBJECT (from draft prospectus) → …
Dividend entry: (auto-created from lake) → CONFIRM → (human) → LIVE → fan-out everywhere
Non-price-sensitive deltas (e.g. coverage 2.9×→3.1×) auto-publish.
```

**Freshness (per venue and per ticker, 6 states)**
```
LIVE ⇄ RECONNECTING → DELAYED (licensing/snapshot or incident) → OFFLINE (last sync shown)
Ticker-level: HALTED (reason + last price; suppress chg) · AUCTION (indicative until open) · STALE (dim, suppress chg+score) · LOADING
Recency decay: just-updated flash → grey relative timestamp → amber when aging.
```

**IPO lifecycle**
```
INTENTION / DRAFT PROSPECTUS → CMA FILING → BOOKBUILDING (inst, coverage ×) →
RETAIL SUBSCRIPTION OPEN (window counter, live coverage) → ALLOCATION → LISTED TODAY →
(90 trading days) → first Marsad Score
```

**Subscription**
```
ANONYMOUS → FREE (metered) → TRIALING (14d, SAR 0; T-3 reminder) → PAYING (annual/monthly)
PAYING → PAST_DUE (decline; grace w/ full access) → retry +2d → retry +5d (final) → PAUSED +7d
   (premium locks; watchlists/screens/notes preserved) → resumes on payment
Cancel: anytime; annual refunds unused full months. Checkout declines: 3 attempts → 24h hold.
PDPL delete: 30-day grace → irreversible purge (invoices retained 10y for ZATCA).
```

**Alert lifecycle**: `DRAFT → ARMED → TRIGGERED (ts, logged) → re-arm | PAUSED`; quiet hours hold
digests/low-priority only; market-hours triggers never delayed; halt alerts bypass quiet hours.

**Concall**: `UPCOMING → (audio ingested) → TRANSCRIBED (machine → desk-reviewed) → AI SUMMARY READY`.

**Agent account**: `ACTIVE ⇄ IDLE (next-run scheduled) → ERRORING (retry count) → muted/killed`;
global: pause-all, kill-switch-all-output, break-glass freeze (audit-logged).

---

## 5. Realtime & jobs inventory

**Realtime feeds (WS/SSE)**
- Per-venue tick/quote feeds with connection-state machine and per-message tick flashes; free
  tier throttled to 15-min delayed snapshots per venue licensing.
- Newswire item stream (LIVE · 214 TODAY), filings register live tail, alert trigger log (5a),
  admin run log (27a), live event tail + on-site-now concurrency (26a), per-slot concurrent
  readers (25c), debut-day 1-min bars (22c).
- Feed-health heartbeats per venue → DELAYED badge propagation to reader surfaces; incident
  banners auto-expire on feed recovery.

**Scheduled jobs**
- **04:00 GST daily** — Marsad Score recompute (812 names; score, 5 grades, weekly delta, sector
  percentile; emits score-change event log). Also event-driven recompute on earnings (Revisions
  grade overnight).
- **06:00 / 16:30 (33c) or 07:30 GST (reader-facing)** — Wire Brief AM/PM assembly + send
  (42,180 recipients; per-user personalization; PM edition holds slot for pending piece).
- **12:00** — dunning retry batch (SYSTEM actor; recovered-MRR audit entries). Dunning schedule:
  decline → +2d retry → +5d final retry → +7d pause.
- **Monthly (1st)** — free meter resets (reads, scores, AI answers, credits); premium credit
  rollover (1 month); Marsad Select rebalance.
- **T-3 days before trial end** — trial-ending email.
- **Nightly/daily** — dividend verification vs registrar; ownership/FOL refresh; estimate-revision
  aggregation (30/90d + breadth); screener saved-screen re-runs with membership diffing (match
  alerts); daily screen catalog match counts; movers/breadth aggregation; front-page AM auto-flow
  refresh (06:02 SYSTEM); analytics rollups.
- **Event-scheduled** — IPO milestone comms (books-close reminders, 13:05 push+email); ex-date
  reminders exactly 2 days before; concall "remind me" at call time; scheduled article publishes
  (market-open aligned); scheduled front-page takeovers with event-bounded module state (earnings
  strip until call ends); first-Score computation 90 trading days post-listing; quarterly
  evergreen content review; 90-day rating-review flags; datapoint staleness scans (>30d);
  filing-cadence AWAITING flags.
- **Parse SLAs** — filings T+9 min median (100% of disclosures), transcripts T+40 min (AR+EN,
  diarized), prospectus parsing (88pp → 214 objects), 24h datapoint revision after disclosure.

**Queues & SLA timers**
- Owner approval queue: 3:00 SLA per item, oldest-first, red near-breach.
- Workbench reviewer queue: 24h SLA, red at ≤6h, median-turnaround tracking.
- Agent error queue: retry/mute-1h/re-run/reassign; low-confidence (<~0.61) auto-kickback.
- MSX incident: 90s fallback polling, backup-feed switchover, vendor escalation notifications.

**Throttles**
- Push: max 4/reader/day; quiet hours 22:00–07:00 GST (holds digests + low-priority; market-hours
  triggers exempt; halt alerts bypass); suppression list (1,842).
- Ads: 3 impressions/reader/day frequency cap; one unit per viewport.
- Auth: OTP 15-min TTL; reset link 30 or 60-min single-use (mobile copy says 30, email 21b says
  60 — see open questions); resend cooldown ~60s; checkout 3 attempts → 24h hold.

---

## 6. Business rules ledger

**Meters & entitlements**
- Free: 15-min delayed quotes; 3 premium article reads/mo (reset 1st); 33c meter also specifies
  3 scores + 5 AI answers + 2 premium articles/mo (see open questions); 1 watchlist × 10 names;
  alerts 10 stock / 2 screen / 2 phrase; 20 AI credits/mo; 5 saved screens; daily heatmap only.
- Premium: realtime where venue licensing permits; unlimited research + model files (XLSX);
  Score + grades on 812 names; 800/75/50 alerts + WhatsApp channel; 500 AI credits (~40 answers)
  + Deep mode + thesis regeneration (40 CR) + rollover 1 month; unlimited watchlists/notes/
  screens; CSV/terminal export; Marsad Select; analyst Q&A; ad-free.
- Pricing: SAR 89/mo billed annually (SAR 1,068 + 15% VAT = 1,228.20; ≈102.35/mo effective) vs
  SAR 119 monthly; 14-day trial (web pricing page says no card required; checkout flow collects a
  card with SAR 0 due — see open questions); unused full months refunded; price/meter changes
  next billing cycle, never retroactive; multi-currency display (AED/QAR/OMR auto-converted);
  enterprise from SAR 24,000/yr.
- Gating mechanics: server-side truncation (article paragraphs, screen rows 3-of-N), block-level
  gates (Marsad Take inside a free page; BLK-TICKER 15-min delay for free), blur+PREMIUM chip
  presentation, filters/context preserved across upgrade, post-checkout return-to-article.

**Publishing rules (Ruleset V9)**
- R-01 advice disclaimer required on every piece (AUTO-FIX). R-02 ticker tags must resolve to
  listed instruments (BLOCK). R-03 every factual claim cites ≥1 VERIFIED lake object; ≥2 primary
  sources per piece (BLOCK). R-04 numbers within 0.5% of cited objects (BLOCK). R-05 banned-claims
  lexicon EN+AR ("guaranteed return", "will hit [price]", "insider says"…) (BLOCK; also applied
  to ad creatives). R-06 stretched metrics framed as risk, never advice (NOTES·TAKES, WARN).
  R-07 post-publish edits append a visible correction note (AUTO). R-08 retractions keep URL live
  with notice (AUTO). R-09 premium cut lands after ≥1 data block (PREMIUM, WARN). R-10 headline
  ≤90 chars, clickbait-clean (AUTO-FIX). Ruleset versioned, owner-only edits, identical for
  humans and agents; beat/miss thresholds also configured here.

**Agent guardrails**
- Agents never publish (exception: publishing-agent wire briefs ≤40 words, revocable), never
  touch billing, never change rules. Scoped keys with negative scopes (`never content`,
  `never publish`); writer reads VERIFIED lake objects only; agent corrections are FLAG ONLY
  (human approves the note); per-agent kill switch + pause-all + owner break-glass (freeze all
  output, audit-logged, notifies editors). Price-sensitive object changes always require human
  confirm; one confirm fans out to every consuming surface. Every override stores the replaced
  agent value. 2FA required Editor role and above. Support data exports require owner OK.

**Ads**
- Never programmatic; 6 fixed named slots only; sponsorship ≤15% of total revenue (9.9% current);
  premium sees no ads (house annual-switch card only); always labeled PARTNER, house typography,
  no sponsor logos above the label; creatives pass R-05; adjacency bans: halts, retractions,
  death/incident wires, Marsad Takes, analyst notes; broker sponsors never render on stocks they
  make markets in (conflict lists); contextual-only targeting (section, venue) — individuals and
  watchlists not targetable (PDPL); 3/reader/day cap; house fallback fills unsold slots.

**Compliance & regional**
- PDPL: reader data never exposed to sponsors; member data export on demand; deletion = 30-day
  grace then irreversible purge. ZATCA: invoices retained 10 years; TRN on invoices; VAT 15% KSA,
  optional VAT ID capture. Entity: Marsad FZ-LLC, DIFC, regulated by DFSA. "Not investment
  advice" on every content surface, email, and paywall; Marsad takes no IPO orders (broker
  hand-off). mada card scheme support (incl. e-commerce enablement guidance). Trading week
  Sun–Thu; Ramadan reduced sessions (10:00–13:00); Hijri-dependent holidays require human
  confirm. Bilingual EN/AR: nav labels, security master names, banned-phrase lexicon, filings
  extraction; full RTL edition on roadmap.

**Editorial/market rules**
- Payout ratio >100% flagged as cut risk; yields recomputed on DPS change; ex-date is the
  actionable grouping ("own before the ex-date open"); dividend reminders 2 days before ex-date.
- Analyst track records immutable (timestamped, venue-price snapshot at publication, no
  retroactive edits); analysts may not hold positions in covered names; rating review due at
  90 days; win rate = calls beating venue index over holding period; datapoints require a source
  link; disclosure checklist gates submission.
- AI refuses rather than invents; refusals cost 0 credits; every answer stamps a grounding
  cutoff; questions private by default.
- Front page: pins expire 12h; auto slots recency × read-velocity; retracted items never
  auto-flow; premium stories show lock state to free readers.
- Score: needs 90 trading days of data for new listings; computed independently of the AI thesis;
  quant-vs-narrative disagreement is itself flagged in coverage.
- Colors: green/red reserved for price action; amber = degraded (not broken); red never used for
  feed failure.

---

## 7. Open questions (backend-affecting ambiguities)

1. **Free-meter definitions conflict.** Pricing page (1m) + paywalls (4a/4d) say 3 premium
   article reads/mo; admin 33c defines the meter as 3 scores + 5 AI answers + 2 premium
   articles/mo; AI screens use a separate 20-credit meter. Which meters exist, and is the
   33c config the source of truth that other copy lags?
2. **Trial card requirement.** Pricing (1m) says "no card required for trial" but checkout
   (6h/15d) collects a card with SAR 0 due and starts the trial "the moment a payment method is
   verified". Which flow is canonical (or are both variants supported)?
3. **Password-reset TTL mismatch.** Email 21b says the link "works once and expires in 60
   minutes"; 6c and m1g say 30 minutes. Pick one.
4. **AI price points.** Older paywalls cite SAR 89/mo (annual-equivalent) while 33c defines
   SAR 119 monthly / SAR 1,228 annual as the live config — confirm which figures ship, and
   whether paywall copy is config-driven from 33c.
5. **Wire Brief send times.** Reader surfaces say 07:30 GST daily; 33c/24a show AM 06:00 and
   PM 16:30 sends. Two products or a copy drift?
6. **Venue count.** Admin operates 6 venues (TDWL/DFM/ADX/QE/MSX/BHB); reader copy repeatedly
   says "seven Gulf venues" and onboarding includes Boursa Kuwait (BK). Is Kuwait fed by a data
   agent (none named), and what is v1 venue scope?
7. **Alert quota reconciliation.** Free stock alerts appear as 10 (5a, 13g); premium as 800;
   phrase 2/50; screen 2/75. But the empty-alerts screen and IPO/dividend/holder/transcript alert
   types don't state which bucket they consume. Define the quota taxonomy across all ~12 trigger
   types.
8. **Marsad rating vocabulary.** ScoreModule uses Buy/Overweight/Hold/Underweight/Sell; analyst
   workflows also show "Strong Buy" (1n/m3d). Is Strong Buy valid for human analysts only?
9. **Auto-publish boundary.** TPL-01 auto-select says "<90 words" but the agent exception
   everywhere else says "wires ≤40 words". Is the auto-publish limit 40 words with TPL-01 serving
   longer human-approved wires, or is 90 the gate?
10. **Consensus estimates sourcing.** Estimates screens imply a street-consensus feed ("closest
    of 14", breadth counts) but no data agent or vendor is named (MSX estimates coverage gap
    41%). What is the consensus source and licensing?
11. **Realtime licensing matrix.** "Real-time where venue licensing permits; otherwise best
    available feed" — the per-venue delay matrix (which venues are realtime for premium) is never
    enumerated.
12. **Server-side gating for Takes.** 22b blurs premium content client-side in the mock; the
    real system must not ship gated text to free clients. Confirm server-side block-level
    entitlement rendering everywhere blur is shown.
13. **Analyst revenue share.** 20d promises revenue share on reader subscriptions with no formula,
    attribution model, or payout mechanics anywhere in the designs.
14. **WhatsApp delivery.** Premium alert channel implies WhatsApp Business API infra, template
    approval, and opt-in flows — none designed.
15. **Community content moderation.** Community screens (9c) and analyst applications exist, but
    no moderation/abuse queue for member-published screens is designed.
16. **Human roles vs Workbench roles.** Desk roles (Owner/EIC/Reporter/Analyst/Support) and
    Workbench roles (Analyst, Reviewer — R. Khalifa) overlap; the permissions matrix (31b)
    doesn't include Reviewer. Unify the role model.
17. **Search architecture.** 0.04s federated search over stocks/filings/research/people plus
    per-user recents and zero-result trend detection — engine choice and index update cadence
    unspecified.
18. **Credit accounting edge cases.** Variable per-answer costs (8–40 CR) with mid-answer
    failures, top-up SKU list beyond "from SAR 25", and team/enterprise credit pooling are
    undefined.
19. **Historical retrofit policy.** Component policy is forward-only (135 legacy screens keep
    inline markup) — for the build this means the component library must match legacy inline
    styling pixel-for-pixel; confirm tolerance.
20. **Kuwait/Egypt session states.** S1 mentions EGX30 in mixed-session specimens though Egypt is
    outside the stated GCC scope — clarify whether non-GCC indices appear read-only.

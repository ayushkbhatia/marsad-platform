# 07 — Data Lake Enrichment (P1.7, before/with P2 stock pages)

> How the Marsad lake goes from **two ingested families** (delayed quotes + filing lists) to the
> **full per-stock dataset** the P2 reader needs — ~812 stock pages (tabs Overview / Financials /
> Filings / Ownership) plus the flagship **Marsad Score**. This document is the grounded synthesis
> of four research streams: (A) reader per-stock data requirements, (B) live source-coverage probing
> from the VPS, (C) exchange-native fundamentals feasibility, (D) the derived-data pipeline + Score
> methodology. Everything below is reconciled field-by-field against the shipped schema
> (`supabase/migrations/…`) and the live probe results — not speculation.
>
> **Locked constraints honored throughout:** scrape-only + **delayed** data; **all 6 venues**
> (TDWL Saudi, DFM Dubai, ADX Abu Dhabi, QE Qatar, MSX Muscat, BHB Bahrain); **cheapest** run
> cost; **English only**; **snapshot-first**; **2-source cross-check → `VERIFIED` lake.objects**.
>
> **Ground-truth infra:** VPS worker (Hetzner `91.99.99.85`, `deploy@`, Playwright at
> `/opt/marsad/ingestion/node_modules`, `PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright`);
> Supabase project `yjsncnpbjuueaoeejrqj`; pg_cron **enqueues into pgmq → the VPS worker executes**.
> Yahoo Finance already wired (`endpoint_config.provider='yahoo'` discriminant, seeded, cross-check
> + `ohlcv_backfill` for `.SR/.AE/.QA`); Mubasher wired for TDWL quotes.

**Companion docs:** `02-data-lake.md` (§6 datapoints, §7 prices/quotes, §8 fundamentals/filings/
earnings/dividends/ownership, §9 Score, §10 analysts, §"Missing entities" → `company_people`);
`01-ingestion.md` (§9 financials extraction); `design-analysis.md` (§2.1 screens 1g/3a–3d,
ScoreModule, §5 04:00 batch + 90-trading-day rule, §6 rules); `06-infra-cost.md` §4.1 (cron/pgmq/
worker topology). Migrations: `…0005_prices.sql`, `…0006_fundamentals.sql`,
`…0007_datapoints_scores.sql`, `…0015_cron.sql`, `…0017_ingest_sources.sql`,
`…0021_yahoo_source.sql`.

---

## 0. Executive summary (read this first)

**Where the lake is today:** only **QUOTE** (`quotes_latest`, delayed boards) and **FILING lists**
(`filings` rows without full text) are populated. Every other per-stock table
(`financial_statements`, `key_ratios`, `scores`, `estimates`, `earnings_events`, `dividends`,
`holders`/`ownership_snapshots`, `datapoint_series`, `transcripts`) is **empty**. A P2 stock page
rendered today would show a live price and a list of announcement titles — nothing else. The
screener (scans `key_ratios`) would return nothing. The Marsad Score cannot exist.

**What P2 credibility actually requires (the must-haves):** price **history** (not just the live
quote), **financial statements**, the **key-ratio** strip derived from them, the **Marsad Score**,
filing **full-text + extracted facts + AI summary**, **dividends**, **securities identity + board
people**, and **ownership snapshots**. Earnings actuals come cheaply from filings; **street
consensus estimates have no cheap named source** and are the single biggest sourcing risk.

**The two hard truths from live probing:**
1. **Yahoo covers only 3 of 6 venues** (`.SR` TDWL, `.AE` DFM, `.QA` QE) and is currently
   **429-hard-blocked from the VPS IP** — it needs a residential/rotating egress before DFM+QE
   fundamentals are reachable at all.
2. **ADX, MSX, BHB have no aggregator** — they are **exchange-native or nothing**. ADX native is
   clean structured JSON (low risk). MSX is thin/PDF-heavy. **BHB is IP-blocked even via headless
   Chromium** (the VPS IP itself is the problem) — it is the coverage-gap venue and must not block P2.

**The Score is cheap and correct-by-design:** it is **pure math over the lake, zero LLM/API cost**.
A **credible v1 ships on 3 of 5 factors** — Value, Profitability, Momentum — all buildable from data
we already ingest or trivially can. Growth needs 4–8 quarters of statements. **Revisions launches as
`NULL`** (no consensus source) and is added later without re-architecture.

**The one true critical-path gap:** we must **persist `ohlcv_daily`** (daily closes, ≥126 trailing
bars). Today we ingest the live quote but do not accrue history. No history → no Momentum factor,
no dividend-adjusted returns, no chart tab. This is P1.7a and it gates the Score.

---

## 1. Per-stock datapoint catalog

Enumerated from `design-analysis.md` (screens 1g, 3a–3d, 7b/7d, 8a–8d, 18b, 22c, 23a; ScoreModule)
and reconciled against the shipped schema. Each datapoint is tagged **RAW** (scraped/ingested) or
**DERIVED** (computed from other lake data), with the exact lake table that holds it and the reader
surface that renders it.

Legend: **R** = RAW · **D** = DERIVED · Priority **M** = must-have-before-P2 · **N** = nice-to-have.

### 1.1 MUST-HAVE families (a stock page is not credible without these)

#### A · QUOTE — `quotes_latest` (+ `quotes_intraday`, `security_status`) — **DONE today**

| Field(s) | Screen(s) | Table | R/D |
|---|---|---|---|
| `last`, `change`, `change_pct` | 1g, 3a, 7b header, watchlist, TickerChip | `quotes_latest` | R |
| `open`, `high`, `low`, `volume`, `vwap` | 1g key stats, 22c debut | `quotes_latest` | R |
| `week52_high`, `week52_low` | 1g key stats | `quotes_latest` | R |
| `as_of`, `captured_at`, `delay_minutes`, `tick_dir` | FreshnessBadge (every surface) | `quotes_latest` | R |
| USD-equivalent `last` | 1g, Compare 18a | via `fx_rates` | D |
| `HALTED/AUCTION/STALE`, `resume_at` | 1g badge, S1 states | `security_status` | R |

> **Status: the only family the lake already holds.** Priority **M** (satisfied).

#### B · PRICE HISTORY / OHLCV — `ohlcv_daily`, `quotes_intraday`, `index_levels_daily` — **critical-path gap**

| Field(s) | Screen(s) | Table | R/D |
|---|---|---|---|
| daily `open/high/low/close/volume/value_traded` (backfill to IPO where free) | 1g candle chart, 3a Price tab | `ohlcv_daily` | R |
| 1-min bars (debut day) | 22c listing-day chart | `quotes_intraday` | R |
| index level series (TASI overlay) | 1g chart overlay | `index_levels_daily` | R |
| relative return 1D/1W/1M/YTD/1Y/5Y; price-vs-index | 1g range switch, 1j | derived from `ohlcv_daily` | D |

> Priority **M**. Yahoo `chart`/`fundamentals-timeseries` covers `.SR/.AE/.QA` history;
> **Mubasher historical CSV** is the standout artifact for TDWL/ADX; **ADX/MSX/BHB** need
> exchange-native. **This family is the Score's Momentum input — it must land first.**
> **Two feeds fill this table (see §P1.7a):** a **one-time backfill** for the ≥2y seed, then an
> **ongoing EOD accrual** (+1 bar/security/trading-day) that rolls up the intraday `quotes_latest`
> ticks (family **A**) at close. Backfill is proven; the EOD accrual is wired (0028) but **must be
> validated** (§P1.7a V-1/V-2) — the reader is only correct once the daily bar keeps appearing, not
> just once the history is seeded.

#### C · KEY RATIOS — `key_ratios` (1 flat row/security, recomputed nightly) — screener scan target

| Field (shipped col) | Screen(s) | R/D |
|---|---|---|
| `market_cap` | 1g, 3a strip, Compare | D (`last × shares_outstanding`) |
| `pe`, `pb`, `ps`, `eps_ttm`, `book_value_ps` | 1g, 3a 9-cell strip, screener | D |
| `dividend_yield`, `payout_ratio` | 1g dividend card, 23a, 3a | D |
| `roe`, `roce`, `nim` (banks) | 3a, screener, Compare bank rows | D |
| `net_debt_ebitda`, `ev_ebitda` | 3a EV·EBITDA tab, screener | D |
| **[NEW COL]** `net_margin`, `gross_margin`, `rev_growth_yoy`, `eps_growth_yoy`, `rev_cagr_3y`, `eps_cagr_3y`, `ret_3m`, `ret_6m`, `ret_12_1`, `ebitda_ttm`, `currency_computed` | Score inputs (§3) | D |

> Priority **M**. DERIVED from D + `shares_outstanding` + quote. **The screener (1f, 812 universe)
> scans this table — if it is empty, the screener returns nothing.** Requires one additive migration
> (the `[NEW COL]` set) that the Score needs and the shipped table lacks.

#### D · FINANCIAL STATEMENTS — `financial_statements` (jsonb `line_items`) — the deepest raw ingest

| Field(s) | Screen(s) | R/D |
|---|---|---|
| Income line_items (revenue, gross_profit, ebit, net_income, eps…) — 8 rolling Q + 10 annual + TTM | 3b, m1a | R |
| Balance-sheet line_items (assets, equity, total_debt, cash, deposits…) | 3b | R |
| Cash-flow line_items (CFO, capex, FCF, dep_amort, dividends_paid…) | 3b | R |
| `segments` jsonb | 3b, 8b segment bars | R |
| `is_estimate` desk column (`JUN '26E`) | 3b, 8a | D (desk) |
| `period_end`, `currency`, `basis` (consolidated/standalone), `audited` | 3b | R |
| `source_filing_id` → per-quarter PDF | 3b Tadawul PDF links | R |
| y/y deltas, CAGR cards | 3b | D (read-time) |

> Priority **M** (the Financials tab; also the input to C and E). **The single largest scrape.**
> Yahoo gives standardized multi-year statements for `.SR/.AE/.QA`; **Mubasher** gives full 5-yr
> statements for **TDWL + ADX**; **ADX native** `financial-reports.json` is the cleanest structured
> source; MSX/BHB lean on the **PDF-extraction pipeline** (`01-ingestion.md` §9).
> Credible floor = **8 quarters + 3–5 annual**; 10y is nice-to-have.

#### E · MARSAD SCORE + 5 FACTORS — `scores` / `score_history` / `score_events` — the flagship

| Field (shipped col) | Screen(s) | R/D |
|---|---|---|
| `score` 0–100, `rating` (BUY…SELL), `weekly_delta` | 1g ScoreModule, watchlist, 2b feed | D |
| `grade_value/growth/profitability/momentum/revisions` (A…D±) | 1g factor grades, 4b gate | D |
| `sector_percentile`, `sector_peer_count` | 1g "84th pct of 61 energy names" | D |
| `computed_at` (04:00 GST), `next_compute_at` | 1g as-of stamp | D |
| PENDING (90 trading days) → absence of row; `securities.score_eligible_from` | 22c | D |
| score/rating/grade change events | 2b, alerts, 8b | `score_events` | D |

> Priority **M**. **100% DERIVED, zero variable cost** (see §3). Inputs are families **C/D** (Value,
> Growth, Profitability), **B** (Momentum), **G** (Revisions). Free tier sees the masked
> `score_events_feed` teaser; exact score is premium.

#### F · FILINGS — `filings` (+ FTS `full_text`, `extracted_facts` jsonb, `ai_summary`) — partly ingested

| Field(s) | Screen(s) | R/D |
|---|---|---|
| `source_ref`, `form_code`, `filing_type`, `title`, `filed_at` | 3c, 7b, 7d, m1b | R (**done**) |
| `full_text` (machine-extracted EN) | 7d, phrase-alert scan | R (**missing**) |
| `extracted_facts` jsonb (DPS/ex/record/pay grid) | 7d fact grid | R→typed (**missing**) |
| `is_market_moving` | 7a/7b "big" rows | D |
| `pdf_en_path`, `pdf_pages` (Storage `filings`, public bucket) | 3c, 7d PDF | R |
| `ai_summary`, `ai_summary_model` | 7d Marsad AI summary | D (LLM) |

> Priority **M** (upgrade, not greenfield). Announcement **lists** are ingested; what's missing is
> **`full_text` extraction + `extracted_facts` typing + `ai_summary`**. The filing text corpus is
> the phrase-alert + FTS + AI-grounding + dividend-facts source.

#### G · EARNINGS + ESTIMATES + REVISIONS — `earnings_events`, `estimates` — feeds Score's Revisions

| Field(s) | Screen(s) | R/D |
|---|---|---|
| `report_date`, `date_state` (confirmed/estimated), `session` | 8a calendar, 3c | R |
| `eps_consensus / eps_marsad / eps_prior / eps_actual` | 8a, 8b | R (consensus/actual) + D (marsad) |
| `revenue_consensus / revenue_actual` | 8b | R |
| `verdict` BEAT/IN_LINE/MISS, `surprise_pct`, `next_session_reaction_pct` | 8b, 8d | D |
| `rvc_table` jsonb (line-vs-consensus), `house_rank` | 8b | D |
| estimate obs `metric`/`source`(consensus\|marsad)/`value`/`n_analysts`/`as_of` | 8c, 18b | R (consensus) + D (marsad) |
| revision leaders/laggards, breadth | 8c, 8d | D (MV over `estimates`) |

> Priority **M** for the Revisions factor; **⚠ sourcing caveat**: **street consensus estimates
> have NO cheap named source** (probing found Yahoo `earningsTrend` sparse on GCC; Mubasher
> `fair-values` gives analyst *price targets* not consensus *EPS revisions*). `estimates` rows will
> be **sparse**; Marsad's own estimate is DERIVED by the desk. **Earnings *actuals* are cheap** (from
> results filings). The Revisions grade **degrades gracefully to `NULL`** where consensus is absent —
> do not gate the Score on it (§3.5, D-8).

#### H · DIVIDENDS — `dividends` (human-confirm fan-out) — mostly free from F

| Field (shipped col) | Screen(s) | R/D |
|---|---|---|
| `div_type` (FINAL/INTERIM/SPECIAL), `dps`, `currency` | 1g dividend card, 23a | R |
| `ex_date`, `record_date`, `pay_date`, `fiscal_ref` | 23a grouping, 7d facts | R |
| `yield_at_announce`, `payout_ratio` (>100% cut-risk) | 23a leaders/flags, 1g | D |
| `verification` (registrar\|disclosure), `state` (pending_confirm\|live), `confirmed_by` | 33b badge | R + workflow |

> Priority **M**. DPS/ex-date come straight from **DIVIDEND filings** (`extracted_facts`) — cheap
> once F exists. Also directly in Mubasher `/corporate-action` for TDWL/ADX. Price-sensitive →
> `pending_confirm` human gate before `live`.

#### I · COMPANY PROFILE + PEOPLE — `securities` (identity) + `company_people` (**deferred table, create it**)

| Field(s) | Screen(s) | R/D |
|---|---|---|
| `name_en`, `ticker`, `venue_code`, `sector`, `industry`, `board_segment`, `currency` | everywhere | R |
| `free_float_pct`, `shares_outstanding`, `listing_date`, `isin`, `status` | 3a stats, 3d, `market_cap` | R |
| AI company-profile prose + citations; machine pros/cons | 3a | D (LLM over filings) |
| board members (11 seats · 5 indep.), management | 3d board & management | `company_people` (name, role, is_independent, seat_count) | R |

> Priority **M** for identity (`securities`); **board/people is high-value-but-thin**.
> **`company_people` must be created** (a `02-data-lake.md` "Missing entity"). `shares_outstanding`
> is load-bearing — `market_cap` and every per-share ratio depend on it.

#### J · OWNERSHIP — `ownership_snapshots` (category matrix + FOL) + `holders`/`holder_positions`

| Field(s) | Screen(s) | R/D |
|---|---|---|
| `categories` jsonb (government/institutions/foreign/retail %) | 3d shareholding matrix | R |
| `foreign_ownership_pct`, `is_fol_record` (FOL badge) | 3d foreign-ownership record | R + D (record detect) |
| top holders: name, `holder_type`, country, `stake_pct`, `qoq_change_pp` | 3d, 20b/20c | `holders`+`holder_positions` | R |
| float-watch callout | 3d | D |

> Priority **M** for the Ownership tab. **Quarterly cadence → low scrape volume.** Source:
> Mubasher `/major-shareholders` (TDWL/ADX, with history) + venue/registrar disclosures + >5% filings.

### 1.2 NICE-TO-HAVE families (elevate the page; page is still credible without them)

| # | Family | Table(s) | Priority | Note |
|---|---|---|---|---|
| **K** | Street consensus PT strip ("14 ratings, avg PT") | `analyst_calls` (Marsad's own) / consensus (sparse) | **N / partly blocked** | Marsad calls covered; street consensus shares G's sourcing gap. Mubasher `/fair-values` (TDWL/ADX) is the richest analyst-target source found. |
| **L** | Analyst-maintained datapoint series ("43 tracked") | `datapoint_series`, `datapoints` | **N** (flagship on Aramco, thin elsewhere) | Hand-curated, not bulk-scraped. `datapoints` is architecturally central but the *maintained series* are premium depth. |
| **M** | Corporate actions beyond dividends (splits, rights, capital increases) | `filings.extracted_facts` + `lake.objects` | **N** | Falls out of F for free once `extracted_facts` typing exists; Mubasher `/corporate-action` also carries these for TDWL/ADX. |
| **N** | Transcripts / concalls | `transcripts`, `transcript_segments` | **N** (defer past P2) | Heavy (audio + diarization + AR/EN). |
| **O** | IPO / listing (pre/just-listed only) | `ipo_offers`, `ipo_timeline_events`, `listing_debuts` | **N for P2** | Affects a handful of names; the 812 established pages don't use it. |
| **P** | AI thesis (premium standing thesis) | `ai_theses` | **N / premium** | Fully DERIVED (LLM over D/G/N); depends on those being populated. |

---

## 2. Source → datapoint coverage matrix (grounded in live probing)

> All findings below are from **live probes via the VPS** (Hetzner DE IP `91.99.99.85`) with
> Playwright, plus local-IP Yahoo tests, on 2026-07-13/14. **Not doc-derived.** The WAF posture
> **tightened** mid-probe (BHB went from plain-200 in P1 recon to hard IP-block).

### 2.1 Reachability / WAF posture (per source, from the VPS)

| Source | From VPS | Verdict |
|---|---|---|
| **Yahoo** `query1/2.finance.yahoo.com` | **429 HARD-BLOCKED** on chart/quoteSummary/getcrumb; sticky per-IP for hours. Local IP also 429'd after ~20 req. Lighter `/v1/finance/search` still answers. | **Needs residential/rotating egress.** ~~the *only* fundamentals+history source for DFM+QE~~ → **now DFM only** for fundamentals: QE has a native XBRL JSON API (2026-07-17), so Yahoo no longer gates QE fundamentals. Still blocker #1 for **DFM fundamentals** and for **DFM+QE price history**. |
| **Mubasher** `english.mubasher.info` | **200, plain HTTP, no auth.** Angular client-rendered HTML (not clean JSON). | **The cheap workhorse for TDWL + ADX.** Must scrape with a **content-poll on the table selector**, NOT `networkidle` (ad scripts keep the network busy → false "no data" 4/6 times in testing). |
| **Mubasher APIs** `api-community…`, `api.tadawuly.gfm.support` | reachable; `/api/v1` root 404; only `auth/tadawuly/initialData`. | **Community/social layer, NOT fundamentals.** Fundamentals are in the rendered pages. |
| **Mubasher historical CSV** `static.mubasher.info/File.MubasherCharts/…/{hash}.csv` | **200, plain HTTP, no auth.** Full daily OHLCV since IPO (Aramco 2019-12-11→present, 1631 rows). `{hash}` is per-ticker, embedded in the stock-page HTML. Intraday delayed variant at `File.Delay_Stock_Intraday_Charts_Dir`. | **Standout artifact** — the cleanest single price-history file. |
| **Argaam** `www.argaam.com` | homepage 200 via real Chromium (auto-solves AWS WAF); **deep per-company URLs → 405 "Human Verification"** even warmed; **paywalled** ("Argaam Trial"). | **Not viable cheaply.** WAF-hostile + Saudi-centric + subscription. |
| **ADX** `www.adx.ae` | curl **403**; **real Chromium gets through**. `_next/data/…/company-profile/financial-reports.json` + `overview.json` per company; `apigateway.adx.ae/adx/lookups/1.1/data/listed-companies` for the universe. | **Cleanest structured financials of the WAF trio.** Playwright request-context. |
| **QE** `www.qe.com.qa` | **200 plain HTTP.** Market data = `POST /wp/mw_app/mw.php` (`f=MarketWatch`) — the `/pps/qse_files/MarketWatch.txt` path is a **stale static file**, retired by `20260715085252`. **FS = an XBRL-native JSON REST API**, `qdisclosure/api/XBRL/GetFinancialStatementsAPIData?symCode=&reportEndDate=&sectionName={Balancesheet\|Incomestatement\|Cashflow}` → `[{xbrlID, Value, FromDate, ToDate}]` (pinned 2026-07-17; discovered in `/pps/XBRL/fsStatements.js`). Sibling routes `CheckFSAttachmentExistAPI` / `GetFSAttachmentAPI` serve the PDFs. **No browser, no cookies** (~100 ms TTFB). | **T1 — parse IFRS-tagged JSON.** ~~T2 HTML tables~~ was a guess and is wrong; the tab renders client-side from this API. Depth floor **2020**. |
| **MSX** `www.msx.om` | **200 plain HTTP.** `Companies-Fin-Pref.aspx` (3 tables), `companies.aspx`, MSX-Financial-Report / annual-report bulletins (PDF/XLSX). EN lags AR. | **T3 — thin structured, leans on PDF pipeline.** |
| **BHB** `bahrainbourse.com` | **403 even via headless Chromium → IP-based block (Radware-class).** | **T4 — the VPS IP itself is the problem.** Needs a different egress. |

### 2.2 Coverage matrix — data family × venue (recommended source per cell)

**Yahoo covers only `.SR` (TDWL), `.AE` (DFM), `.QA` (QE).** Confirmed via Yahoo search:
OMANTEL / BATELCO / Aldar return **zero** equity quotes — Yahoo has **no MSX, no BHB, no ADX**.
**Mubasher deep-fundamentals = TDWL + ADX only** (verified: 2222 and ADX/ALDAR render full 5-yr
statements + ratios; **DFM/EMAAR, DFM/GFH, QE/QNBK, QE/QEWS render EMPTY** even with a 30 s
content-poll — the pages are shells for DFM/QE).

| Data family | TDWL | DFM | ADX | QE | MSX | BHB |
|---|---|---|---|---|---|---|
| **Price history (daily OHLCV)** | Mubasher CSV + Yahoo `chart` | Yahoo `chart` | ADX native / Mubasher CSV | Yahoo `chart` + QE `MarketWatch.txt` | **`msx.om` `company-chart-data.aspx?s={symbol}` ✓ (native JSON, ≥2y daily **close-only**, 0034)** | **GAP → BHB XLSX bulletin (needs proxy)** |
| **Fundamentals (IS/BS/CF)** | Mubasher `/financial-statements` ✓ + Yahoo `fundamentals-timeseries` | **Yahoo only** ⚠ | **ADX `financial-reports.json`** ✓ | **QE-native XBRL JSON ✓** (`qdisclosure/api/XBRL`, 2020+, all 3 statements, IFRS-tagged) — Yahoo no longer needed | **`msx.om` `Companies-Fin-Pref.aspx` + PDF** | **GAP (all) → proxy + PDF** |
| **Ratios (P/E,P/B,ROE,ROA,margins,EPS)** | Mubasher `/ratios` ✓ + Yahoo | Yahoo | Mubasher `/ratios` ✓ | Yahoo + QE `/financial-indicators` | **derive from `msx.om` statements** | **GAP → derive from proxied statements** |
| **Dividends / corp actions** | Mubasher `/corporate-action` ✓ + filings | Yahoo + filings | Mubasher ✓ + filings | Yahoo + QE + filings | **filings + `msx.om`** | **GAP → filings via proxy** |
| **Earnings history / estimates** | Mubasher `/earnings` + Yahoo `earningsTrend`(thin) | Yahoo `earningsTrend`(thin) ⚠ | Mubasher + filings | Yahoo(thin) + filings | **filings actuals only** | **GAP** |
| **Analyst targets / recommendations** | **Mubasher `/fair-values` ✓ (best-in-class, multi-broker history)** | Yahoo(thin) | Mubasher `/fair-values` | Yahoo(thin) | **GAP** | **GAP** |
| **Ownership / major shareholders** | Mubasher `/major-shareholders` ✓ (history) | Yahoo(thin, no GCC holders) | Mubasher ✓ | Yahoo(thin) + filings | **filings + `msx.om`** | **GAP → filings via proxy** |
| **Profile / sector / description** | Mubasher `/profile` + Yahoo | Yahoo | Mubasher / ADX `overview.json` | Yahoo + QE `/companymoreinformationsearch` | `msx.om` `companies.aspx` | **GAP** |

**Exact shapes captured live (verbatim):**
- **Mubasher `/financial-statements`** (TDWL 2222, ADX ALDAR): cols = years 2021–2025; rows
  `Total Assets`, `Total Liabilities`, `Total Owners' Equity`, `Net Income or Loss`, `Gross Profit`,
  `Net Cash Flow from Operating/Investing/Financing`, `Net Change in Cash`. Full-precision values
  (`2,516,431,000`).
- **Mubasher `/ratios`**: `ROE % 31.37`, `ROA % 18.05`, `EPS 1.99`, `Net Profit Growth % 25.56`,
  `Total Assets Growth %`, `Book value growth %`, `EPS Growth %`, `Cash from operations Growth %`.
- **Mubasher `/major-shareholders`**: `OWNER | CURRENT % | PREVIOUS % | CHANGE | LAST UPDATE` (history).
- **Mubasher `/corporate-action`**: `ANNOUNCEMENT DATE | EFFECTIVE FROM | TYPE | DESCRIPTION` back to 2019.
- **Mubasher `/fair-values`**: `DATE | SOURCE | FAIR VALUE | STOCK PRICE | CHANGE | CHANGE % |
  RECOMMENDATION` (e.g. `Al Rajhi Capital | 31.00 | Over Weight`) — multi-broker consensus history.
- **ADX** `financial-reports.json` + `overview.json` (structured JSON, Next.js SSR).
- **Yahoo** crumb flow: `GET fc.yahoo.com/` (cookie) → `GET query2…/v1/test/getcrumb` → append
  `&crumb=`; then `/v10/finance/quoteSummary/{sym}?modules=` (`summaryDetail`→P/E,P/B,divYield;
  `defaultKeyStatistics`→PB,EPS,shares; `financialData`→ROE,margins,revenue;
  `*StatementHistoryQuarterly`→line items; `earningsTrend`→estimate revisions;
  `institutionOwnership`/`majorHoldersBreakdown`→ownership). `fundamentals-timeseries` returns
  multi-year standardized statements (QNBK.QA → 4yr total assets w/ segments; 2222.SR works).
  **GCC caveat:** on Saudi/UAE/Qatar names, `institutionOwnership` + estimate modules are typically
  **sparse/empty** — Yahoo's non-price GCC fundamentals are thinner than for US names (why Mubasher
  matters for TDWL/ADX).

### 2.3 THE GAPS (no cheap source) — state honestly on the coverage board

1. **MSX (Muscat)** — every family except price/profile has no aggregator. Only lead:
   `www.msx.om` (200) scraped directly for its `.aspx` statistics + PDF bulletins. Thin, PDF-heavy.
2. **BHB (Bahrain)** — every family **including price**. No Yahoo, no Mubasher, and
   `bahrainbourse.com` is **403 from the VPS DE IP even in headless Chromium** → needs a
   **GCC/residential proxy** to even reach the exchange. **Hardest venue.** ~40 listings, thinnest —
   **lowest ROI, must not block P2.**
3. **DFM + QE fundamentals depth** — covered by Yahoo *in principle* but Yahoo is **429-blocked from
   the VPS**, so in practice **currently unreachable** until Yahoo egress is fixed. Mubasher does
   **not** fill this (DFM/QE fundamental pages are empty shells). QE's own HTML tables are the
   fallback second source.

### 2.4 What the 2-source `VERIFIED` rule actually yields (per-venue reality)

The locked "2-source cross-check → `VERIFIED` `lake.objects`" is **only fully satisfiable for TDWL**
(Mubasher + Yahoo overlap). The verification bar **needs per-venue relaxation**:

| Venue | Source 1 | Source 2 | Verification tier achievable |
|---|---|---|---|
| **TDWL** | Mubasher | Yahoo | **VERIFIED** (true 2-source) |
| **DFM** | Yahoo | DFM native board / QE-style HTML | VERIFIED once Yahoo egress fixed; else single |
| **ADX** | ADX native | Mubasher | **VERIFIED** (both reachable) |
| **QE** | Yahoo | QE native HTML | VERIFIED once Yahoo egress fixed; else QE-native single |
| **MSX** | `msx.om` scrape | filings PDF | single-ish (cross-check own site vs filing) |
| **BHB** | (proxy needed) | filings PDF | **single at best** — coverage-gap venue |

> **Owner decision D-src-1:** accept a **per-venue verification tier** (`VERIFIED` for TDWL/ADX/
> DFM+QE-with-egress; `SINGLE_SOURCE` for MSX/BHB) surfaced honestly on the reader's freshness/
> provenance UI, rather than blocking a venue's data on an unreachable second source.

#### 2.4a UPDATE 2026-08-16 — the second source turned out to be the extraction lane, not the feed

The table above reasons about *quote/price* feeds, and on that axis it still holds. It is the wrong
frame for **fundamentals**, and framing it that way is what left `VERIFIED` at 0.2% of the lake for
a month.

The corroboration that matters for statements is not two price feeds; it is **two independent
extractions of the same company-quarter**: the venue's own filing (PDF/XBRL) against the
stockanalysis lane, compared by `lake.fn_financials_xcheck_reconcile`
(`20260721100000_financials_xcheck_reconcile_v2.sql`) on the core line items within 1%. That was
running, and had already produced **9,915 `agree` verdicts across 523 securities** — in
`public.financial_statement_xcheck`, where nothing acted on them. The objects stayed `PENDING`, so
R-03 refused to let the newsroom cite any of them.

`20260816120000_pe6c_financials_verify_from_xcheck.sql` promotes them
(`VERIFIED`, `verification_basis = 'corroborated'`) and marks the 2,586 disagreements `CONFLICT` so
a disputed figure cannot be cited at all. Promotion now hangs off the verdict table, so every future
stockanalysis pass verifies or conflicts its counterpart automatically.

**Live effect:** `lake.objects` VERIFIED went 1,553 → 11,469, and `FILING.FINANCIALS` went from
**1** verified object to 9,915 across 523 securities.

Two consequences worth carrying forward:

- **`VERIFIED` alone was never a truth claim.** `COMPUTED.RATIOS` and `COMPUTED.SCORE` write
  themselves verified with `verified_by = SYSTEM`; that is a lineage assertion, not corroboration,
  and it was 83% of everything verified. `lake.objects.verification_basis` now records *how* a row
  earned the state (`corroborated` / `derived` / `human` / `primary_document`), and `BLK-PROV`
  should show it rather than a bare VERIFIED badge.
- **The corroboration lane is the thing to keep alive.** All six `stockanalysis_financials_*`
  researchers stopped on 2026-07-21 and nobody noticed for 26 days, which is exactly why no *new*
  object has earned corroboration since. They are now registered in `ops.researcher_registry` and
  alert through `ops.heartbeat_sentinel()` (`20260816140000`).

---

## 3. Derived pipeline — ratio catalog + Marsad Score v1 + nightly compute

> Locked infra (do not re-litigate): `key_ratios` recompute rides the **`nightly_omnibus`** pgmq
> task at `0 22 * * *` UTC = **02:00 GST**; `score_batch` at `0 0 * * *` UTC = **04:00 GST**
> (`worker/agents/score.ts`, `q_maintenance`, heartbeat key `score_batch`, TTL 86400 s — confirmed
> in `…0015_cron.sql`). `estimates_agg` is **not yet scheduled** — added as a new pre-ratio cron at
> 23:00 GST (§3.6). pg_cron **enqueues**, the **VPS worker executes**.

### 3.1 Fundamental input primitives (the minimum fundamentals contract)

The extraction must populate these keys in `financial_statements.line_items` (jsonb) per period
(quarterly + annual + a computed **TTM** row, `period_kind='ttm'`). Everything downstream is a pure
function of these + price.

| Primitive | jsonb key | Statement | Note |
|---|---|---|---|
| Revenue | `revenue` | income | banks: `total_operating_income` (NII + fees) |
| Gross profit | `gross_profit` | income | N/A banks/insurers → gross-margin null there |
| Operating income (EBIT) | `ebit` | income | |
| Dep. & amort. | `dep_amort` | cashflow | for EBITDA |
| Net income (attributable) | `net_income` | income | post-minority |
| EPS (diluted) | `eps_diluted` | income | prefer reported; else `net_income / shares_diluted` |
| Total equity (attributable) | `equity` | balance | ex-minority for ROE |
| Total assets | `total_assets` | balance | |
| Total debt | `total_debt` | balance | ST + LT borrowings |
| Cash & equivalents | `cash` | balance | |
| Capital employed | derived `total_assets − current_liabilities` | balance | for ROCE |
| NIM inputs | `nii`, `avg_earning_assets` | banks only | |
| Dividends paid | `dividends_paid` | cashflow | payout cross-check |

TTM = trailing-4-quarter sum for flows, latest for stocks/balance, computed by the ratio job.

### 3.2 Ratio catalog (formula → input → `key_ratios` column)

> **Every ratio below is bounded by its column.** `key_ratios` columns are `numeric(p,s)`, which
> reject any value with `abs(v) >= 10^(p-s)` — the tight ones are `roe`/`roce`/`nim`/`net_margin`/
> `gross_margin`/`dividend_yield`/`payout_ratio` at `numeric(7,4)` ⇒ **max 999.9999**. Guarding a
> **zero** denominator is not enough: a near-zero one produces a huge *finite* number that passes
> every `isFinite` check and then raises `numeric field overflow` on INSERT. Live 2026-07-17: DFM
> ALFIRDOUS booked AED 647 of trailing revenue against ~3.66M of investment income ⇒ `net_margin`
> 5,663 ⇒ the whole nightly recompute died. `fitToColumnBudget()` (`ratios-compute.ts`) mirrors this
> DDL and **nulls** anything unstorable — never clamps, since a clamped 999.9999 would assert a
> 99,999% margin and top every high-margin screen, whereas a null just drops the name from that
> filter (the module's "never a wrong number" contract). Each drop is logged: an out-of-range ratio
> is either a degenerate business or an upstream extraction bug, and both must stay visible.
> **Adding a column here means adding its `(p,s)` to `COLUMN_NUMERIC`.**

**Valuation** (price + fundamentals): `market_cap = last × shares_outstanding`;
`pe = market_cap / net_income_ttm`; `pb = market_cap / equity`; `ps = market_cap / revenue_ttm`;
`eps_ttm` = trailing-4Q `eps_diluted`; `book_value_ps = equity / shares_outstanding`;
`ev_ebitda = (market_cap + total_debt − cash) / (ebit + dep_amort)_ttm`.

**Profitability** (fundamentals): `roe = net_income_ttm / avg_equity`;
`roce = ebit_ttm / avg_capital_employed`; **`net_margin`** = `net_income_ttm / revenue_ttm`;
**`gross_margin`** = `gross_profit_ttm / revenue_ttm` (null banks/insurers);
`nim = nii_ttm / avg_earning_assets` (banks).

**Leverage:** `net_debt_ebitda = (total_debt − cash) / ebitda_ttm` (null/flag banks).

**Income:** `dividend_yield = dps_ttm / last`; `payout_ratio = dps_ttm / eps_ttm` (>1.0 → cut-risk flag).

**Growth** (multi-period, `[NEW COL]`): `rev_growth_yoy`, `eps_growth_yoy` (TTM vs prior-year TTM);
`rev_cagr_3y`, `eps_cagr_3y` = `(ttm / 3y_ago)^(1/3) − 1`.

**Momentum** (price only, from `ohlcv_daily`, `[NEW COL]`): **dividend-and-split-adjusted** returns
`ret_3m = close_t/close_{t−63} − 1`; `ret_6m = close_t/close_{t−126} − 1`;
`ret_12_1 = close_{t−21}/close_{t−252} − 1` (classic 12-1, skips 1-month reversal);
52w-range position `(last − week52_low)/(week52_high − week52_low)` (computed at score time).

**One additive migration — `[NEW COL]` on `key_ratios`** (forward-only, no destructive change):
```sql
alter table public.key_ratios
  add column net_margin       numeric(7,4),
  add column gross_margin     numeric(7,4),
  add column rev_growth_yoy   numeric(9,4),
  add column eps_growth_yoy   numeric(9,4),
  add column rev_cagr_3y      numeric(9,4),
  add column eps_cagr_3y      numeric(9,4),
  add column ret_3m           numeric(9,4),
  add column ret_6m           numeric(9,4),
  add column ret_12_1         numeric(9,4),
  add column ebitda_ttm       numeric(20,2),   -- cached, feeds ev_ebitda + net_debt_ebitda + Score
  add column currency_computed char(3);        -- ratios in local ccy; USD-normalize at read via fx_rates
```

### 3.3 Sector-conditional ratio validity (the #1 credibility item — GCC is ~40–60% banks)

The Score engine **must** consult a sector→valid-ratio map, not blindly average:

- **Banks:** P/E, **P/B (primary bank gauge)**, ROE, NIM. **Exclude** EV/EBITDA, net-debt/EBITDA,
  gross margin (deposits are "debt" — these are meaningless).
- **Insurance:** P/B, ROE, combined-ratio (v2). Exclude EV/EBITDA, gross/net-debt.
- **Real estate:** P/B, EV/EBITDA valid; P/FFO preferred (v2).
- **Energy/Materials/Industrials/Utilities/Telecom/Consumer/Healthcare:** full ratio set.

> Using EV/EBITDA on a bank is the single fastest way a GCC quant score loses credibility. This is
> **owner decision D-1**.

### 3.4 Marsad Score methodology v1 — the five factors

| Factor | Direction | Component metrics (weights within factor) |
|---|---|---|
| **Value** | cheap = high | earnings yield E/P (30), P/B⁻¹ (25), EV/EBITDA⁻¹ (25), div yield (20). **Bank override:** P/B 50, P/E 30, yield 20, drop EV/EBITDA |
| **Growth** | high = high | EPS growth YoY (35), rev growth YoY (25), EPS CAGR 3Y (25), rev CAGR 3Y (15) |
| **Profitability** | high = high | ROE (30), ROCE-or-NIM (25), net margin (25), gross margin (20, null-skip) |
| **Momentum** | high = high | ret_12_1 (40), ret_6m (25), ret_3m (20), 52w-range (15) |
| **Revisions** | up = high | 90d Δ consensus FY-EPS (40), 30d Δ (30), breadth `(n_up−n_down)/n` (20), Marsad-vs-street gap sign (10) |

**Use earnings *yield* (E/P), not 1/PE** — negative earnings then rank at the bottom (correct)
instead of producing NULL. Invert P/E, P/B, EV/EBITDA at score time so "higher = better" holds
uniformly before ranking.

### 3.5 Normalization, weighting, grades, missing-data rules

**Normalization — sector-relative percentile (the core IP choice):** for each metric, within each
**GCC-wide sector cohort** (all names in that sector across all 6 venues with the metric defined):
(1) **winsorize** at 2nd/98th pct (kills scrape outliers — a mis-parsed EPS must not blow up the
cohort); (2) **percentile-rank** each name 0–100 (percentile not z-score — the design shows "84th
percentile of 61 energy names", GCC distributions are fat-tailed/non-normal, percentiles are
distribution-free and presentable); (3) **factor score** = weighted average of component
percentiles, **weights renormalized over non-null components**.

> **GCC-wide cohorts, not per-venue** (owner **D-2**): a Saudi bank and a Qatari bank compete in one
> "Banks" cohort — this is the platform's whole thesis (FX pegs make cross-venue clean; liquidity
> differences are the caveat). Minimum cohort size **8**; thinner GCC sectors flag `thin_cohort=true`.
>
> **`technology` is a DISTINCT cohort** (owner call 2026-07-16, migration `20260716190059`): the 6 TDWL
> IT filers (7200/7201/7202/7203/7211 "IT Services / Software", 9524 "Electronic Equipment") were force-
> fit to `unknown` before the key existed. Owner chose a distinct `technology` cohort over folding into
> `industrials` — it starts <8 GCC names so it flags `thin_cohort=true` until more IT names land, the
> accepted trade for a clean tech peer set. The 13th key (`unknown`) is never a scored cohort.

**Weighting → 0–100:**
```
composite = 0.25·Value + 0.20·Growth + 0.20·Profitability + 0.20·Momentum + 0.15·Revisions
```
Value-tilted (owner **D-3**): an observatory brand should lean quality-value not momentum; Revisions
is sparse at launch so it gets the lowest weight. Then **re-percentile the composite across the full
812-name universe** → published `scores.score` ("76" = 76th percentile GCC-wide, defensible).
`scores.sector_percentile` = composite percentile *within sector cohort* (the "84th of 61" footnote).
Both stored.

**Rating bands** (owner **D-4**, config in `ops.rulesets`): 80–100 BUY · 60–79 OVERWEIGHT ·
40–59 HOLD · 20–39 UNDERWEIGHT · 0–19 SELL (fixed quintiles ≈162 names each; PM may want asymmetric).

**Factor letter grades** (12-bucket ladder, regex `^[A-D][+-]?$` already enforced on `scores.grade_*`):
`A+ ≥90 · A 83 · A- 76 | B+ 69 · B 62 · B- 55 | C+ 48 · C 41 · C- 34 | D+ 27 · D 20 · D- <20`.
Grade changes emit `score_events(event_kind='grade_change', detail={"factor":"revisions","from":"B","to":"B+"})`.

**Missing-data rules (each an owner sign-off):**
- A factor computes if **≥50% of its component weight is non-null**; else grade = `NULL` (UI "—"),
  **dropped from composite with weights renormalized**. **Never impute zeros** — a missing ROE must
  not read as worst-in-class.
- A name needs **≥3 of 5 factors** to publish a `scores` row at all; fewer → no row (PENDING-like).
  Prevents a 2-datapoint score masquerading as real. (Owner **D-5**.)
- **New listings:** no `scores` row until `securities.score_eligible_from` (= listing_date + 90
  trading days). 22c seeds Value+Growth from prospectus-implied P/E + historical CAGR
  (`ipo_offers.implied_pe`); Momentum/Revisions/Profitability `NULL` until real history. First real
  score at day 90 needs ≥63 daily closes — aligns exactly.
- **Corporate-action distortions:** Momentum **must** use dividend-and-split-adjusted returns
  (a 6% special dividend is not a 6% fall). Build an adjustment factor from `dividends` ex-dates +
  split events. (Owner **D-6** — highest-effort input, non-negotiable for correctness.)
- **EPS one-offs:** v1 uses reported EPS (no normalization); winsorization caps the damage; full
  normalization is v2. (Owner **D-7**, known limitation.)
- **Stale fundamentals:** newest `period_end` >18 months → `stale_fundamentals=true`; score carries
  a freshness caveat, don't silently score on 2-year-old books.
- **Revisions ships `NULL` at launch** (no consensus source, G's gap). Don't gate the flagship on an
  unsourced feed. (Owner **D-8**.)

**Event-driven recompute:** on `earnings_events.verdict` being set, enqueue a **single-name**
recompute into `q_maintenance` — recomputes only that name's factors against the **last nightly
cohort snapshot** (cheap, no full re-rank), updates Revisions grade, emits `score_events`. Delivers
"BEAT +4.2% → Revisions B→B+ overnight" without a nightly-scale intraday job.

### 3.6 Nightly compute design (dependency order — must hold every night)

```
23:00 GST  estimates_agg  (NEW cron)  → 30/90d revision Δ + breadth → revisions_features MV
02:00 GST  key_ratios     (nightly_omnibus task) → reads financial_statements(TTM)+quotes_latest
                                                    +dividends+ohlcv_daily → writes key_ratios (all cols)
04:00 GST  score_batch    (worker/agents/score.ts, q_maintenance)
             A build sector cohorts, winsorize, percentile-rank each metric  (needs key_ratios fresh)
             B compute 5 factor scores per name
             C composite → universe percentile → score, rating, grades
             D diff vs yesterday → score_events; upsert scores + score_history
             E emit one COMPUTED.SCORE lake object per name (lineage, source_object_id)
04:30 GST  select_rebalance (monthly) — reads fresh scores
```

**Why the order is forced:** ratios depend on TTM rows + same-day prices; a percentile is
**meaningless mid-population** — all 812 names must be ratio-complete before any percentile is valid.
So `key_ratios` is a **complete-table** job that must finish before `score_batch`. The 02:00→04:00
gap is the safety buffer.

**Where each step runs + cost:**

| Step | Runs where | Cost |
|---|---|---|
| `estimates_agg`, TTM roll-up, `key_ratios` recompute | **SQL** (MV + functions; arithmetic over ≤ a few thousand rows, co-located with the screener's scan target) | **~0** (Postgres CPU already paid) |
| **Score compute** (cohorts, winsorize, percentile, weight, grade, diff) | **VPS worker** `worker/agents/score.ts` — branch-heavy business logic, cleaner/testable in TS; SELECTs `key_ratios`+`revisions_features` (≤812 rows × ~25 cols, trivial), computes in memory, bulk-UPSERTs | **~0 incremental** (VPS resident, flat-rate; **no LLM — pure math, zero token cost**) |

> **Total marginal run cost of the entire derived pipeline ≈ zero.** No external API, no LLM, no
> per-row billing — exactly the "cheapest run cost" constraint, and why the Score being math-not-LLM
> is strategically right: the flagship differentiator has **no variable cost**.

**Idempotency / lineage / failure:** `score_batch` is a full recompute keyed on compute date
(re-run overwrites `scores`, PK-dedupes `score_history(security_id, computed_on)`); tracked by
`job_heartbeats`/`job_runs`, `heartbeat_sentinel` raises an incident on silence. Each score writes a
`COMPUTED.SCORE` lake object (`scores.source_object_id`) whose payload carries the input snapshot
(which `key_ratios.computed_at`, cohort sizes, weights version) — every published score walks back to
inputs. **Freshness gate:** if `max(key_ratios.computed_at) ≤ today 02:00` (job 6 failed),
`score_batch` **aborts and alerts** rather than scoring on yesterday's ratios silently.

### 3.7 Minimum inputs for a credible Score v1 (ship this)

A Score is credible the moment it has genuine sector-relative **valuation + quality + momentum**:

| Factor | v1 minimum input | Source (already wired / cheap) |
|---|---|---|
| **Value** | P/E, P/B, div yield | price + `eps_ttm`,`equity` from statements + `dividends` |
| **Profitability** | ROE, net margin (+ NIM banks) | `financial_statements` only (no price) |
| **Momentum** | ret_12_1, ret_6m (div-adjusted) | `ohlcv_daily` — **must persist daily closes (P1.7a)** |
| **Growth** | EPS & revenue YoY | 2 years of `financial_statements` |
| **Revisions** | — | **launches `NULL`** (no consensus source; add in v2) |

**Three factors (Value, Profitability, Momentum) are fully buildable from data we already ingest or
trivially can** — a credible, defensible Score across the full 812 universe. Growth needs 4–8
quarters (available for established names). **The one hard prerequisite is persisting `ohlcv_daily`.**

**v2 roadmap (not launch-blocking):** Revisions live (needs consensus source, resolves OQ-10); EPS
one-off normalization; sector-specialized factors (insurance combined-ratio, RE FFO, contractor
backlog); quality sub-factor (accruals, net-debt/EBITDA trend); risk overlay (vol/beta); point-in-
time cohort snapshots for backtesting (needed to ever publish the screener's "3Y vs TASI").

---

## 4. Prioritized enrichment plan (P1.7 sub-phases, ranked feasibility × reader-value)

> **The hard line for P2:** a stock page is **not credible** until it can render the Financials tab,
> the ratio strip, a price chart, dividends, ownership, and a Marsad Score. That is P1.7a–c
> (+ upgrade F). P1.7d–e enrich in parallel and can trail P2 launch.

> **Build status (2026-07-14) — the derived code spine landed; the live scrape has not.** Shipped +
> tested: the `key_ratios [NEW COL]` migration (0036); the **sector-aware ratio recompute** (§3.2/§3.3,
> as **TS** `ingestion/src/lake/ratios-compute.ts`+`key-ratios.ts`, **not** a SQL `fn_recompute_key_ratios()`
> — the code path chose TS; treat every "SQL fn"/"MV" reference in §3.2/§3.6 as satisfied by that TS service);
> the **statement-normalizer** (§2/§3.1 primitive contract + Mubasher/Yahoo mappers + validation harness,
> golden-tested; LLM/PDF path is a declared-throwing seam — **contract update 2026-07-18, Phase A**:
> `line_items` is an **open bag** of every printed line; the §3.1 primitives are the canonical ratio-engine
> **overlay**, not a closed vocabulary — the "non-primitive key" warning is retired; `statement_type` is
> the ONE `core/types.ts` union, now incl. `oci` + `equity_change`; statements carry an ordered
> `presentation` jsonb (`[{key,label,depth,is_subtotal}]`) for faithful rendering; the projection is v3
> (`20260718193005`): warn-on-skip instead of silent drops, content-vs-metadata change split so a
> presentation/segments refresh never fake-restates, and `source_filing_id` now links statements→filings;
> **Phase B same day**: the XBRL parser captures `oci` (title-matched, ordered before income; combined
> P&L+OCI single statements rescued as `income`) and the dimensional `equity_change` table
> (`{row}__{member}` keys + bare Total-equity roll-forward keys — dividends/buybacks/NCI movements),
> `snake()` 80→160 (associate-row key collision), SABIC yield 7→11 statements/filing;
> `tadawul-xbrl-replay.mjs` re-parses the ~2,969 owned storage HTMLs with zero scraping);
> the **Marsad Score engine + `score_batch`/`nightly`
> handlers** (§3.4/§3.5/§3.6, all owner D-1…D-10 encoded, freshness-gate abort); the **`public.filings`
> publish path** (§1.1 F, `lake.fn_filing_project`, single-source rule — 86 filings published); and the
> **`company_people`** table (§1.1 I); and — **added 2026-07-16** — the **source-agnostic statement
> persist layer**: the `FILING.FINANCIALS → public.financial_statements` projection
> (`lake.fn_financial_statement_project`, migration `20260716095100`) with **restatement versioning**
> (current-row `version`/`is_restated` + an append-only `public.financial_statement_history`; a restated
> quarter archives the prior version then overwrites in place, so readers keep one current row/period and
> the TTM roll-up never double-counts) + the `NormalizedPeriod→FILING.FINANCIALS` staging mapper
> (`runtime.mapStatement`/`flattenStatements`) + `financials` data_type routing. **Still gated:**
> `financial_statements` has the persist CONTRACT but no live **producer** yet — nothing emits
> `NormalizedStatementRow` on main (the persist layer is inert until one is seeded); and
> `securities.sector`/`isin`/`shares_outstanding` are empty for all 693 (so §3.3's map + §3.5's cohorts
> have no data to key on). Tracked in `BUILD-STATUS.md §7` (DEF-STMT-INGEST producer half; and
> **DEF-SECTOR-DATA persist half ✅ DONE 2026-07-16** — the source-agnostic `PROFILE.SECURITY` →
> `public.securities` projection `lake.fn_security_profile_project` (migration `20260716123154`, mirrors
> the statement persist layer) + the sector→`public.sectors.key` taxonomy (`securities.sector` is a FK to
> `sectors(key)`; `ingestion/src/lake/sector-taxonomy.ts`, golden-tested, unmappable → `'unknown'` LOGGED)
> + config-driven TDWL(Mubasher)/ADX(native overview.json)/MSX producers seeded `active=false` pending a
> VPS field-map capture — the reachable ≈548/693 = 79%; DFM/QE/BHB are §7 sub-rows). **Owner steer
> 2026-07-16: avoid the Mubasher aggregator (paywall/durability risk) — the preferred producer is the
> free deterministic Tadawul XBRL feed, pending a rebase onto main** (for the profile scrape too, the
> XBRL entity metadata carries sector/ISIN/shares_outstanding — the Mubasher-free TDWL producer).
> Ratios/Score run correct-by-design the moment a producer activates. Full sub-phase status:
> `BUILD-STATUS.md §5`.

### P1.7a — Price-history complete (CRITICAL PATH, unblocks Momentum + chart)
**Value: highest** (gates Score + chart tab). **Feasibility: high** for 4 venues, gaps for 2.

- **TWO FEEDS — do NOT conflate; both are required and have different cadences:**
  1. **BACKFILL — one-time per security.** Bulk-seed ≥2y of daily bars (Yahoo `chart?range=2y`,
     Mubasher CSV, etc.). Idempotent (snapshot dedup); re-runs only for a **new listing/IPO**, never
     on a timer. **Status: BUILT + PROVEN live 2026-07-14** (fetch→snapshot→parse→stage→cross-check→
     `ohlcv_daily`).
  2. **EOD ACCRUAL — +1 bar per security per trading DAY, ongoing forever.** A daily bar finalizes
     **once, at close** — so the cadence is **DAILY, never the ~10-min quote cadence**. Its input is
     the **intraday `quotes_latest` feed** (family **A**): the ~10-min in-session quote poll is what
     accumulates the day's ticks, and the EOD job rolls them into that day's O/H/L/C/volume. (Yahoo
     backfill only covers history that predates our own quote collection.) **Status: WIRED but NOT YET
     VALIDATED** — migration 0028 (`accrue_ohlcv_from_quotes` + `ohlcv_accrual` pg_cron @ 18:00 UTC)
     is live but has never run against a real session. **→ validation task V-1 below.**
- Persist `ohlcv_daily`: **backfill** where free + **accrue** EOD everywhere.
- TDWL/ADX: **Mubasher historical CSV** (`static.mubasher.info/…/{hash}.csv`, per-ticker hash from
  page HTML) — cleanest artifact. **ADX DONE (0033, seeded active=false)** — 2-step page→hash→CSV,
  `adapters/mubasher/ohlcv-csv.ts`, provider `mubasher_csv`, full daily OHLC since IPO (FAB verified
  2000→2026). TDWL still rides Yahoo; the same adapter can add TDWL later by seeding a row. **Effort: S.**
- DFM/QE: Yahoo `chart` — **blocked on Yahoo egress** (see cross-cutting blocker). QE `MarketWatch.txt`
  as EOD accrual fallback. **Effort: S once egress exists.**
- MSX: **DONE (0034, seeded active=false)** — native `www.msx.om/company-chart-data.aspx?s={symbol}`
  returns the full ≥2y daily series in one plain-HTTP JSON GET/ticker (`ingestion/src/adapters/msx/history.ts`,
  provider `msx-company-chart`). **Depth caveat: close-only** (LTP==Value; open/high/low null on the venue).
  Today's intraday ticks (space-timestamped `Date`) are filtered to daily bars only. **Effort: S (shipped).**
- BHB: **GAP** — BHB XLSX bulletin needs proxy. **Effort: L (BHB, proxy first).**
- The daily EOD snapshot/accrual job is already wired (0028) so history accrues regardless of backfill
  depth — the open item is **proving it**, not building it (below).
- **VALIDATION — exit criteria for P1.7a (tick ALL before P1.7b; the enrichment is not "done" until
  the ongoing feeds are proven, not just the one-time seed):**
  - **V-1 · EOD accrual proven (ONGOING daily bar).** After ≥1 GCC trading session, the 18:00 UTC
    `ohlcv_accrual` cron rolls that session's `quotes_latest` captures into **exactly one new
    `ohlcv_daily` bar per active security** — correct O/H/L/C/volume + trade_date, no duplicate, no
    gap vs the backfilled series. **UNPROVEN today** (wired, never run against a live session).
  - **V-2 · Intraday quote feed proven (the accrual's INPUT).** The ~10-min in-session quote poll
    keeps `quotes_latest` fresh through a full session (2-source VERIFIED where a 2nd source exists).
    V-1 depends on this, so validate it first/together — a gap in intraday capture = a bad daily bar.
    **→ Deferred item DEF-ADX-QUOTES rides here (market-open-gated, MUST use this window):** ADX quotes
    (source id=7) currently work via flaky `network_capture` discovery. In this live session, CAPTURE
    the marketwatch board JSON shape (field names → `fieldMap`) and repoint id=7 to the direct apigateway
    board `apigateway.adx.ae/adx/marketwatch/1.1/securityBoard/marketwatch` (static apikey +
    `Accept: application/json`, direct mode — mirror the ADX *filings* adapter which already fetches its
    apigateway URL directly). Needs an adapter change (`fetchAdxBoard` has no static-URL path today).
    ADX is NOT on Yahoo → ADX quote reliability directly gates ADX's ongoing `ohlcv_daily` accrual.
    **Effort: M.** Also foldable into P1.7e (ADX-native) — same adapter, same direct-fetch pattern.
  - **V-3 · Backfill completeness per venue.** TDWL `.SR` deep (505 bars proven); **QE `.QA` shallow
    (~40 bars) → needs QE `MarketWatch.txt` for Score depth (≥126)**; DFM `.AE` to verify; ADX/MSX/BHB
    per the source matrix. Full-universe backfill is gated on the throughput fixes (sweep-dedup +
    handler tx-threading — see `BUILD-STATUS.md`).

### P1.7b — Fundamentals + ratios via aggregators (the Financials tab + screener)
**Value: highest** (Financials tab, ratio strip, screener scan target, Score V/G/P inputs).
**Feasibility: high for 4 venues.**

> **Persist layer + restatement versioning landed 2026-07-16, reconciled onto the LIVE contract.**
> `FILING.FINANCIALS` lake.object → `public.financial_statements` is projected by
> **`lake.fn_financials_project`** (the function the live triggers call), which migration `20260716120000`
> rewrote from a clobber-upsert into a **restatement-versioning** projection: a restated quarter archives
> its prior version into the append-only `public.financial_statement_history` then overwrites the current
> row in place + bumps `version`/`is_restated`, so the reader table keeps exactly one current row per period
> and the TTM roll-up never double-counts. It reads the live **snake_case** payload contract
> (`statement_type`/`line_items`/…) + `object.security_id` (with a venue+ticker fallback). Migration
> `20260716095100` first shipped a source-agnostic camelCase variant (`fn_financial_statement_project`); the
> reconcile retired it to converge repo ⇄ live on ONE projection. The live table already holds **6,964 rows
> / 129 securities** from an active Tadawul-XBRL cron (off-main); the reconcile added versioning to that
> pipeline in place (existing rows become version 1). The staging mapper (`runtime.mapStatement` +
> `flattenStatements`) emits the same snake_case payload; any source emitting `NormalizedStatementRow[]` via
> a `financials` `TaskSpec` flows staging→cross_check→projection with no further wiring. **Owner steer
> 2026-07-16: AVOID the Mubasher aggregator** (paywall/durability risk) — the Mubasher adapter below was NOT
> built; the **producer is the free deterministic Tadawul XBRL feed** (live; pending a rebase onto main).
> The Mubasher shapes below stay valid as a tested normalizer path a future aggregator *could* reuse.
>
> **BHB statements producer (2026-07-16):** BHB now has its OWN statements producer — the
> `bhb-financials.mjs` Class-B researcher (`docs/architecture/08-worker-fleet.md §B`). BHB is not
> WAF-walled, so it needs no browser/proxy: it reads the CompanyProfile Statements tab webapi
> (`GetCompanyFinancialStatements`, pure parser `ingestion/src/adapters/bhb/financials.ts`, back to 2016),
> downloads each statement PDF **direct**, and runs the SAME `extractToStatements` + `claude -p` path the
> Tadawul gap-fill uses — persisting `FILING.FINANCIALS` lake.objects at `source_rank 20` (BHB has no XBRL,
> so this is the PRIMARY source, not a gap-filler) through the same snake_case projection. This is the BHB
> arm of P1.7e and takes BHB off DEF-STMT-LLM-PDF (which now scopes MSX + F full-text via the
> `normalizeViaLlm` runtime seam only).

- TDWL/ADX: ~~**Mubasher `/financial-statements` + `/ratios`**~~ **(deprioritized 2026-07-16, owner
  "avoid Mubasher")** — kept as the golden-tested `normalizeMubasherStatements`/`normalizeMubasherRatios`
  normalizer path (content-poll on selector, **not networkidle**), not wired to a live source.
- DFM/QE: **Yahoo `fundamentals-timeseries`** (multi-year standardized) — **blocked on egress**;
  QE native HTML tables as the second source. **Effort: M once egress exists.**
- MSX: `msx.om` `.aspx` tables + **PDF-extraction pipeline** for depth. **Effort: M–L.**
- Map extracted line items → the **§3.1 primitive keys** in `financial_statements.line_items` for
  **≥8 trailing quarters**. **Effort: M** (the normalization/standardization is the real work, per
  `01-ingestion.md` §9 — an LLM-extraction job, not a scraper job).
- Ship the **`[NEW COL]` migration** + **`fn_recompute_key_ratios()`** SQL (sector-aware, §3.2–3.3),
  wire into `nightly_omnibus` at 02:00 GST. **Effort: M.**

### P1.7c — Marsad Score v1 (the flagship — pure math, zero cost)
**Value: highest** (product's reason to exist). **Feasibility: high** once 7a+7b land (V/P/M);
Growth follows statements; Revisions = `NULL`.
- Build `worker/agents/score.ts`: cohorts → winsorize → percentile → factor scores → composite →
  universe percentile → rating + grades → diff → `scores`/`score_history`/`score_events` +
  `COMPUTED.SCORE` lake objects. **Effort: L** (the core IP; but no external deps).
- Wire `score_batch` (already scheduled 04:00 GST) + the **freshness-gate abort**. **Effort: S.**
- Event trigger on `earnings_events.verdict` → single-name recompute. **Effort: S.**
- Seed `securities.score_eligible_from` in the listing job (90 trading days). **Effort: S.**
- Add `estimates_agg` cron at 23:00 GST (feeds Revisions when a source lands; harmless while empty).

### P1.7d — Filings upgrade + dividends + earnings actuals (mostly free from the corpus)
**Value: high** (Filings tab, dividend card/calendar, earnings verdicts, Revisions groundwork).
**Feasibility: high** (filings already listed; this is enrichment of existing rows).
- **F upgrade:** `full_text` extraction (PDF→EN) → `extracted_facts` typing → `ai_summary` (LLM).
  **Effort: M** (LLM cost is per-filing, bounded; this is the one LLM cost in the plan).
- **H dividends:** parse DIVIDEND filings' `extracted_facts` → `dividends` (+ Mubasher
  `/corporate-action` for TDWL/ADX); wire the `pending_confirm → live` human gate. **Effort: S–M.**
- **G earnings actuals:** parse results filings → `earnings_events` (`eps_actual`, `revenue_actual`,
  `verdict`, `surprise_pct`, `rvc_table`). **Effort: M.** Consensus stays sparse (OQ-10).

### P1.7e — Exchange-native deep + ownership + people (fills gaps, elevates)
**Value: medium–high** (Ownership tab, board/people, ADX/MSX depth, BHB when unblocked).
**Feasibility: mixed** (ADX clean; MSX PDF-heavy; BHB proxy-gated).
- **ADX native** `financial-reports.json`/`overview.json` as ADX's authoritative source +
  cross-check vs Mubasher. **Effort: M.**
- **J ownership:** Mubasher `/major-shareholders` (TDWL/ADX) + venue/registrar disclosures + >5%
  filings → `ownership_snapshots`/`holders`/`holder_positions` (quarterly, low volume). **Effort: M.**
- **I identity (sector/isin/shares) — persist ✅ DONE 2026-07-16 (DEF-SECTOR-DATA):** the
  source-agnostic `PROFILE.SECURITY` → `public.securities` projection (`lake.fn_security_profile_project`,
  migration `20260716123154`) fills `sector`/`isin`/`shares_outstanding` — the binding constraint on live
  PE/PB + the Score. Sector maps onto `public.sectors.key` (a FK; the §3.3 vocabulary) via the
  golden-tested `sector-taxonomy.ts` (unmappable → `'unknown'` LOGGED). Config-driven producers
  (`securities_profile` data_type; coverage guard `profile_scraped_at`, chunk-25, self-chain 180 min):
  TDWL (Mubasher `/profile`, provider `mubasher_profile`), ADX (native `overview.json`), MSX (native) —
  ≈548/693 (79%); DFM/QE/BHB are §7 sub-rows. **Seeded `active=false` pending a VPS field-map capture.**
- **I people:** **create `company_people`** + scrape board/management (venue profile pages / filings).
  **Effort: M.**
- **BHB egress:** stand up a GCC/residential proxy (or GitHub-Actions egress) → attempt BHB price +
  fundamentals; else surface BHB as the honest coverage-gap venue. **Effort: L**, **do NOT block P2.**
- **AI profile prose / pros-cons** (I) over the filings corpus. **Effort: M** (LLM, bounded).

### Cross-cutting blockers (resolve early, they gate multiple sub-phases)
1. **Yahoo egress (blocker #1)** — residential/rotating IP or proxy. Gates **DFM + QE** price *and*
   fundamentals (P1.7a + P1.7b). Without it, two venues have no fundamentals at all. **Effort: M.**
2. **BHB egress** — proxy for the IP-block. Gates **all** BHB data. **Effort: L**, lowest ROI.
3. **`company_people` table** — create before I. **Effort: S.**
4. **PDF-extraction pipeline** — needed for MSX/BHB depth + F full-text + statement backfill.
   Per `01-ingestion.md` §9 this is an **LLM-extraction service** (the real effort sinks here, not in
   fetching). **Effort: L**, but shared across F/D/MSX.

### What MUST exist before P2 vs what enriches in parallel

| MUST exist before P2 stock pages are credible | Can enrich in parallel / trail P2 |
|---|---|
| `ohlcv_daily` (≥126 bars) — P1.7a | ADX-native cross-check depth (P1.7e) |
| `financial_statements` ≥8Q + `key_ratios` — P1.7b | BHB statements — now produced by the direct-HTTP `bhb-financials.mjs` researcher (2026-07-16; NOT proxy-gated), drain pending VPS deploy |
| **Marsad Score v1** (V/P/M; Growth where available) — P1.7c | Transcripts (N), IPO (O), AI thesis (P) |
| Filing `full_text`+`extracted_facts`+`ai_summary` — P1.7d | Analyst-maintained `datapoint_series` (L) |
| `dividends` (from filings) — P1.7d | Street consensus PT strip (K, blocked) |
| `securities` identity (+`shares_outstanding`) | Revisions factor (blocked on consensus source) |
| `ownership_snapshots` + `company_people` — P1.7e | Full 10y statement backfill (8Q is the floor) |

---

## 5. Owner decisions (ex-HF PM sign-off)

**Methodology (the forks where a PM's judgment should override a default):**
- **D-1 · Sector-conditional ratio validity** — banks/insurers use P/B+ROE+NIM, **not** EV/EBITDA.
  GCC is bank-heavy; getting this wrong is the fastest credibility loss. *Recommend: adopt as spec'd.*
- **D-2 · GCC-wide sector cohorts** (Saudi + Qatari bank in one "Banks" cohort) — the platform's
  whole thesis. *Recommend GCC-wide; confirm comfort comparing across pegs/liquidity regimes.*
- **D-3 · Factor weights** 25/20/20/20/15 (Value-tilted, Revisions-light). *Config-driven; needs his number.*
- **D-4 · Rating bands** = fixed percentile quintiles (≈162 each). *May prefer asymmetric (scarcer BUY/SELL).*
- **D-5 · Min coverage to publish** = ≥3 of 5 factors, factor needs ≥50% weight non-null. *Sets risk appetite for scoring sparse names.*
- **D-6 · Dividend/split-adjusted momentum** — non-negotiable for correctness; highest-effort input. *Recommend mandatory for v1.*
- **D-7 · No EPS one-off normalization in v1** — accept transient distortion, winsorization mitigates. *Acknowledge as known limitation.*
- **D-8 · Revisions ships `NULL` at launch** — don't gate the flagship on an unsourced consensus feed. *Recommend yes.*
- **D-9 · Winsorize at 2/98** · **D-10 · Percentile over z-score** (matches "84th pct" design, distribution-free). *Recommend as stated; a quant PM may have a z-score/rank-IC preference worth 5 min.*

**Sourcing / build tradeoffs (authoritative-exchange vs aggregator):**
- **D-src-1 · Per-venue verification tier** — accept `VERIFIED` only for TDWL/ADX (+DFM/QE once
  Yahoo egress lands), `SINGLE_SOURCE` for MSX/BHB, surfaced honestly on the reader — rather than
  blocking a venue on an unreachable second source.
- **D-src-2 · Aggregator-first vs exchange-native** — for TDWL/DFM/QE use the aggregator (Mubasher/
  Yahoo) as primary and exchange-native only as cross-check/backfill (cheaper, already reachable);
  for **ADX/MSX/BHB exchange-native is the only path**. *Recommend this split.*
- **D-src-3 · Fund Yahoo egress** (residential/rotating IP, blocker #1) — a real recurring cost, but
  it is the **only** fundamentals+history source for DFM+QE. *Recommend fund it; it unblocks 2 of 6 venues.*
- **D-src-4 · BHB price-history scope** — **DECIDED 2026-07-14: accept BHB as the coverage-gap venue.
  SUPERSEDED 2026-07-15: the revisit trigger fired — a BHB-reachable proxy now exists, so the backfill
  was built.** The 2026-07-14 decision to build NO backfill was conditioned on there being no cheap ≥2y
  source and no reachable proxy path. That condition is lifted: a **sticky IPRoyal session** reaches BHB's
  OWN webapi `GetTabularDataWithDateRangeFilter?storedProcdure=DataExportCompanyProfile` — a per-security
  price export that returns the **full EOD-close history** in one GET (proven live 2026-07-15 via sticky
  proxy: GFH 2020→2026 = 1476 rows; the year dropdown offers 2000..current → `FromDateYear=2000` for full
  history; `scratchpad/BHB-API-CONTRACT.md` §2). This is a first-class BHB endpoint (no aggregator, no
  Mubasher CSV needed) and supersedes both the retired Daily-Trading-Summary XLSX path AND the
  "no backfill" scope. Built `adapters/bhb/ohlcv.ts` (provider `bhb_webapi`, routed by
  `runtime.tasksForProvider` + `withBhbWebapiSymbols`, seed `20260715101500`), mirroring the ADX (0033)
  and MSX (0034) adapter shape. **EOD CLOSE ONLY** (the export carries date+close only; the adapter emits
  open/high/low/volume as NULL — explicit owner requirement, does NOT fabricate OHLC). Seeded
  `active=false`; activation is a deliberate later flip (a 41-symbol deep drain over the sticky proxy is
  not auto-run). The wired EOD accrual (0028) still builds `ohlcv_daily` forward once BHB quotes flow, and
  the backfill's `OHLCV.CLOSE:BHB:{ticker}:{date}` bars cross-check against it. **DEF-BHB-OHLCV closed**
  (BUILD-STATUS §7). Does not block P2.
- **D-src-5 · Consensus-estimate source (OQ-10)** — the Revisions factor + the "14 ratings/avg PT"
  strip need a street-consensus source. Options: scrape Mubasher `/fair-values` (analyst *targets*,
  TDWL/ADX only, not EPS-revision breadth) / license a feed / accept **Marsad-internal estimates
  only**. *Owner call; until resolved, Revisions = `NULL` and the PT strip is sparse.*
- **D-src-6 · Statement depth floor** — 8 quarters + 3–5 annual as the credible floor vs full 10y
  backfill (more scraping/PDF work). *Recommend 8Q floor for P2, backfill depth as enrichment.*

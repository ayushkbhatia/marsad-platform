# P17 financials — build log + live findings (2026-07-14)

Running log of what was built, proven, and the real limits found while building the PDF-first
financials pipeline (`p17-financials-pdf-architecture.md`). Kept so the next session starts from truth,
not optimism.

## Proven live (real data)
- **Validation gate + extraction contract** (`ingestion/src/lake/statement-extraction.ts`, 9/9 tests):
  passes real SABIC, rejects every Mubasher failure mode. `177bb81`.
- **Projection** `lake.fn_financials_project` (migration 0042, `04d1ef9`): FILING.FINANCIALS objects →
  `public.financial_statements`. Proven live with real SABIC Q1-2026 (balance-sheet identity holds).
- **Argaam discovery parser** (`ingestion/src/adapters/argaam/discover.ts`, 5/5, `47f10bc`).
- **LLM extraction** via Anthropic `claude-haiku-4-5` (the `summarizer` role's cheapest target): extracts
  clean §3.1 primitives from real born-digital PDFs, ~1¢/statement (~10k in / ~0.4k out tokens). Key is in
  `/etc/marsad/worker.env` (root:0600 — load via sudo/systemd, not a `deploy`-user `source`).
- **`financial_statements → key_ratios` chain**: live (scoped recompute writes the row; `currency_computed`
  comes from the statement, momentum from `ohlcv_daily`).

## TWO REAL LIMITS FOUND (must resolve before auto-population / ratios)

### L1 — Extraction quality needs prompt/model work (haiku ~half-clean)
Batch of 9 TASI companies (Q1-2026), live:
- Clean: MAADEN, NADEC (correctly detected `units` scale, not thousands), STC/ALMARAI (partial).
- **Wrong line picked**: SABIC `equity` = 123.9B (attributable-to-parent) instead of 149.1B (total incl.
  minority) → breaks `assets = liabilities + equity` → the gate REJECTS it (correctly). `net_income` grabs a
  statement-of-changes-in-equity component (13,195) instead of the income-statement total (284,091).
- **Banks fail**: ALRAJHI returns null revenue — a bank reports "total operating income", not "revenue";
  the prompt must map bank line items (§3.1 note: banks → `total_operating_income`).
- **Some PDFs null-out** (JARIR, EXTRA) — harder layouts; haiku misses them.
FIX: sharpen `EXTRACTION_SYSTEM` (explicit: total equity incl. minority for the identity; parent net income
from the income-statement bottom line; bank line-item mapping), and/or route extraction to `sonnet` for
reliability (raise cost from ~1¢ to ~5-10¢/statement — still bounded, per-new-filing). Re-validate against a
labelled set (SABIC/MAADEN/ALRAJHI/a bank) before turning on auto-population. The validation gate makes this
safe — a mis-extraction is rejected to Desk review, never silently stored.

### L2 — Free-tier data is CURRENT-PERIOD ONLY; 5y history is gated
- Argaam free index (`/en/company/financial-pdf/{market}/{year}`) exposes only each company's **latest**
  statement; the per-company financial-reports HISTORY page is **subscription-paywalled**
  (`subscription-page-lowest-package?blockPageID=517`). Verified live.
- SABIC IR API (`sabic.com/en/reportsearch/getreports`) returns **stale 2016-2017** data.
- => TTM-based profitability ratios (net_margin/ROE/gross_margin) — which need ≥4 quarters or an annual —
  **cannot be produced from free sources today**. The ratio engine correctly refuses to fabricate a TTM from
  one quarter (proven: SABIC single-quarter → profitability ratios null, momentum/currency present).
PATHS TO DEPTH (owner decision):
  1. **Proxy egress → Tadawul official** (`saudiexchange.sa/Resources/fsPdf/…`, authoritative, EN+AR, full
     5y). The real unlock (D-src-3). Akamai-IP-blocks the VPS today.
  2. **Argaam subscription** — unlocks the per-company history pages (paid).
  3. **Quarter accrual** — run the free current-period extraction weekly; TTM emerges naturally after ~4
     quarters. Zero extra cost, but ~1 year to full ratio coverage.

## Remaining build (all unblocked, no unknowns) — the productionized pipeline
- Worker→LLM gateway build wiring (worker is a separate compiled package; `src/lib/llm` is portable — vendor
  into `ingestion` or add a build path). Gives cost-accounting + provider fallbacks vs the direct fetch used
  in the batch tool.
- Argaam headless acquisition as a `BrowserClient` task on the VPS (index render → S3 download → snapshot →
  store to the public `filings` bucket = the downloadable-PDF feature).
- The orchestrator handler: enumerate → download → pdftotext → gateway extract (sharpened prompt) → gate →
  FILING.FINANCIALS → projection. Seed source + weekly cron (incremental via uuid list-diff).
- Once depth lands (proxy/subscription/accrual): real ROE/margins → multi-factor Score.

## BREAKTHROUGH 2026-07-15 — Akamai (Tadawul) CRACKED + Yahoo unblocked via proxy

Owner supplied an IPRoyal residential proxy (GCC geo `ae,sa`). Two unlocks:

### Yahoo fundamentals via proxy (clean multi-year DATA — no PDF, no LLM)
`fundamentals-timeseries` for `.SR/.AE/.QA` returns **5 years of standardized annual statements in actual
currency units**, and the committed `normalizeYahooTimeseries` maps them straight to §3.1 primitives.
Verified live for SABIC (2010.SR): revenue/net-income/assets/equity/gross/EPS/ebit/debt/cash/dep-amort/
current-liabilities for FY2022–FY2025, `capital_employed` derived. This is the fastest path to real
ratios (net_margin/ROE/growth/CAGR) — but it's DATA only, no source PDF to own. `shares_outstanding`
needs Yahoo's crumb flow (401 without it) — solvable. Proxy egress = IPRoyal, per migration 0027 pattern.

### Tadawul Akamai Bot Manager — BEATEN (the authoritative PDF source)
`saudiexchange.sa` 403s plain curl AND headless Chromium even through the residential proxy (Akamai edge-
denies before setting `_abck`). The combination that WORKS (verified: `200`, full 914KB announcements page
rendered):
- **Headful Chromium** (`headless:false`) under **`xvfb-run`** on the VPS (headless tells fail Akamai).
- **Sticky residential GCC IP**: IPRoyal password `…_country-ae,sa_session-<id>_lifetime-30m` — the SAME
  IP for the whole session (Akamai `_abck` is IP+session-locked; rotating-per-request fails).
- **geoip-aligned context**: `timezoneId:'Asia/Riyadh'`, `locale:'en-US'`, real Chrome UA, +
  `--disable-blink-features=AutomationControlled`, `navigator.webdriver=undefined`.
- **Warm then navigate** same session: goto homepage (`domcontentloaded`, 80s, RETRY 3×), let the sensor
  run, then the target. Residential exits vary in latency → retries + fresh-session IP rotation on failure
  are mandatory.
This matches the deep-research verdict (`waavxrqar`): seleniumbase-UC / camoufox + geoip residential +
same-IP warming. For heavier scale, camoufox (Firefox-engine, C++-level fingerprint patches, article-
proven 200 vs Akamai) is the upgrade; a commercial Web Unlocker only if intraday-at-scale.

**Remaining to own the Tadawul PDFs (unblocked):** navigate the issuer-announcements portlet → filter to
Financial Statements → follow each announcement's detail portlet-link → the `/Resources/fsPdf/{id}_{lang}.pdf`
→ download (warmed session) → store to the `filings` bucket → the built extraction pipeline (pdftotext →
LLM → validation gate → `fn_financials_project`). This gives BOTH the owned PDF archive AND the extracted
data — the owner's actual goal. Productionize as a `BrowserClient` headful task with retry + IP rotation.

## Ledger
`DEF-WORKER-LLM-KEY` (RESOLVED — key added), `DEF-STMT-INGEST` (pipeline built; depth-gated per L2),
`DEF-SHARES-OUTSTANDING`, `D-src-3` proxy (the L2 unlock).

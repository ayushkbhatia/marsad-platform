# P1 Ingestion — live reconnaissance findings (2026-07-13)

Probed the six venue sites from the build sandbox (datacenter IP) + real Chromium (Playwright).
These are ground-truth inputs for the adapter builders. Endpoints rotate — treat every URL/action id
as `ingest.sources` config data, never hardcode.

## Reachability matrix

| Venue | curl (HTTP) | Real Chromium | Strategy |
|---|---|---|---|
| **TDWL** (saudiexchange.sa) | **403** Akamai WAF | **200 OK** | Playwright request-context: load page to seat Akamai/session cookies, then fetch AJAX JSON endpoint |
| **ADX** (adx.ae) | **403** WAF (even Googlebot UA) | assume OK (same class as TDWL) | Playwright request-context |
| **DFM** (dfm.ae) | 200 (after redirect to www.dfm.ae) | OK | Plain HTTP; find market-data endpoint |
| **QE** (qe.com.qa) | 200 (~350KB) | OK | Plain HTTP; endpoints `MarketWatch.txt`, `api/data-set`. reCAPTCHA on some flows |
| **MSX** (msx.om) | 200 (~175KB) | OK | Plain HTTP; ticker via `.aspx` endpoints. reCAPTCHA (`api.js?render=6Lf…`) on some paths |
| **BHB** (bahrainbourse.com) | 200 (redirect → bahrainbourse.com/en) | OK | Plain HTTP |

Key insight: the block on TDWL/ADX is **HTTP-client fingerprint + IP**, not purely IP — a real Chromium
fingerprint loads TDWL even from this datacenter IP. So the VPS must run **headless Chromium (Playwright)**
for the two WAF venues; the other four use cheap plain HTTP. This matches 01-ingestion.md's "Playwright
request-context for WAF venues" decision — now confirmed necessary, not optional.

## TDWL — confirmed working data path (highest-value find)

1. Playwright navigates `https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch`
   (seats Akamai `_abck`/`bm_sz` cookies + boomerang; reCAPTCHA present but does NOT gate the data load).
2. The datatable then XHRs a WPS-portal action. Observed URL form (the long `!ut/p/z1/…` PUID and the
   `NJgetMainNomucMarketDetails` action id are portal-generated — **scrape them from the page's datatable
   ajax config at runtime, do not hardcode**):
   `…/main-market-watch/!ut/p/z1/<PUID>=…=NJgetMainNomucMarketDetails=/?sectorParameter=&tableViewParameter=1&iswatchListSelected=NO&requestLocale=en&_=<epoch_ms>`
3. Response: **clean JSON**, `content-type: text/html` (parse anyway), ~625KB, whole main market:
   ```json
   {"data":[{"sectorName":"Energy","sectorRef":"31","companyRef":2030,"acrynomName":"SARCO",
     "transactionDate":"Jul 13, 2026 3:18:51 PM","lastTradePrice":51.5,"lastTradePriceModified":"51.50",
     "lastTradeQuantity":50,"lastUpdatetime":"Jul 13, 2026 4:00:00 PM",
     "askPrice":51.5,"askQuantity":745,"bidPrice":51.4, …}]}
   ```
   Fields available: sector, companyRef (numeric ticker), acrynomName, last trade price/qty/time, bid/ask
   price+qty, timestamps. This is a full delayed quote per security in one call — snapshot this raw JSON,
   parse to `quotes_latest`/`quotes_intraday`. Nomu (parallel market) is a sibling action.

## Endpoints to discover during build (per venue, save as `ingest.sources` rows)
- **TDWL**: main-market-watch action (above) + Nomu variant + issuer-news/announcements list (filings T+9min path) + company detail pages.
- **QE**: resolve `MarketWatch.txt` and `api/data-set` payload shapes; disclosures/announcements feed.
- **MSX**: ticker `.aspx` data endpoint; company disclosures.
- **DFM / ADX / BHB**: locate the market-watch/quotes JSON or table endpoint + disclosures feed.

## Snapshot-first mandate
Every fetch stores the raw bytes (hash-addressed) to `ingest.raw_snapshots` (+ Storage `lake-raw` bucket for
large blobs) BEFORE parsing, so parsers are pure and replayable against captured fixtures. Capture ≥1 real
fixture per venue into `ingestion/fixtures/<venue>/` for golden tests — the 4 HTTP venues can be captured in
the build sandbox now; TDWL/ADX fixtures come from the Playwright path (one TDWL market JSON already captured
in this session's recon and should be saved as the first golden).

## Cost note
Headless Chromium on the CX22 (2 vCPU/4 GB) for 2 WAF venues a few times per trading day is within budget;
the 4 HTTP venues are near-free. Keep request budget ≤ 300/day/host (01 §exit criteria).

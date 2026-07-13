# TDWL (Saudi Exchange / Tadawul) — fixture capture notes

**Why there is no verbatim quotes fixture in this directory.** `saudiexchange.sa` is behind an
Akamai WAF that returns **403 to any plain HTTP client** (curl/undici) regardless of User-Agent —
confirmed in `docs/architecture/P1-recon-findings.md`. It loads under a **real headless Chromium**
even from a datacenter IP, because the block keys on the HTTP-client TLS/JA3 fingerprint + IP, not
IP alone. So the golden fixture for TDWL is captured on the VPS during the first Playwright run,
not from this sandbox. Until then, `market-details.sample.json` in this folder is the response
*shape* (2 hand-built rows) the parser codes against.

## Capture path (Playwright request-context — `transport = 'http_bootstrap'`)

Per `01-ingestion.md` §2.1/§3.3 and the recon doc. The adapter's `fetchQuotes(ctx)` uses
`ctx.browser` (BrowserClient), NOT `ctx.http`:

1. **Seat cookies.** Navigate a Chromium page to the market-watch entry page:
   `https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch`
   This seats Akamai `_abck` / `bm_sz` cookies + the boomerang beacon. A reCAPTCHA widget is
   present on the page but does **not** gate the data XHR.
2. **Scrape the action URL at runtime.** The datatable's AJAX config on the page carries the
   portal-generated PUID and the `NJgetMainNomucMarketDetails` action id inside a
   `!ut/p/z1/<PUID>=…` path. **Read it from the page DOM/JS at runtime — never hardcode it.**
   Observed form:
   ```
   …/main-market-watch/!ut/p/z1/<PUID>=…=NJgetMainNomucMarketDetails=/?sectorParameter=&tableViewParameter=1&iswatchListSelected=NO&requestLocale=en&_=<epoch_ms>
   ```
3. **Fetch the JSON through the same browser context** (`context.request.get(url)`) so the request
   carries the same fingerprint that earned the cookies (undici replay re-challenges under
   Incapsula/Akamai — see `01-ingestion.md` Revisions #3). Response is ~625 KB, clean JSON, but
   `content-type: text/html` — parse anyway.
4. **Snapshot-first.** Store the raw JSON bytes verbatim to `ingest.raw_snapshots` (via
   `SnapshotStore.put`) BEFORE parsing. Save the first successful capture back into this folder as
   `market-details.golden.json` so the parser has a real replayable golden.

## Response shape → `NormalizedQuote` mapping

See `market-details.sample.json`. Top level `{ "data": [ { … per security … } ] }`. Field map
(exact names are in the sample):

| Source field | NormalizedQuote field | Notes |
|---|---|---|
| `acrynomName` | `ticker` (resolve → `security_id`) | e.g. `SARCO`; `companyRef` (numeric, e.g. 2030) is the alt key |
| `lastTradePrice` | `last` | |
| `change` / `changePercent` | `change` / `changePct` | |
| `openingPrice` / `highPrice` / `lowPrice` | `open` / `high` / `low` | |
| `previousClosePrice` | `prevClose` | |
| `volumeTraded` | `volume` | |
| `bidPrice` / `askPrice` | `bid` / `ask` | order-book top; not persisted to quotes_latest but kept in payload |
| `transactionDate` / `lastUpdatetime` | `asOf` | exchange delayed print time (AST = UTC+3); parse to timestamptz UTC |
| `sectorName` / `sectorRef` | (reference; not a quote field) | |

## Other TDWL sources (config rows, discovered on the VPS)

- **Nomu (parallel market):** sibling action to `NJgetMainNomucMarketDetails` — separate
  `ingest.sources` row, same parser.
- **Indices (TASI + sector):** indices page under `ourmarkets`, same bootstrap transport.
- **Filings / issuer-news** (the T+9-min SLA path): paginated JSON list at
  `saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news`, announcement IDs like
  `CG-1-2026-4471`; each detail item → its own `filing_detail` snapshot + attached EN PDF.
- **EOD market-report XLSX bulletins:** the daily source of record for `ohlcv_daily`.

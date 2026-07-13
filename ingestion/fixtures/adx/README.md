# ADX (Abu Dhabi Securities Exchange) — fixture capture notes

**Why there is no verbatim quotes fixture in this directory.** `adx.ae` is WAF-fronted and returns
**403 to plain HTTP** — even with a Googlebot UA — per `docs/architecture/P1-recon-findings.md`.
Same class as TDWL: a real headless Chromium fingerprint is required. The golden fixture is
captured on the VPS during the first Playwright run, not from this build sandbox. ADX also trades
**Mon–Fri** (UAE weekend Sat–Sun since Jan 2022) — its `market.venues.trading_days` differs from
the Sun–Thu venues; nothing may assume Sun–Thu.

## Capture path (Playwright request-context — `transport = 'http_bootstrap'`)

Identical mechanism to TDWL (see `../tdwl/README.md`), differing only in URLs, which are
**discovered on the VPS and stored in `ingest.sources.endpoint_config`, never hardcoded**:

1. **Seat cookies** by navigating a Chromium page to the ADX market-watch page under `adx.ae`.
2. **Discover the market-data XHR** the SPA fires (ADX serves the full board as JSON from its own
   JSON services host — the recon doc did not pin the exact path because it needs a real browser
   session to observe; capture it from the Network panel / `page.on('response')` during the first
   run and record it as the `quotes` source row).
3. **Fetch through the same browser context** (`context.request.get(...)`) to preserve the
   fingerprint that earned the cookies.
4. **Snapshot-first:** store raw bytes to `ingest.raw_snapshots` before parsing. Save the first
   successful capture here as `market-watch.golden.json` for replayable golden tests.

## Expected shape → `NormalizedQuote`

ADX's board JSON is expected to resemble DFM's (both are SPA-over-JSON venues). The parser maps
whatever field names ADX emits (last / change / changePct / open / high / low / prevClose /
volume / bid / ask / exchange-timestamp) onto `NormalizedQuote`. Because the exact field names are
unknown until the first VPS capture, the ADX `parseQuotes` is written against the golden captured
in step 4 — do not guess field names from this note.

## Other ADX sources (config rows, discovered on the VPS)

- **Index (FADGI):** same market-data services, `indices` source row.
- **Disclosures:** ADX news & disclosures JSON list + PDFs → `filings_list` / `filing_detail`.
- **IPO pipeline:** ADX has the region's busiest listing pipeline; the daily IPO sweep runs here.
- **EOD daily trading report:** the `eod_bulletin` source of record for `ohlcv_daily`.

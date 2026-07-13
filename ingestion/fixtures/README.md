# Venue fixtures — provenance

Real, verbatim venue responses captured 2026-07-13 from the build sandbox (datacenter IP) with a
Chrome desktop User-Agent and `curl -L`. These are the golden inputs for the pure `parse*`
functions defined in `../CONTRACT.md` (§adapters). Parsers must be replayable against these bytes
with zero network access. **URLs rotate** — the paths below are recorded for provenance only; the
live paths are config in `ingest.sources`, never hardcoded in adapter code.

| File | Venue | Source URL (as fetched) | Transport | HTTP | Notes |
|---|---|---|---|---|---|
| `qe/marketwatch.txt` | QE | `https://www.qe.com.qa/pps/qse_files/MarketWatch.txt` | http | 200 | **Clean JSON**, 132 KB, full board (`rows[]` with Symbol, LastPrice, Bid/Offer, High/Low, Volume, PERatio, EPS, Yield, sector). The QE quotes golden. Real path discovered from the homepage JS (`/pps/qse_files/MarketWatch.txt`); the `MarketWatch.txt` root path in the recon doc now 404s. |
| `qe/homepage.html` | QE | `https://www.qe.com.qa/` | http | 200 | SPA of record; carries the `MarketWatch.txt` + `/frontend-js-api/data-set` route references. |
| `dfm/marketwatch.html` | DFM | `https://marketwatch.dfm.ae/en` | http_bootstrap | 200 | Market-watch SPA shell (70 KB). Data comes from `api2.dfm.ae` (`/mw/v1` market watch, `/efsah/v1` disclosures) — hosts confirmed live (JSON 404 on guessed routes ⇒ API exists, exact route is portal-generated). Pin the real `/mw/v1/...` path from the SPA bundle on the VPS. |
| `dfm/market.html` | DFM | `https://www.dfm.ae/` | http_bootstrap | 200 | Main site homepage; source of the `api2.dfm.ae` host discovery. |
| `msx/snapshot-BKMB.html` | MSX | `https://www.msx.om/snapshot.aspx?s=BKMB` | http | 200 | Per-security snapshot page (365 KB) — the `.aspx` ticker endpoint the recon doc flagged. Per-symbol; the board is assembled by iterating symbols or the market-watch page. |
| `msx/ticker.html` | MSX | `https://www.msx.om/` | http | 200 | Homepage; exposes `snapshot.aspx?s=<SYM>` and `/Ticker.js`. reCAPTCHA present on some flows (does not gate snapshot.aspx). |
| `msx/ticker.js` | MSX | `https://www.msx.om/Ticker.js` | http | 200 | Ticker widget page (server-rendered .aspx served as ticker data source). |
| `bhb/market.html` | BHB | `https://bahrainbourse.com/en` | http | 200 | Homepage (195 KB). Exposes `webapi.bahrainbourse.com/api/...` (JSON host, confirmed live) + `/MarketWatch/...` and `/Stocks/Pages/Daily-Trading-Summary.aspx` (the EOD bulletin route). Pin the exact `webapi` market route from the SPA bundle on the VPS. |
| `tdwl/market-details.sample.json` | TDWL | *(not fetched — WAF 403 to curl)* | http_bootstrap (Playwright) | — | Response **shape sample** (2 hand-built rows) from the recon capture. Real golden captured on VPS via Playwright — see `tdwl/README.md`. |
| `tdwl/README.md` | TDWL | — | — | — | Playwright request-context capture path + field map. |
| `adx/README.md` | ADX | — | — | — | Playwright request-context capture path (endpoint discovered on VPS). |

## Capture command (reproduce)

```sh
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
curl -sSL -A "$UA" -H 'Referer: https://www.qe.com.qa/' 'https://www.qe.com.qa/pps/qse_files/MarketWatch.txt' -o qe/marketwatch.txt
# …see fixtures README table for each URL
```

TDWL and ADX cannot be captured this way (WAF 403); their goldens land on the VPS Playwright run.

-- 20260726171637 — deactivate the dead BHB eod_bulletin source (ingest.sources id 18).
--
-- This source never worked and is redundant; it is not a regression:
--   * 20260713000017_ingest_sources.sql:285-292 seeded both entry_url and endpoint_config.urlTemplate
--     to the human summary page https://www.bahrainbourse.com/en/Stocks/Pages/Daily-Trading-Summary.aspx
--     with `TODO(vps): pin the XLSX download link off the summary page`. It was never pinned; the page
--     now 404s (first failure 2026-07-20 10:20 UTC, repeating every eod_sweep tick).
--   * Even a 200 would yield nothing: decodeWorkbook (ingestion/src/adapters/bhb/eod.ts:93-108) has no
--     caller, and parseEod (:137-145) reads snapshot.meta['sheetRows'], which nothing ever sets.
--   * It is redundant: BHB OHLCV is 41/41 covered via webapi.bahrainbourse.com (adapters/bhb/ohlcv.ts,
--     source id 30) — the same host every working BHB adapter uses via bhbWebapiGet. eod.ts is the only
--     BHB adapter still pointed at the (404ing) www host.
--
-- We do NOT re-pin the URL: the parse path would have to be built first, and the data is already
-- covered. If a real BHB EOD bulletin is ever wanted, build the adapter against a captured workbook,
-- then re-activate.

set search_path = '';

update ingest.sources
set active = false
where id = 18 and venue = 'BHB' and data_type = 'eod_bulletin';

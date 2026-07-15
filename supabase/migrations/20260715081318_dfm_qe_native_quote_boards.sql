-- DFM + QE native quote boards — stop quotes dying ~30 min into each session.
--
-- Root cause (2026-07-15): DFM native (id=4) network_capture pointed at the DEAD api2.dfm.ae/mw/v1
-- route → 0 fetches; QE native (id=10) direct GET of MarketWatch.txt intermittently exceeded the 20s
-- fetch timeout (origin spikes >15s) → 0 native snapshots. With both native boards down, quotes fell
-- to the Yahoo per-symbol sources (id 20/21), which exhaust the query1.finance.yahoo.com 300/day host
-- budget ~30 min after open → DFM froze 06:25, QE 06:53 (headline quotes_latest never advanced).
--
-- Fix: point each venue at its live native board (one cheap fetch = all symbols):
--   DFM → POST https://marketwatch.dfm.ae/dapi/fetch (plain HTTP, no WAF from the VPS IP; command
--         envelope body; returns [{data:[~473 securities]}] with lowercase keys). transport→http.
--   QE  → keep the MarketWatch.txt GET, raise timeoutMs to 25s so the slow origin doesn't drop.
-- Deactivate the Yahoo quote fallbacks (id 20/21): per-symbol Yahoo at a 10-min cadence is
-- fundamentally incompatible with the 300/day host budget; the native single-source quotes now
-- refresh in place (the QUOTE.LAST live-latest fix in lake cross-check). Adapter support for the POST
-- board + the raised timeout ships in ingestion/src/adapters/{dfm,qe}/quotes.ts + core/types.ts.

update ingest.sources
set transport = 'http',
    endpoint_config = jsonb_build_object(
      'method', 'POST',
      'urlTemplate', 'https://marketwatch.dfm.ae/dapi/fetch',
      'responseKind', 'json',
      'timeoutMs', 20000,
      'headers', jsonb_build_object(
        'Content-Type', 'application/json',
        'Accept', 'application/json, text/javascript, */*; q=0.01',
        'Referer', 'https://marketwatch.dfm.ae/en',
        'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      ),
      'body', '[{"id":"00000000-0000-4000-8000-000000000001","command":"stocks","data":[{"id":"lastrefreshtime","value":"0"},{"id":"id","value":""}]}]'
    )
where id = 4 and venue = 'DFM' and data_type = 'quotes';

update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{timeoutMs}', '25000'::jsonb)
where id = 10 and venue = 'QE' and data_type = 'quotes';

update ingest.sources
set active = false
where id in (20, 21) and data_type = 'quotes' and coalesce(endpoint_config->>'provider', '') = 'yahoo';

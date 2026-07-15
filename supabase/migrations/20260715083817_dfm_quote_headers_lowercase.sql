-- DFM quote board headers → lowercase keys (fixes a 400 from migration 20260715081318).
--
-- The fetcher seeds default request headers with LOWERCASE keys ('user-agent',
-- 'accept-encoding') then spreads endpoint_config.headers on top. 20260715081318 set
-- the DFM board headers with a CAPITALISED 'User-Agent' (+ 'Content-Type'), which is a
-- DISTINCT object key from the lowercase default — so undici sent TWO user-agent
-- headers (the default MarsadIngestBot AND the browser UA), and marketwatch.dfm.ae
-- /dapi/fetch rejected the duplicate with 400. Lowercase keys OVERRIDE the defaults
-- cleanly (one user-agent) → 200. General rule: endpoint_config.headers must use
-- lowercase keys to override fetcher defaults.

update ingest.sources
set endpoint_config = jsonb_set(
      endpoint_config, '{headers}',
      jsonb_build_object(
        'content-type', 'application/json',
        'accept', 'application/json, text/javascript, */*; q=0.01',
        'referer', 'https://marketwatch.dfm.ae/en',
        'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      ))
where id = 4 and venue = 'DFM' and data_type = 'quotes';

-- 0044_adx_quote_gateway_headers — the exact request headers the ADX apigateway board requires.
--
-- 0043 repointed ADX quotes to the direct board via the cookie-seated browser context, but the board
-- fetch still 401'd: the apigateway checks headers the page's own XHR sends, not just the WAF cookies.
-- Captured live from the board XHR (2026-07-15): the apikey header is `adx-gateway-apikey` (NOT the
-- `apikey` name the filings/news use — that is why a plain probe 403'd), plus `channel-id: OSS WEB`
-- and `referer: https://www.adx.ae/`. With these on endpoint_config.headers the browser-context fetch
-- returns 200. (Runtime fix in the same commit: mapQuote falls back to the snapshot fetch time when a
-- board row has no per-row asOf — the ADX board carries no print timestamp.)

update ingest.sources
set endpoint_config = jsonb_set(
      endpoint_config, '{headers}',
      jsonb_build_object(
        'Accept', 'application/json',
        'adx-gateway-apikey', '1863a94c-582b-46f9-b4f0-0d02c0cc5307',
        'channel-id', 'OSS WEB',
        'referer', 'https://www.adx.ae/'
      ))
where venue = 'ADX' and data_type = 'quotes';

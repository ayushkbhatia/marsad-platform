-- 0043_adx_quotes_direct_board — fix ADX quotes via the browser WAF-bypass (the TDWL/Akamai learning).
--
-- ADX blocks plain HTTP (curl/undici → 403, even via a residential UAE proxy) but a real headless
-- Chromium loads www.adx.ae, which seats the Akamai/bpm WAF cookies (www.adx.ae/api/bpm/get-cookie +
-- set-cookie); the apigateway board then returns 200 THROUGH that cookie-seated browser context.
-- Proven live from the VPS 2026-07-15: board = apigateway.adx.ae/adx/marketwatch/1.1/securityBoards/
-- mainMarket, 90 rows under response.results (companySymbol/last/previousClose/changePrice/change/…).
--
-- The old ADX quotes config used actionDiscovery.extract='network_capture' with responseUrlPattern
-- 'securityBoard/marketwatch' — which is NOT the real path (it is securityBoardS/mainMarket) and, even
-- with a matching pattern, the board XHR fires seconds after the bpm cookie flow so capturing it by
-- pattern was unreliable ("action discovery found no URL"). Switch to extract='direct' (bootstrap only
-- seats the cookies) + a PINNED urlTemplate that the adapter fetches through the same browser context —
-- exactly the shape ADX filings already use. The matching adapter change (prefer endpoint_config
-- .urlTemplate over the captured URL) + the real default fieldMap land in the same commit.

update ingest.sources
set endpoint_config = endpoint_config
  || jsonb_build_object(
       'urlTemplate', 'https://apigateway.adx.ae/adx/marketwatch/1.1/securityBoards/mainMarket',
       'headers', jsonb_build_object('Accept', 'application/json'),
       'actionDiscovery', jsonb_build_object(
         'extract', 'direct',
         'navigateUrl', 'https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx'
       )
     )
where venue = 'ADX' and data_type = 'quotes';

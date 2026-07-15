-- MSX quotes → the single-fetch MarketTicker board (kills the 68-per-symbol fan-out).
--
-- Was: transport http_bootstrap, snapshot.aspx?s={symbol} over a hardcoded 68-symbol universe →
-- 68 browser fetches/poll = 1156/day, which blew the www.msx.om 300/day host budget and drove the
-- bulk of MSX direct egress. The live market-watch board (behind market-watch-custom.aspx) is a
-- plain-HTTP POST to api.aspx/MarketTicker (ASP.NET ScriptService: application/json, body
-- {"Sector":""} = all sectors) returning {"d":[ {Symbol,LTP,Change%,ClosePrice,…} ]} for ~63
-- main-market securities in ONE request — no reCAPTCHA, no browser. Verified via plain curl (200,
-- 17KB, 1.8s). OHLC/volume are not on this board — those come from the Summary-Report OHLCV export.
-- Adapter (adapters/msx/quotes.ts) selects the board on method=POST and derives change/prev-close
-- from last + the % move; the snapshot.aspx fan-out remains a fallback for board outage.

update ingest.sources
set transport = 'http',
    endpoint_config = jsonb_build_object(
      'method', 'POST',
      'urlTemplate', 'https://www.msx.om/api.aspx/MarketTicker',
      'responseKind', 'json',
      'timeoutMs', 20000,
      'headers', jsonb_build_object(
        'content-type', 'application/json; charset=UTF-8',
        'x-requested-with', 'XMLHttpRequest',
        'accept', 'application/json, text/javascript, */*; q=0.01',
        'referer', 'https://www.msx.om/market-watch-custom.aspx',
        'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      ),
      'body', '{"Sector":""}'
    )
where id = 13 and venue = 'MSX' and data_type = 'quotes';

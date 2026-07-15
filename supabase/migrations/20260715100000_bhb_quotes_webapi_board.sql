-- BHB quotes (id16) — point at the real Bahrain Bourse webapi board + re-activate.
--
-- Proven live 2026-07-15 (sticky proxy): the whole 41-stock board is ONE JSON call
--   GET https://webapi.bahrainbourse.com/api/data/GetTabularData?storedProcdure=Quotes
-- returning {status:1,data:[{symbol,"Last Price",OPENING,High,Low,VOLUME,Change,Bid,Ask},…]}
-- → live last (10-min cron) + daily OHLCV. The parser (adapters/bhb/quotes.ts) handles
-- these exact keys (space-padded `symbol`, spaced/upper `Last Price`/`OPENING`/`VOLUME`);
-- unit-tested against the real shape.
--
-- The webapi host is behind Cloudflare and BHB's datacenter IP is geo-blocked, so:
--   use_proxy=true + proxy_mode='sticky' — a fresh residential IP per poll passes CF;
--   the rotating pool trips "Attention Required". (Consistent with the proxy-egress
--   policy: BHB genuinely cannot be reached direct.) transport='http' (plain GET, no
--   bootstrap/discovery). Authorization carries the PUBLIC client APIKey shipped in the
--   page JS (not a server secret).
--
-- Was paused 2026-07-15 (broken parser produced 0 rows); this fixes + re-activates it.
-- Apply AFTER the worker carrying the parser fix is deployed, else the old parser stages
-- rows with a null last price.

update ingest.sources
set transport = 'http',
    active = true,
    endpoint_config = jsonb_build_object(
      'provider', 'bhb_webapi',
      'method', 'GET',
      'urlTemplate', 'https://webapi.bahrainbourse.com/api/data/GetTabularData?storedProcdure=Quotes',
      'responseKind', 'json',
      'timeoutMs', 45000,
      'use_proxy', true,
      'proxy_mode', 'sticky',
      'headers', jsonb_build_object(
        'Authorization', 'Bearer 49d257cf9ae44e959eabff6d366bdbe4cb03f2efd3f14e1fbb8456d8aba26ab5',
        'Accept', 'application/json',
        'Referer', 'https://bahrainbourse.com/',
        'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      )
    )
where id = 16 and venue = 'BHB' and data_type = 'quotes';

update ingest.schedules set active = true where source_id = 16;

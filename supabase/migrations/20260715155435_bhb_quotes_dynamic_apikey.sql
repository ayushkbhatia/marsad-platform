-- BHB quotes: drop the static Authorization token from config — the adapter now scrapes it live.
--
-- The BHB webapi Bearer token ("APIKey") is a PUBLIC client token in the homepage JS that ROTATES
-- several times/day; pinning it in endpoint_config.headers is a time-bomb (BHB 401s on rotation).
-- adapters/bhb/quotes.ts now scrapes the current APIKey from https://www.bahrainbourse.com/en at
-- fetch time (cached in-process; re-scraped on a 401), so the stale config token is obsolete — remove
-- it. Everything is DIRECT (use_proxy already false — the historical Cloudflare/geo block is gone).

update ingest.sources
set endpoint_config = (endpoint_config #- '{headers,Authorization}') #- '{headers,authorization}'
where id = 16 and venue = 'BHB' and data_type = 'quotes';

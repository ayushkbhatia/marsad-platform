-- 20260719101210_activate_adx_securities_profile — Phase C3: flip the seeded ADX
-- securities_profile source (id 42) + schedule (id 40) active. The endpoint rides the same
-- cookie-seated browser context + apigateway headers the LIVE ADX quotes source uses (curl-level
-- Cloudflare 403 proves nothing for a WAF venue — the ADX-outage lesson). The profileFieldMap is
-- the seeded best-effort; the config-driven parser yields ZERO rows + logs on a mis-map (never
-- garbage), and the productivity guard backs the source off — so activation is the cheapest way
-- to capture the real shape. Watch the first daily cycle; if 0-yield, pin the real fieldMap from
-- the captured snapshot (a DATA fix on this row, no deploy).
--
-- TDWL (41, Mubasher profile route 404s — needs an XHR capture) and MSX (43, /api/company is a
-- 302 to PageNotFound — endpoint gone) stay OFF; findings + triggers in BUILD-STATUS §7.

set search_path = '';

-- Pin the ADX quotes gateway headers onto the profile source (same gateway, same apikey — the
-- seeded row lacked the two auth headers the working quotes source (id 7) carries).
update ingest.sources
   set endpoint_config = jsonb_set(
         endpoint_config,
         '{headers}',
         coalesce(endpoint_config -> 'headers', '{}'::jsonb)
           || jsonb_build_object(
                'channel-id', 'OSS WEB',
                'adx-gateway-apikey', (select s7.endpoint_config -> 'headers' ->> 'adx-gateway-apikey'
                                         from ingest.sources s7 where s7.id = 7)),
         true),
       active = true
 where id = 42 and venue = 'ADX' and data_type = 'securities_profile';

update ingest.schedules set active = true where id = 40 and source_id = 42;

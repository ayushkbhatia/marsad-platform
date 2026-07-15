-- Proxy provider migration IPRoyal → Geonode: config-side cleanup.
--
-- (1) Clear use_proxy on the 6 INACTIVE Yahoo sources (ids 19-24). Per the proxy-egress policy
--     (01-ingestion.md §2), a host that merely rate-limits (Yahoo 429) does NOT qualify for the
--     proxy — throttle instead. They are superseded by the Mubasher-direct backfill and are inactive;
--     clearing the flag ensures that if ever reactivated they egress DIRECT, not through the paid proxy.
-- (2) BHB quotes (id 16): proxy_mode sticky → rotate. Geonode's rotating gateway port (…:9000) rejects
--     session selectors ("Can not use -session- on rotating ports range"); sticky needs a separate
--     Geonode sticky port we do not have. BHB's stale sticky need was a Radware WAF cookie that no
--     longer gates the endpoint (it now 401s on an expired bearer token, not a WAF challenge). Use rotate.
--
-- Proxy creds themselves live in the VPS worker.env (PROXY_SERVER/USERNAME/PASSWORD), NOT here —
-- switched to proxy.geonode.io:9000 with the Geonode username selector (-type-residential-country-bh).
-- core/proxy.ts applyProxyMode was updated to chain Geonode session selectors on the USERNAME.

update ingest.sources
set endpoint_config = endpoint_config - 'use_proxy' - 'proxy_mode'
where id in (19, 20, 21, 22, 23, 24)
  and coalesce(endpoint_config->>'provider', '') = 'yahoo'
  and active = false;

update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{proxy_mode}', '"rotate"')
where id = 16 and venue = 'BHB' and data_type = 'quotes';

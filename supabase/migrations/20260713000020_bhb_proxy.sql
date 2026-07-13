-- 0020_bhb_proxy — route BHB sources through the GCC outbound proxy.
--
-- P1 runtime fix (GROUND TRUTH #4). The official Bahrain Bourse origin
-- (bahrainbourse.com / webapi.bahrainbourse.com) is IP-geofenced/Akamai-blocked
-- from our plain VPS egress IP (recon: 403 direct, 301 through a GCC-exit
-- residential proxy). We flag EVERY BHB source (quotes + filings_list +
-- eod_bulletin) to egress through the configured proxy by setting
-- endpoint_config.use_proxy = true. The ingestion transport layer
-- (core/proxy.resolveProxyForSource) reads this flag per source and applies the
-- proxy resolved from the environment.
--
-- NO SECRET LIVES HERE. This migration only records WHICH sources use the proxy.
-- The proxy URL + IPRoyal credentials (incl. the `_country-ae,sa` geo selector on
-- the password) are read at runtime from the VPS worker.env
-- (IPROYAL_PROXY_URL / PROXY_URL, or split PROXY_SERVER+PROXY_USERNAME+
-- PROXY_PASSWORD). See ingestion/src/core/proxy.ts.
--
-- TDWL uses the Mubasher aggregator (english.mubasher.info) for Saudi data, which
-- is reachable from the plain VPS IP — it needs NO proxy and is intentionally
-- untouched here. Only BHB's official site needs the GCC proxy.
--
-- Idempotent: jsonb_set is applied only where use_proxy is not already true, so
-- re-running is a no-op. Targets the LIVE prod DB.

update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{use_proxy}', 'true'::jsonb, true)
where venue = 'BHB'
  and coalesce((endpoint_config ->> 'use_proxy')::boolean, false) is not true;

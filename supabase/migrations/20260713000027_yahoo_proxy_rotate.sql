-- 0027_yahoo_proxy_rotate — route Yahoo sources through the ROTATING IPRoyal proxy.
--
-- P1.7a critical-path fix (owner decision 2026-07-14, GROUND TRUTH). Yahoo
-- (query1/query2.finance.yahoo.com) is now 429 rate-blocked from the plain VPS
-- egress IP under the ~200-symbol backfill/quote-sweep VOLUME. It is NOT
-- geoblocked. IPRoyal residential proxies ROTATE the exit IP per request by
-- default, so routing Yahoo through the proxy gives a fresh IP per call → the
-- per-IP rate counter never accumulates → no 429. This is the framework practice:
-- a per-source fetch policy {use_proxy, proxy_mode}.
--
-- WHAT THIS DOES: on every Yahoo ingest.sources row (endpoint_config.provider =
-- 'yahoo' — the stable discriminant seeded in 0021), set
--   endpoint_config.use_proxy = true       → egress through the configured proxy
--   endpoint_config.proxy_mode = 'rotate'   → FRESH exit IP per request (the default,
--                                             set explicitly for auditability)
-- The ingestion transport layer reads both per source at runtime
-- (core/proxy.resolveProxyForSource → applyProxyMode) and applies the proxy
-- resolved from the environment. 'rotate' leaves the IPRoyal base password
-- untouched (it already rotates per request); only 'sticky' would append a
-- `_session-…` selector.
--
-- NO SECRET LIVES HERE. This migration only records WHICH sources use the proxy
-- and their IP policy. The proxy URL + IPRoyal credentials are read at runtime
-- from the VPS worker.env (IPROYAL_PROXY_URL / PROXY_URL, or split
-- PROXY_SERVER+PROXY_USERNAME+PROXY_PASSWORD). See ingestion/src/core/proxy.ts.
--
-- WAF venues (BHB etc.) are UNTOUCHED: 0020_bhb_proxy already set use_proxy=true on
-- BHB and BHB's Radware challenge cookie is IP-bound, so BHB should stay 'sticky'
-- (its absent proxy_mode is NOT forced to rotate here). This migration targets ONLY
-- provider='yahoo' rows, so it cannot disturb BHB or any other source.
--
-- IDEMPOTENT: jsonb_set is applied only where the target value is not already set,
-- so re-running is a no-op. Targets the LIVE prod DB (yjsncnpbjuueaoeejrqj).

-- 1. use_proxy = true on all Yahoo sources (quotes cross-check + ohlcv_backfill).
update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{use_proxy}', 'true'::jsonb, true)
where endpoint_config ->> 'provider' = 'yahoo'
  and coalesce((endpoint_config ->> 'use_proxy')::boolean, false) is not true;

-- 2. proxy_mode = 'rotate' on all Yahoo sources (fresh exit IP per request).
--    Set explicitly (rather than relying on the runtime default) so the policy is
--    auditable in the DB and a Desk edit to 'sticky' is an obvious deviation.
update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{proxy_mode}', '"rotate"'::jsonb, true)
where endpoint_config ->> 'provider' = 'yahoo'
  and coalesce(endpoint_config ->> 'proxy_mode', '') is distinct from 'rotate';

-- 0035_activate_adx_msx_backfill — flip the ADX + MSX ≥2y OHLCV backfill sources LIVE.
--
-- The ADX Mubasher-CSV adapter (0033, provider='mubasher_csv', adapters/mubasher/ohlcv-csv.ts) and the
-- MSX native company-chart adapter (0034, provider='msx-company-chart', adapters/msx/history.ts) plus
-- their provider routing (runtime.tasksForProvider + withInjectedSymbols) have now deployed to the VPS
-- worker (commit d8b49d3). 0033/0034 seeded the two ohlcv_backfill sources + schedules active=false so
-- the scheduler could not dispatch an ohlcv_backfill row before the runtime could serve it. With the
-- code live it is safe to activate — exactly the 0021 → 0022 split, restated for these two venues.
--
-- CADENCE (unchanged from 0033/0034): both are cadence 1440, session_only=false — a coarse one-time
-- daily drain that begins at the next ingest-tick, low priority so it does not eat the live-quote
-- budget. The runtime injects endpoint_config.symbols per cycle from public.securities (RAW listed
-- tickers), so the sweep tracks the live master (93 ADX slugs, 68 MSX slugs).
--
-- REACHABILITY (verified live from the VPS 2026-07-14): english.mubasher.info + static.mubasher.info +
-- www.msx.om all return plain-HTTP 200 from the Hetzner IP with a browser UA — no proxy needed, so the
-- seeds keep use_proxy=false. If either origin later 403s the VPS IP under volume, flip use_proxy=true
-- (proxy_mode 'rotate') on that source row — a data fix, no redeploy.
--
-- IDEMPOTENT: keyed on the provider discriminant; the WHERE active=false guard makes a re-run a true
-- no-op once the rows are live. Safe to re-run.

-- 1. Activate the two ohlcv_backfill sources (ADX mubasher_csv, MSX msx-company-chart).
update ingest.sources
   set active = true
 where data_type = 'ohlcv_backfill'
   and endpoint_config->>'provider' in ('mubasher_csv', 'msx-company-chart')
   and active = false;

-- 2. Activate their matching schedules (one per source), keyed via the FK to the provider rows so it
--    targets ONLY these two backfill schedules and never a primary source's schedule.
update ingest.schedules sc
   set active = true
  from ingest.sources s
 where sc.source_id = s.id
   and s.data_type = 'ohlcv_backfill'
   and s.endpoint_config->>'provider' in ('mubasher_csv', 'msx-company-chart')
   and sc.active = false;

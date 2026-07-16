-- Activate the BHB ohlcv_backfill source + reconcile its egress/auth to the live BHB webapi reality.
--
-- The source was seeded active=false (20260715101500) with use_proxy=true + proxy_mode='sticky' + a
-- PINNED Authorization Bearer token, on the then-belief that webapi.bahrainbourse.com was Cloudflare-gated
-- and the VPS IP geo-blocked. That belief was SUPERSEDED the same week: the same-host BHB quotes source
-- (id16) proved live DIRECT from the VPS (20260715150100), and its pinned token was dropped for the
-- dynamic homepage APIKey scrape (20260715155435); BHB filings followed (20260716091000 / 093000). Re-
-- verified DIRECT 2026-07-16 (homepage + webapi + statement PDFs all 200 from a plain IP). This migration
-- brings ohlcv_backfill onto that same footing and turns it on:
--   1. use_proxy=false + drop proxy_mode — the host is reachable direct; the metered residential proxy is
--      reserved for hosts that genuinely can't be (owner egress policy). ingestion/src/adapters/bhb/
--      ohlcv.ts now fetches DIRECT.
--   2. strip the pinned endpoint_config.headers.Authorization — ohlcv.ts now scrapes the rotating PUBLIC
--      APIKey via the shared bhbWebapiGet (cached; re-scraped on 401), identical to quotes/filings. A
--      pinned token 401s within hours (it rotates several times/day).
--   3. active=true on BOTH the source and its schedule — the deliberate DEF-DEEP-BACKFILL-ROLLOUT flip
--      (cf. the 20260715101500 activation note). PREREQUISITE: the ohlcv.ts adapter (dynamic-Bearer +
--      direct) + provider routing must be DEPLOYED to the VPS before this migration is applied, else the
--      scheduler dispatches a source whose live adapter still 401s.
--
-- Idempotent: matches the single BHB ohlcv_backfill webapi source by its stable provider discriminant
-- (endpoint_config.provider='bhb_webapi'). Re-running is a no-op. The coverage guard (securities
-- .ohlcv_backfilled_at) + the coarse 1440-min cadence bound the 41-symbol deep-history drain.

set search_path = '';

-- 1 + 2. Egress + auth reconcile: use_proxy=false, drop proxy_mode, strip the pinned Bearer (both casings).
update ingest.sources
set endpoint_config =
      jsonb_set(endpoint_config, '{use_proxy}', 'false'::jsonb)
        #- '{proxy_mode}'
        #- '{headers,Authorization}'
        #- '{headers,authorization}',
    active = true
where venue = 'BHB'
  and data_type = 'ohlcv_backfill'
  and endpoint_config->>'provider' = 'bhb_webapi';

-- 3. Activate the schedule bound to that source.
update ingest.schedules sc
set active = true
from ingest.sources s
where sc.source_id = s.id
  and s.venue = 'BHB'
  and s.data_type = 'ohlcv_backfill'
  and s.endpoint_config->>'provider' = 'bhb_webapi';

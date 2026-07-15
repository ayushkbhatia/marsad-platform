-- 20260716090500_filing_detail_sources — seed the per-venue filing_detail sources (gap #2).
--
-- filing_detail had NO ingest.sources rows (verified live: 0 rows data_type='filing_detail'), so
-- runtime.filingDetailSourceId(venue) returned null for every venue and the filings_poll wake-up had
-- nowhere to enqueue. This seeds ONE filing_detail source + schedule per venue. The source is the
-- DRAIN target: the filings_poll records new announcements as pending ingest.seen_items and enqueues a
-- priority-1 job_queue row against THIS source; the poller routes it to the filings_detail_poll handler
-- (worker), which drains the venue's pending seen_items, downloads each PDF into the 'filings' bucket,
-- links public.filings, and enqueues ops.filing_extract_queue.
--
-- endpoint_config here is intentionally minimal — the per-announcement fetch TARGET (detail/pdf URL)
-- lives in seen_items, NOT here (config-over-code: a URL is data, not code). What this config carries:
--   responseKind 'pdf'    — the artifact class.
--   transport             — http for direct CDN hosts (DFM/MSX/BHB/QE-pdf), http_bootstrap for the
--                           Akamai/WAF venues (TDWL/ADX) whose attachment hosts need seated cookies.
--   actionDiscovery direct — WAF venues only: navigate the disclosures page ONCE per drain to seat
--                           cookies (extract:'direct' seats cookies without needing a captured XHR);
--                           the drain then browser.get()s each pdf URL in-context.
--   use_proxy false        — all detail hosts are reachable direct from the VPS today (BHB webapi went
--                           direct 20260715150100). Flip per host only if a 403/geofence proves it.
--
-- Schedules: a 60-min sessionless BACKSTOP drain (active) so a lost event-driven wake-up self-heals
-- within the hour; the handler fast-no-ops when nothing is pending, so idle cost is ~144 heartbeat
-- rows/day across 6 venues (negligible vs the churn the 0045 audit killed). Real-time work is the
-- event-driven wake-up + the handler's own self-chain, not this cadence.

set search_path = '';

with new_sources as (
  insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active)
  values
    ('TDWL', 'filing_detail',
     'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news',
     jsonb_build_object(
       'method', 'GET', 'responseKind', 'pdf', 'use_proxy', false,
       'actionDiscovery', jsonb_build_object(
         'extract', 'direct',
         'navigateUrl', 'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news')),
     '[]'::jsonb, 'http_bootstrap', 'allowed', true),

    ('DFM', 'filing_detail',
     'https://www.dfm.ae/en/the-exchange/news-disclosures/disclosures',
     jsonb_build_object('method', 'GET', 'responseKind', 'pdf', 'use_proxy', false),
     '[]'::jsonb, 'http', 'allowed', true),

    ('ADX', 'filing_detail',
     'https://www.adx.ae/en/products/equities/all',
     jsonb_build_object(
       'method', 'GET', 'responseKind', 'pdf', 'use_proxy', false,
       'actionDiscovery', jsonb_build_object(
         'extract', 'direct',
         'navigateUrl', 'https://www.adx.ae/en/products/equities/all')),
     '[]'::jsonb, 'http_bootstrap', 'allowed', true),

    ('QE', 'filing_detail',
     'https://www.qe.com.qa/q-disclosure',
     jsonb_build_object('method', 'GET', 'responseKind', 'pdf', 'use_proxy', false),
     '[]'::jsonb, 'http_bootstrap', 'allowed', true),

    ('MSX', 'filing_detail',
     'https://www.msx.om/rss.aspx?t=Company',
     jsonb_build_object('method', 'GET', 'responseKind', 'pdf', 'use_proxy', false),
     '[]'::jsonb, 'http', 'allowed', true),

    ('BHB', 'filing_detail',
     'https://bahrainbourse.com/en/News and Events/CompanyAnnouncements',
     jsonb_build_object('method', 'GET', 'responseKind', 'pdf', 'use_proxy', false),
     '[]'::jsonb, 'http', 'allowed', true)
  on conflict (venue, data_type, entry_url) do nothing
  returning id, venue
)
insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select ns.id, 60, false, off.offset_minutes, true
from new_sources ns
join (values
  ('TDWL', 0), ('DFM', 1), ('ADX', 2), ('QE', 3), ('MSX', 4), ('BHB', 5)
) as off(venue, offset_minutes) on off.venue = ns.venue;

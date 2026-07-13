-- 0017_ingest_sources — P1 ingestion seed: ingest.sources + ingest.schedules
-- rows for all 6 GCC venues (01-ingestion.md §3.4/§4.2, CONTRACT.md §8).
--
-- Tables + scheduler/sweep functions were created in 0005_prices. This migration
-- ONLY inserts the source registry + schedule rows the SQL scheduler
-- (ingest.enqueue_due_jobs) reads. It is the ONE sources-seed migration; the
-- mirror for local reference/tests is ingestion/config/sources.ts.
--
-- Design notes (locked constraints, CONTRACT.md §0):
--   * Scrape-only + DELAYED — no realtime. delay_minutes lives on public.venues.
--   * All 6 venues TDWL DFM ADX QE MSX BHB (BK inactive, no ingestion).
--   * English only — endpoint_config pins requestLocale/EN routes; meta lang='en'.
--   * Snapshot-first — endpoints are config here, never hardcoded in adapters.
--   * transport CHECK ∈ ('http','http_bootstrap','headless'). TDWL/ADX are
--     'http_bootstrap' (Playwright request-context seats WAF cookies, then the
--     browser context fetches the AJAX JSON — recon: Akamai 403s plain HTTP).
--     DFM is 'http_bootstrap' too (SPA-over-JSON, may be challenged). QE/MSX*/BHB
--     are plain 'http'. (*MSX quotes is http_bootstrap: SPA + reCAPTCHA on some
--     paths; snapshot.aspx itself is plain but the board assembly is bootstrap.)
--
-- URLs are PROVENANCE seeds. The live path is discovered on the first VPS run and
-- is editable from Desk without a deploy. Portal action ids / PUIDs (TDWL) and
-- SPA-pinned routes (DFM/ADX/BHB) are scraped at runtime via endpoint_config
-- .actionDiscovery — NEVER hardcoded. TODO markers flag deferred discovery.
--
-- Idempotent: targets the LIVE prod DB. sources dedupe on the natural key
-- (venue, data_type, entry_url); schedules are inserted only where a matching
-- (source_id) row does not already exist. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — one row per (venue, data_type). Columns per 0005 DDL:
--    (venue, data_type, entry_url, endpoint_config, normalize_rules, transport,
--     robots_status, active). id/last_*/consecutive_failures use defaults.
--
-- Cadence law (01 §4.2, CONTRACT §8): quotes 10min session-only; filings_list
-- 5min 04:00–19:00 UTC (30min overnight — modelled as the base 5min cadence, the
-- overnight relaxation is the first request-budget relief lever, applied by the
-- scheduler, not a separate row); eod_bulletin at close+30 (session_only=false,
-- a close-sweep row with a coarse cadence — eod_sweep handler self-gates on the
-- venue close); dividends daily 15:00 UTC; ipo daily 05:00 UTC. Indices are
-- folded into each venue's quotes task (shared endpoint) — no separate row.

insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  -- ======================= TDWL (Saudi / Tadawul) =======================
  -- Akamai-WAF'd → http_bootstrap. Full-market JSON via NJgetMainNomucMarketDetails
  -- (portal action id + PUID are portal-generated → scrape at runtime, never
  -- hardcode). Response ct is text/html but body is clean JSON.
  ('TDWL', 'quotes',
   'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch',
       'extract', 'datatable_ajax',
       'responseUrlPattern', 'NJgetMainNomucMarketDetails'),
     'urlTemplate', '{discoveredActionUrl}?sectorParameter=&tableViewParameter=1&iswatchListSelected=NO&requestLocale=en&_={epochMs}'),
   -- strip the epoch cache-buster + server print timestamps before hashing so an
   -- unchanged board dedupes off-hours.
   jsonb_build_array(
     jsonb_build_object('pattern', '"transactionDate":"[^"]*"', 'replacement', '"transactionDate":""'),
     jsonb_build_object('pattern', '"lastUpdatetime":"[^"]*"', 'replacement', '"lastUpdatetime":""')),
   'http_bootstrap', 'allowed', true),

  ('TDWL', 'filings_list',
   'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news',
       'extract', 'datatable_ajax',
       'responseUrlPattern', 'IssuerNews|issuer-news|getNews'),
     'pagination', jsonb_build_object('param', 'pageNumber', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('TDWL', 'eod_bulletin',
   'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/reports-publications/market-reports',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- TODO(vps): pin the daily market-report XLSX archive/download action on the
     -- first VPS Playwright run; portal-generated path.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/reports-publications/market-reports',
       'extract', 'datatable_ajax',
       'responseUrlPattern', 'MarketReport|daily.*\.xlsx')),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  -- ======================= DFM (Dubai) =======================
  -- SPA-over-JSON on api2.dfm.ae. http_bootstrap (may be challenged). Pin the
  -- /mw/v1 market-watch + /efsah/v1 disclosures routes from the SPA bundle.
  ('DFM', 'quotes',
   'https://marketwatch.dfm.ae/en',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): pin exact api2.dfm.ae /mw/v1 market-watch route from SPA bundle.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://marketwatch.dfm.ae/en',
       'extract', 'network_capture',
       'responseUrlPattern', '^https://api2\.dfm\.ae/mw/v1/')),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('DFM', 'filings_list',
   'https://www.dfm.ae/en/the-exchange/news-disclosures/disclosures',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): pin exact api2.dfm.ae /efsah/v1 disclosures route from SPA bundle.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.dfm.ae/en/the-exchange/news-disclosures/disclosures',
       'extract', 'network_capture',
       'responseUrlPattern', '^https://api2\.dfm\.ae/efsah/v1/'),
     'pagination', jsonb_build_object('param', 'page', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('DFM', 'eod_bulletin',
   'https://www.dfm.ae/en/the-exchange/market-information/market-statistics',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- TODO(vps): pin daily-bulletin XLSX/PDF download route on first VPS run.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.dfm.ae/en/the-exchange/market-information/market-statistics',
       'extract', 'network_capture',
       'responseUrlPattern', 'bulletin|daily.*\.(xlsx|pdf)')),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  -- ======================= ADX (Abu Dhabi) =======================
  -- WAF-fronted → http_bootstrap. Exact JSON-services paths are DEFERRED to the
  -- first VPS Playwright run (recon could not pin them without a real browser
  -- session). PLACEHOLDER entry_urls + network_capture discovery + TODO.
  ('ADX', 'quotes',
   'https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): discover ADX market-data JSON-services URL via page.on('response')
     -- on the first VPS run; ADX serves the full board as JSON. PLACEHOLDER url.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx',
       'extract', 'network_capture',
       'responseUrlPattern', 'adx\.ae.*(market|watch|quote|board)')),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('ADX', 'filings_list',
   'https://www.adx.ae/english/pages/newsandevents/disclosures.aspx',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): discover ADX disclosures JSON list URL on first VPS run.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.adx.ae/english/pages/newsandevents/disclosures.aspx',
       'extract', 'network_capture',
       'responseUrlPattern', 'adx\.ae.*(news|disclosure|announcement)'),
     'pagination', jsonb_build_object('param', 'page', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('ADX', 'eod_bulletin',
   'https://www.adx.ae/english/pages/marketinformation/tradingreport.aspx',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- TODO(vps): pin ADX daily trading report download route on first VPS run.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.adx.ae/english/pages/marketinformation/tradingreport.aspx',
       'extract', 'network_capture',
       'responseUrlPattern', 'adx\.ae.*(report|daily).*\.(xlsx|xls|pdf)')),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  -- ======================= QE (Qatar) =======================
  -- Plain HTTP. CONFIRMED clean-JSON board at qse_files/MarketWatch.txt (ct may be
  -- text/plain — responseKind txt_json). Real path discovered from homepage JS.
  ('QE', 'quotes',
   'https://www.qe.com.qa/pps/qse_files/MarketWatch.txt',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'txt_json',
     'urlTemplate', 'https://www.qe.com.qa/pps/qse_files/MarketWatch.txt',
     'headers', jsonb_build_object('Referer', 'https://www.qe.com.qa/')),
   '[]'::jsonb,
   'http', 'allowed', true),

  ('QE', 'filings_list',
   'https://www.qe.com.qa/company-news',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'html',
     -- TODO(vps): confirm the announcements/data-set feed shape (homepage JS
     -- references /frontend-js-api/data-set); HTML list scraped for external_id.
     'urlTemplate', 'https://www.qe.com.qa/company-news',
     'pagination', jsonb_build_object('param', 'page', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http', 'allowed', true),

  ('QE', 'eod_bulletin',
   'https://www.qe.com.qa/daily-market-report',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- TODO(vps): pin QE daily bulletin archive (PDF/XLS) download route.
     'urlTemplate', 'https://www.qe.com.qa/daily-market-report'),
   '[]'::jsonb,
   'http', 'allowed', true),

  -- ======================= MSX (Muscat) =======================
  -- Plain HTTP for snapshot.aspx + EOD; quotes board assembly is behind an SPA
  -- with reCAPTCHA on some paths → http_bootstrap for the board. snapshot.aspx?s=
  -- is per-security and NOT captcha-gated.
  ('MSX', 'quotes',
   'https://www.msx.om/market-watch',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): pin MSX market-watch JSON route (SPA); reCAPTCHA on some paths.
     -- Fallback: iterate snapshot.aspx?s={symbol} (html) per security.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.msx.om/market-watch',
       'extract', 'network_capture',
       'responseUrlPattern', 'msx\.om.*(market|watch|board|quote)'),
     'urlTemplate', 'https://www.msx.om/snapshot.aspx?s={symbol}'),
   '[]'::jsonb,
   'http_bootstrap', 'allowed', true),

  ('MSX', 'filings_list',
   'https://www.msx.om/details.aspx?b1=News&t=News',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'html',
     'urlTemplate', 'https://www.msx.om/details.aspx?b1=News&t=News',
     -- TODO(vps): add Disclosures/Circulars sibling routes as additional rows if
     -- they carry distinct external_id namespaces.
     'pagination', jsonb_build_object('param', 'page', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http', 'allowed', true),

  ('MSX', 'eod_bulletin',
   'https://www.msx.om/reports.aspx?t=Daily',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- TODO(vps): pin MSX daily/monthly bulletin archive download route.
     'urlTemplate', 'https://www.msx.om/reports.aspx?t=Daily'),
   '[]'::jsonb,
   'http', 'allowed', true),

  -- ======================= BHB (Bahrain) =======================
  -- Plain HTTP. webapi.bahrainbourse.com JSON host (pin market route from SPA).
  -- Daily-Trading-Summary.aspx is the EOD GOLD source.
  ('BHB', 'quotes',
   'https://www.bahrainbourse.com/en',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     -- TODO(vps): pin exact webapi.bahrainbourse.com/api market-watch route from
     -- SPA bundle. Plain HTTP (no WAF) so http transport with a capture-once step.
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.bahrainbourse.com/en',
       'extract', 'network_capture',
       'responseUrlPattern', '^https://webapi\.bahrainbourse\.com/api/')),
   '[]'::jsonb,
   'http', 'allowed', true),

  ('BHB', 'filings_list',
   'https://www.bahrainbourse.com/en/news-announcements',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'html',
     -- TODO(vps): confirm BHB news/announcements list shape (HTML or webapi JSON).
     'urlTemplate', 'https://www.bahrainbourse.com/en/news-announcements',
     'pagination', jsonb_build_object('param', 'page', 'start', 1, 'pageSize', 50)),
   '[]'::jsonb,
   'http', 'allowed', true),

  ('BHB', 'eod_bulletin',
   'https://www.bahrainbourse.com/en/Stocks/Pages/Daily-Trading-Summary.aspx',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'xlsx',
     -- EOD gold source. TODO(vps): pin the XLSX download link off the summary page.
     'urlTemplate', 'https://www.bahrainbourse.com/en/Stocks/Pages/Daily-Trading-Summary.aspx'),
   '[]'::jsonb,
   'http', 'allowed', true)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row per source. Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--
--   quotes        : cadence 10, session_only true.
--   filings_list  : cadence 5,  session_only false (overnight relaxation is the
--                   scheduler's budget lever, not a distinct row).
--   eod_bulletin  : cadence 60, session_only false — the eod_sweep handler runs
--                   at close+30 and self-gates; a coarse 60-min cadence keeps the
--                   queue row alive without hammering (well under 300/day/host).
--   (dividends/ipo are event-driven / future rows — not seeded in v1 per §8;
--    filing_detail is enqueued by the filings_list parser, never scheduled.)
--
-- Stagger offset_minutes: TDWL+0 DFM+1 ADX+2 QE+3 MSX+4 BHB+5 (CONTRACT §8) to
-- spread the per-host token buckets across the 5-min ingest-tick.
--
-- Idempotent: insert only where no schedule row yet exists for the source.

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, true
from (values
  ('TDWL', 'quotes',        10, true,  0),
  ('TDWL', 'filings_list',   5, false, 0),
  ('TDWL', 'eod_bulletin',  60, false, 0),
  ('DFM',  'quotes',        10, true,  1),
  ('DFM',  'filings_list',   5, false, 1),
  ('DFM',  'eod_bulletin',  60, false, 1),
  ('ADX',  'quotes',        10, true,  2),
  ('ADX',  'filings_list',   5, false, 2),
  ('ADX',  'eod_bulletin',  60, false, 2),
  ('QE',   'quotes',        10, true,  3),
  ('QE',   'filings_list',   5, false, 3),
  ('QE',   'eod_bulletin',  60, false, 3),
  ('MSX',  'quotes',        10, true,  4),
  ('MSX',  'filings_list',   5, false, 4),
  ('MSX',  'eod_bulletin',  60, false, 4),
  ('BHB',  'quotes',        10, true,  5),
  ('BHB',  'filings_list',   5, false, 5),
  ('BHB',  'eod_bulletin',  60, false, 5)
) as v(venue, data_type, cadence_minutes, session_only, offset_minutes)
join ingest.sources s on s.venue = v.venue and s.data_type = v.data_type
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

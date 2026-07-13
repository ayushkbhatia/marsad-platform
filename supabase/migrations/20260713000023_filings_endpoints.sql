-- 0023_filings_endpoints — repoint the QE/ADX/BHB filings_list sources at the REAL,
-- live-verified disclosure endpoints discovered this session (P1.5 filings-tuning).
--
-- WHY: the 0017 seed used PROVENANCE placeholder URLs for these three venues' filings lists
-- (TODO markers). On the VPS this session the real feeds were pinned + fixture-saved, so the
-- filings-list parsers (ingestion/src/adapters/{qe,adx,bhb}/filings.ts) were rewritten to match
-- them. This migration lands the matching source config so the pipeline fetches the RIGHT bytes.
--
--   ADX filings  → apigateway.adx.ae/adx/tradings/1.1/news (JSON, response.news[]). Akamai blocks
--                  plain curl even WITH the apikey, but Playwright in-page fetch returns 200 → stays
--                  http_bootstrap. REQUIRES the static SPA apikey header (adx-gateway-apikey) plus an
--                  x-correlation-id. external_id=exPara, title=titleEn, pdf=urlEn.
--   BHB filings  → webapi.bahrainbourse.com/api/data/GetAllAnnouncements (JSON, data.Announcements[]).
--                  Host is NON-www bahrainbourse.com. The webapi 200s only for the request the
--                  COMPANYANNOUNCEMENTS page itself issues (session/referer seated by the page) → MUST
--                  capture the response via actionDiscovery.network_capture, http_bootstrap +
--                  use_proxy=true (proxy flag set by 0020, re-asserted here). external_id=symbol+itemid.
--   QE filings   → qe.com.qa/q-disclosure (the market-wide disclosures page of record). The feed is a
--                  Liferay React/Clay portlet whose resource XHR was NOT captured in recon (one more
--                  VPS headless capture needed to pin it), and the QE origin TLS-stalls plain curl →
--                  MUST be http_bootstrap. The parser survives both a Liferay JSON resource and an HTML
--                  anchor list; the resource URL is discovered at runtime via network_capture until a
--                  golden is added. Interim: filings will drift_zero_rows (Desk item) not garbage.
--
-- TDWL filings are DELIBERATELY UNTOUCHED: their only live source (saudiexchange.sa) is Akamai-blocked
-- from every reachable IP (same reason 0019 moved TDWL QUOTES to Mubasher). The Mubasher Saudi-news
-- endpoint needs one more VPS capture to pin the exact JSON path — parked until then (do NOT fight
-- Akamai). DFM + MSX filings sources are ALSO untouched here: their seed URLs already fetch 200; only
-- their PARSERS changed (DFM eFsah root[]/headline/BOM; MSX switched to rss.aspx?t=Company). The
-- pinned live URLs those parsers expect are set below for DFM/MSX too, since the 0017 seed still
-- points DFM at the HTML SPA page (wrong bytes) and MSX at the JS-template details.aspx (empty rows).
--
-- ADX apikey NOTE: the adx-gateway-apikey is a STATIC key baked into the public ADX SPA bundle (not a
-- secret credential) — it is the same value every browser sends. x-correlation-id is a per-request
-- UUID; a fixed placeholder is fine (the gateway does not validate its value, only its presence).
--
-- IDEMPOTENT: each UPDATE targets the single (venue, data_type='filings_list') row and is safe to
-- re-run (it just re-asserts the same config + clears last_content_hash so the changed endpoint
-- re-parses on the next run). Targets the LIVE prod DB (yjsncnpbjuueaoeejrqj).

-- ---------------------------------------------------------------------------
-- DFM filings_list — repoint at the real api2.dfm.ae eFsah prototype_efsah JSON.
-- (Seed pointed at the HTML SPA page → JSON.parse threw → drift_zero_rows.)
update ingest.sources
set entry_url = 'https://api2.dfm.ae/efsah/v1/prototype_efsah',
    transport = 'http_bootstrap',
    endpoint_config = jsonb_build_object(
      'method', 'GET',
      'responseKind', 'json',
      'urlTemplate', 'https://api2.dfm.ae/efsah/v1/prototype_efsah?lang=en'
        || '&h7_datetime_format=MMM+dd%2C+yyyy+HH%3Amm%3Ass'
        || '&from=&to=&announcement_type=Disclosure&types=&symbol=+&keyword=&cms_resources=true&take=20&skip=0',
      'actionDiscovery', jsonb_build_object(
        'navigateUrl', 'https://www.dfm.ae/the-exchange/news-disclosures/disclosures',
        'extract', 'network_capture',
        'responseUrlPattern', '^https://api2\.dfm\.ae/efsah/v1/')),
    last_content_hash = null
where venue = 'DFM' and data_type = 'filings_list';

-- ---------------------------------------------------------------------------
-- MSX filings_list — repoint at the server-rendered RSS company-announcements feed.
-- (Seed pointed at details.aspx JS template → zero rows → drift_zero_rows.)
update ingest.sources
set entry_url = 'https://www.msx.om/rss.aspx?t=Company',
    transport = 'http',
    endpoint_config = jsonb_build_object(
      'method', 'GET',
      'responseKind', 'html',
      'urlTemplate', 'https://www.msx.om/rss.aspx?t=Company'),
    last_content_hash = null
where venue = 'MSX' and data_type = 'filings_list';

-- ---------------------------------------------------------------------------
-- ADX filings_list — apigateway news feed (Playwright seats Akamai cookies, then in-page fetch
-- with the static SPA apikey header). urlTemplate is fetched directly after bootstrap.
update ingest.sources
set entry_url = 'https://apigateway.adx.ae/adx/tradings/1.1/news?categoryName=cd&categoryValue=&recordCount=25',
    transport = 'http_bootstrap',
    endpoint_config = jsonb_build_object(
      'method', 'GET',
      'responseKind', 'json',
      'urlTemplate', 'https://apigateway.adx.ae/adx/tradings/1.1/news?categoryName=cd&categoryValue=&recordCount=25',
      'headers', jsonb_build_object(
        'adx-gateway-apikey', '1863a94c-582b-46f9-b4f0-0d02c0cc5307',
        'x-correlation-id', '00000000-0000-4000-8000-000000000000'),
      'actionDiscovery', jsonb_build_object(
        'navigateUrl', 'https://www.adx.ae/en/products/equities/all',
        'extract', 'network_capture',
        'responseUrlPattern', '^https://apigateway\.adx\.ae/adx/tradings/1\.1/news')),
    last_content_hash = null
where venue = 'ADX' and data_type = 'filings_list';

-- ---------------------------------------------------------------------------
-- BHB filings_list — non-www host, webapi GetAllAnnouncements captured off the COMPANYANNOUNCEMENTS
-- page through the GCC proxy. http_bootstrap + use_proxy=true (0020 flag re-asserted here).
update ingest.sources
set entry_url = 'https://bahrainbourse.com/en/News and Events/CompanyAnnouncements',
    transport = 'http_bootstrap',
    endpoint_config = jsonb_build_object(
      'method', 'GET',
      'responseKind', 'json',
      'use_proxy', true,
      'urlTemplate', 'https://webapi.bahrainbourse.com/api/data/GetAllAnnouncements'
        || '?variationTitle=en&itemcount=30&websiteID=bhb&cid=0&month=-1&year=2026&pagenum=1',
      'actionDiscovery', jsonb_build_object(
        'navigateUrl', 'https://bahrainbourse.com/en/News and Events/CompanyAnnouncements',
        'extract', 'network_capture',
        'responseUrlPattern', '^https://webapi\.bahrainbourse\.com/api/data/GetAllAnnouncements')),
    last_content_hash = null
where venue = 'BHB' and data_type = 'filings_list';

-- ---------------------------------------------------------------------------
-- QE filings_list — the q-disclosure page of record. Feed URL not yet pinned (runtime discovery via
-- network_capture); http_bootstrap because QE origin TLS-stalls plain curl from the VPS.
update ingest.sources
set entry_url = 'https://www.qe.com.qa/q-disclosure',
    transport = 'http_bootstrap',
    endpoint_config = jsonb_build_object(
      'method', 'GET',
      'responseKind', 'json',
      'actionDiscovery', jsonb_build_object(
        'navigateUrl', 'https://www.qe.com.qa/q-disclosure',
        'extract', 'network_capture',
        'responseUrlPattern', 'q-disclosure|disclosure|GetDisclosure|/o/.*resource')),
    last_content_hash = null
where venue = 'QE' and data_type = 'filings_list';

-- 20260716123227_securities_profile_sources — seed the securities_profile PRODUCER sources (+ schedules)
-- that feed the source-agnostic persist layer (20260716110000). DEF-SECTOR-DATA (07 §3.3/§P1.7e-I).
--
-- Each source is a per-company profile scrape whose parse() emits NormalizedProfile[] (sector/isin/
-- shares_outstanding); the runtime stages them as PROFILE.SECURITY → sweep → cross_check →
-- lake.fn_security_profile_project → public.securities. The runtime coverage guard (withProfileSymbols)
-- injects only securities WHERE profile_scraped_at IS NULL, chunked to 25, so a one-time drain fills the
-- 693 empty rows and then goes DORMANT (coverage-complete skip). data_type 'securities_profile' has NO
-- CHECK constraint on ingest.sources.data_type (free text — verified live), so no enum change is needed;
-- DATA_TYPE_TO_HANDLER.securities_profile='quote_poll' (worker/src/ingest-poller.ts) services it.
--
-- ── VENUE COVERAGE (of the 693 listed, all sector/isin/shares EMPTY today) ──────────────────────────
--   TDWL 387 (56%) — Mubasher /profile (provider='mubasher_profile'); ADX 93 — native overview.json
--   (cookie-seated browser + apigateway headers); MSX 68 — native company info. Together ≈ 548 (79%).
--   DFM 55 + QE 49 (Yahoo-egress / native-endpoint discovery) + BHB 41 (proxy gap) are the remaining
--   gap to the >90% acceptance bar — parked with precise triggers in BUILD-STATUS §7 (DEF-SECTOR-DATA-
--   DFM-QE / DEF-SECTOR-DATA-BHB). BHB is the documented coverage-gap venue (must not block).
--
-- ── SEEDED INACTIVE (active=false) — activation is a DELIBERATE VPS-capture flip ────────────────────
-- Mirrors the 0021/0033/0034/20260715101500 backfill pattern. The exact per-company profile URL + JSON
-- field PATHS are unknown until a real session observes them, so:
--   • urlTemplate below is a best-effort placeholder from the documented shapes (07 §2.1/§2.2);
--   • the parser is CONFIG-DRIVEN — endpoint_config.profileFieldMap (dotted paths) overrides the
--     adapter DEFAULT map, so pinning the real field names is a DATA FIX, not a code deploy
--     (adapters/profile/shared.ts, the ADX-quotes fieldMap pattern);
--   • ACTIVATION STEP (its own migration, like ADX quotes 0044): on the first VPS capture, pin the real
--     urlTemplate + profileFieldMap + (ADX) the gateway apikey header + add a golden fixture, then flip
--     the source + schedule active=true. Seeding inactive means a wrong placeholder never burns the
--     shared 300 req/day/host budget (Mubasher host is shared with TDWL quotes).
--
-- ⚠ OWNER STEER — DEF-EXIT-MUBASHER (2026-07-16): TDWL rides Mubasher here. This is a ONE-TIME backfill
--   (drains, stamps profile_scraped_at, then dormant — NOT a durable poll), materially different from the
--   ongoing quote/backfill Mubasher dependencies the directive targets. The Mubasher-free ALTERNATIVE is
--   to extend the free Tadawul XBRL feed (already landing statements) to also emit NormalizedProfile from
--   its entity metadata (dei:EntityCommonStockSharesOutstanding / sector / ISIN) — the persist layer is
--   source-agnostic, so that producer plugs into the SAME PROFILE.SECURITY contract with no schema change.
--   Which TDWL producer to activate is the owner's call at the activation gate (see BUILD-STATUS §7).
--
-- BUDGET / PACING: chunk 25 (withProfileSymbols); the runTask self-chain fires the next chunk 180 min out
-- (≈8 chunks/day × 25 ≈ 200 GETs/day/host — under the 300 cap shared with quotes); the daily schedule
-- below is the kickstart + safety re-kick + heartbeat. All active=false until activation.
--
-- IDEMPOTENT: sources dedupe on (venue,data_type,entry_url); schedules insert only where no (source_id)
-- row exists. Safe to re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — one securities_profile producer per reachable venue (active=false).
-- ---------------------------------------------------------------------------
insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  -- TDWL — Mubasher /profile (aggregator, provider-routed). Plain http, no WAF/proxy. urlTemplate +
  -- profileFieldMap are VPS-pin placeholders (Mubasher's /api/1 JSON style; the quote board is
  -- /api/1/stocks/prices?country=sa). {symbol} = RAW ticker (our public.securities.ticker, e.g. 2222).
  ('TDWL', 'securities_profile',
   'https://english.mubasher.info/api/1/stocks/{symbol}/profile?country=sa',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'mubasher_profile',
     'strategy', 'per_ticker_profile_json',
     'urlTemplate', 'https://english.mubasher.info/api/1/stocks/{symbol}/profile?country=sa',
     'fetch_concurrency', 4,
     'timeoutMs', 20000,
     -- VPS-PIN: replace with the real Mubasher profile field paths + add a golden fixture before activation.
     'profileFieldMap', jsonb_build_object(
       'rowsPath', 'profile', 'sector', 'sector', 'industry', 'industry', 'isin', 'isin',
       'shares', 'sharesOutstanding', 'symbol', 'code')),
   '[]'::jsonb, 'http', 'allowed', false),

  -- ADX — native company overview.json via the cookie-seated Chromium context (Akamai-WAF'd, like ADX
  -- quotes). transport http_bootstrap; actionDiscovery seats cookies (extract 'direct') then the adapter
  -- GETs the per-symbol urlTemplate in-context. VPS-PIN: the real overview URL + field paths + the
  -- apigateway gateway apikey header (adx-gateway-apikey/channel-id, same as ADX quotes id7) before activation.
  ('ADX', 'securities_profile',
   'https://apigateway.adx.ae/adx/company/1.0/profile/{symbol}',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'strategy', 'per_ticker_overview_json',
     'urlTemplate', 'https://apigateway.adx.ae/adx/company/1.0/profile/{symbol}',
     'actionDiscovery', jsonb_build_object(
       'navigateUrl', 'https://www.adx.ae/en/products/equities/market-watch',
       'extract', 'direct'),
     'headers', jsonb_build_object(
       'Accept', 'application/json',
       'Referer', 'https://www.adx.ae/'),
     'timeoutMs', 30000,
     -- VPS-PIN: replace with the real ADX overview.json field paths + add a golden fixture before activation.
     'profileFieldMap', jsonb_build_object(
       'rowsPath', 'pageProps.overview', 'sector', 'sectorNameEn', 'industry', 'subSectorNameEn',
       'isin', 'isin', 'shares', 'numberOfShares', 'symbol', 'companySymbol')),
   '[]'::jsonb, 'http_bootstrap', 'allowed', false),

  -- MSX — native company info. Plain http, no WAF/proxy (like msx.om history). VPS-PIN url + field paths.
  ('MSX', 'securities_profile',
   'https://www.msx.om/api/company/{symbol}',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'strategy', 'per_ticker_company_json',
     'urlTemplate', 'https://www.msx.om/api/company/{symbol}',
     'fetch_concurrency', 4,
     'timeoutMs', 20000,
     -- VPS-PIN: replace with the real MSX company-info field paths + add a golden fixture before activation.
     'profileFieldMap', jsonb_build_object(
       'rowsPath', '', 'sector', 'Sector', 'industry', 'SubSector', 'isin', 'ISIN',
       'shares', 'ListedShares', 'symbol', 'Symbol')),
   '[]'::jsonb, 'http', 'allowed', false)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row per profile source (active=false). Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--    cadence 1440 (daily kickstart + safety re-kick; the runTask self-chain drives the active 180-min
--    chunk drain), session_only false, offsets +15/+16/+17 (a free band clear of the primary stagger
--    0-5, the Yahoo backfill +9/+10/+11, ADX mubasher-csv +12, MSX +13, BHB webapi +14). active=false —
--    flipped with the source at activation.
-- ---------------------------------------------------------------------------
insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, false
from (values
  ('TDWL', 'securities_profile', 'https://english.mubasher.info/api/1/stocks/{symbol}/profile?country=sa', 1440, false, 15),
  ('ADX',  'securities_profile', 'https://apigateway.adx.ae/adx/company/1.0/profile/{symbol}',              1440, false, 16),
  ('MSX',  'securities_profile', 'https://www.msx.om/api/company/{symbol}',                                 1440, false, 17)
) as v(venue, data_type, entry_url, cadence_minutes, session_only, offset_minutes)
join ingest.sources s
  on s.venue = v.venue and s.data_type = v.data_type and s.entry_url = v.entry_url
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

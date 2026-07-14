-- 0033_adx_mubasher_ohlcv — add Mubasher historical-CSV as the ≥2-year daily OHLCV backfill
-- source for ADX (01-ingestion.md exit criterion: ≥2y daily OHLCV per security).
--
-- WHY / DESIGN FIT (verified live 2026-07-14 from a plain IP):
-- Yahoo Finance (0021/0022) covers only TDWL/QE/DFM — it has NO findable symbols for ADX/MSX/BHB,
-- so those three venues have ZERO ≥2y daily bars in public.ohlcv_daily. Mubasher
-- (english.mubasher.info / static.mubasher.info) publishes each ADX-listed stock's FULL historical
-- daily series as a plain headerless CSV, reachable from a plain IP with NO WAF/proxy and NO crumb.
-- This seeds ADX; MSX + BHB follow as their own rows once their slugs are recon'd (same adapter).
--
-- The NormalizedOhlcv the adapter emits carries our OWN venue (ADX) + RAW ticker + tradeDate, so
-- runtime.mapOhlcv produces the natural_key
--   OHLCV.CLOSE:ADX:{ticker}:{tradeDate}
-- IDENTICAL to any future ADX EOD-bulletin bar for the same day (CONTRACT §6.5) — when a second ADX
-- OHLCV source lands, the two collide and the 2-source cross-check fires. See
-- ingestion/src/adapters/mubasher/ohlcv-csv.ts.
--
-- ── THE 2-STEP FETCH (per ticker) ────────────────────────────────────────────────────────────────
-- The CSV lives at an opaque per-ticker hash URL that is NOT derivable from the ticker; it must be
-- scraped from the stock page first:
--   (1) GET pageUrlTemplate with {symbol}=RAW ticker (e.g. FAB) → HTML carrying an attribute
--       historical-data-url=".../File.Historical_Stock_Charts_Dir/{hash}.csv". A DECOY intraday
--       attribute on the SAME page carries the SAME hash under File.Delay_Stock_Intraday_Charts_Dir,
--       so hashPattern MUST anchor on 'Historical_Stock_Charts_Dir' to select the ≥2y file.
--   (2) GET csvUrlTemplate with {hash} → headerless CSV, each line DATE/TIME,open,high,low,close,vol.
--       The DATE before '/' is ALREADY the ADX-local calendar trade date — no timezone math.
-- A non-existent ticker → page 404 (no hash) → that ticker is SKIPPED (per-ticker isolation).
--
-- ── SEEDED INACTIVE (active=false) — activation is a one-line flip AFTER deploy ───────────────────
-- Mirrors the 0021 → 0022 split: this migration seeds the row + schedule active=false; a follow-up
-- migration flips active=true AFTER the ohlcv-csv adapter + provider routing deploy to the VPS, so
-- the scheduler never dispatches an ADX ohlcv_backfill row before the runtime can serve it. The
-- provider discriminant endpoint_config.provider='mubasher_csv' is the stable key the runtime
-- (runtime.tasksForProvider) routes on and a later 0034-style activation guards on.
--
-- ── PROXY NOTE (data fix, no redeploy) ───────────────────────────────────────────────────────────
-- static.mubasher.info returned plain-HTTP 200 from the recon box with NO proxy, so use_proxy=false.
-- IF the VPS IP is 403'd on static.mubasher.info under volume, flip use_proxy=true (and proxy_mode
-- 'rotate') in THIS row — runtime.httpClientForSource already honors use_proxy, so it takes effect
-- with no redeploy.
--
-- SYMBOLS: endpoint_config.symbols is auto-injected per cycle from public.securities (RAW listed ADX
-- tickers, NO suffix) by the runtime (withMubasherCsvSymbols) — NEVER hardcoded here (CONTRACT §0.6),
-- so the sweep tracks the live securities master. The ~93 ADX slugs are not enumerated in this seed.
--
-- BUDGET: backfill is a one-time-per-security drain routed to the runtime's high-throughput profile.
-- 2 GETs/ticker (page + CSV) × ~93 ADX tickers. Coarse daily cadence, session_only=false, low
-- priority so it does not eat the live-quote budget.
--
-- IDEMPOTENT: the source dedupes on the (venue,data_type,entry_url) unique key (on conflict do
-- nothing); the schedule inserts only where a matching (source_id) row does not already exist. The
-- entry_url is the CSV-dir root URL — DISTINCT from every existing ADX source (quotes/filings/etc.)
-- so it never collides. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — ADX 'ohlcv_backfill' via Mubasher historical CSV. transport 'http' (no
--    WAF/proxy). robots_status 'allowed'. active=false (see the activation note above).
--    endpoint_config carries the 2-step templates, the hash anchor, a real browser UA, provider
--    ='mubasher_csv', fetch_concurrency 4, use_proxy false. normalize_rules empty — the CSV is a
--    stable historical series with no volatile per-response bytes to strip before hashing.

insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  ('ADX', 'ohlcv_backfill',
   'https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'csv',
     'provider', 'mubasher_csv',
     'strategy', 'per_ticker_page_then_historical_csv',
     -- {symbol} = RAW ADX ticker (our public.securities.ticker), substituted per security by the
     -- adapter; the symbol list is config (endpoint_config.symbols), auto-populated from
     -- public.securities by the runtime — NEVER hardcoded (CONTRACT §0.6).
     'pageUrlTemplate', 'https://english.mubasher.info/markets/ADX/stocks/{symbol}',
     -- {hash} = the per-ticker historical hash scraped from the stock page (step 1).
     'csvUrlTemplate', 'https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/{hash}.csv',
     -- MUST anchor on the Historical_ dir so the intraday decoy (same hash) is never matched.
     'hashPattern', 'Historical_Stock_Charts_Dir/([a-f0-9]+)\.csv',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', '*/*'),
     'fetch_concurrency', 4,
     -- static.mubasher.info was plain-HTTP 200 from the recon box; flip to true (rotate) here if the
     -- VPS IP gets 403'd — a data fix, no redeploy (runtime.httpClientForSource honors use_proxy).
     'use_proxy', false),
   '[]'::jsonb,
   'http', 'allowed', false)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row for the ADX Mubasher backfill source. Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--
--   cadence 1440 (coarse daily drain), session_only false — the backfill handler self-throttles per
--   security; low priority so it does not eat the live-quote budget. offset_minutes 12 sits in a free
--   band clear of the primary sources' stagger and the Yahoo backfill band (+9/+10/+11, 0021).
--   active=false — mirrors the source (flip both together in the activation migration).
--
-- The join is on (venue, data_type, entry_url) so it targets ONLY this Mubasher backfill row.

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, false
from (values
  ('ADX', 'ohlcv_backfill',
   'https://static.mubasher.info/File.MubasherCharts/File.Historical_Stock_Charts_Dir/',
   1440, false, 12)
) as v(venue, data_type, entry_url, cadence_minutes, session_only, offset_minutes)
join ingest.sources s
  on s.venue = v.venue and s.data_type = v.data_type and s.entry_url = v.entry_url
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

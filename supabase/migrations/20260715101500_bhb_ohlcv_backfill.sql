-- 20260715101500_bhb_ohlcv_backfill — add BHB's OWN webapi DataExportCompanyProfile as the ≥2-year
-- EOD-CLOSE price-history backfill source for BHB (01-ingestion.md exit criterion: ≥2y daily price per
-- security). This is the DEF-BHB-OHLCV pickup — the LAST price-history GAP (ADX=0033 Mubasher,
-- MSX=0034 native, both done).
--
-- WHY NOW (owner D-src-4 was parked on a proxy, which now exists):
-- The owner's D-src-4 decision (07-lake-enrichment.md §5) accepted BHB as the "coverage-gap venue" and
-- built NO backfill — but ONLY because BHB is CF-gated + IP-geoblocked and no BHB-reachable proxy path
-- had been recon'd. DEF-BHB-OHLCV's explicit trigger was "when a BHB-reachable proxy exists". One now
-- does: BHB-API-CONTRACT.md (proven live 2026-07-15 via a STICKY IPRoyal session) documents the whole
-- per-security close history behind the sticky proxy. So we mirror the ADX/MSX adapter shape exactly:
-- provider discriminant + a withInjectedSymbols branch + a provider-routed TaskSpec.
--
-- WHY A FIRST-CLASS BHB SOURCE (not Mubasher): BHB has NO Mubasher historical CSV, but its OWN webapi
-- exposes a per-security date-range price export — one GET is the full close history:
--   GET https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter
--        ?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}
--   → {status:1, data:[ {"":"MM/DD/YYYY","Price":"   0.230"}, … ]}  (the date key is the EMPTY STRING;
--     Price is a space-padded string). Verified live 2026-07-15 via sticky proxy: GFH 2020→2026 = 1476
--     rows; the year dropdown offers 2000..2026 → full history from FromDateYear=2000. The adapter sets
--     ToDateYear = the current year (ctx.now()) per run; FromDateYear = endpoint_config.fromYear (2000).
--   The `Authorization: Bearer <APIKey>` header is a PUBLIC client token shipped in the CompanyProfile
--   page JS (NOT a server secret) — the same token id16 BHB quotes uses (20260715100000). Stored in
--   endpoint_config.headers, consistent with that quotes row.
--
-- ── EOD CLOSE ONLY (explicit owner requirement) ────────────────────────────────────────────────────
-- This feed is EOD CLOSE ONLY — NOT OHLCV. Each row is {date, Price(close)}; there is no
-- open/high/low/volume. The adapter maps close←Price and emits open/high/low/volume as NULL — it does
-- NOT fabricate OHLC. This still clears the ≥2y daily-price exit criterion and cross-checks the
-- venue-official close against the live BHB webapi quote for the same day. See
-- ingestion/src/adapters/bhb/ohlcv.ts.
--
-- ── DATE (already the local calendar date) ─────────────────────────────────────────────────────────
-- The response date is a bare MM/DD/YYYY (US-format) BHB-local calendar trade date; the parser rewrites
-- it to ISO 'YYYY-MM-DD' with a PURE string re-order — no timezone math, no Date construction.
--
-- ── natural_key COLLISION (deliberate) ────────────────────────────────────────────────────────────
-- The NormalizedOhlcv the adapter emits carries our OWN venue (BHB) + RAW ticker + tradeDate, so
-- runtime.mapOhlcv produces the natural_key
--   OHLCV.CLOSE:BHB:{ticker}:{tradeDate}
-- IDENTICAL to the live BHB webapi quote's OHLCV bar for the same day (CONTRACT §6.5) — when both land,
-- they collide and the 2-source cross-check fires. That is the point of seeding this as the BHB
-- backfill source of record now.
--
-- ── SEEDED INACTIVE (active=false) — activation is a DELIBERATE later flip ─────────────────────────
-- Mirrors the 0021→0022, 0033 and 0034 pattern: this migration seeds the source + schedule active=false
-- so (a) the scheduler never dispatches a BHB ohlcv_backfill row before the ohlcv.ts adapter + provider
-- routing deploy to the VPS, and (b) a 41-symbol DEEP drain of the whole close history (GFH alone = 1476
-- rows; 26 years × 41 symbols is a marathon over the sticky proxy) is NOT auto-run — it is resumed
-- deliberately (like the other deep backfills, cf. §7 DEF-DEEP-BACKFILL-ROLLOUT). The provider
-- discriminant endpoint_config.provider='bhb_webapi' is the stable key the runtime
-- (runtime.tasksForProvider) routes on and the eventual activation migration will guard on.
--
-- ── PROXY (required — NOT a data-fix flip) ────────────────────────────────────────────────────────
-- Unlike ADX/MSX (plain-HTTP from the VPS), BHB's webapi host is behind Cloudflare AND BHB's datacenter
-- IP is geo-blocked, so DIRECT egress is IMPOSSIBLE. use_proxy=true + proxy_mode='sticky' (a fresh
-- residential IP per poll passes CF; the rotating pool trips "Attention Required") — identical to the
-- id16 BHB quotes egress policy. runtime.httpClientForSource honors use_proxy + proxy_mode.
--
-- SYMBOLS: endpoint_config.symbols is auto-injected per cycle from public.securities (RAW listed BHB
-- tickers, NO suffix — parameterValue={symbol} IS our raw ticker, e.g. GFH/BBK/BEYON) by the runtime
-- (withBhbWebapiSymbols) — NEVER hardcoded in endpoint_config (CONTRACT §0.6), so the sweep tracks the
-- live securities master.
--
-- SECURITIES PREREQUISITE (satisfied by 20260715101000): the injection needs the 41 BHB securities to
-- exist as targets. Only 8 BHB rows existed in public.securities; the companion migration
-- 20260715101000_bhb_securities_seed.sql (runs FIRST, timestamp < this one) seeds all 41 from the live
-- board with per-symbol currency (6 USD-quoted: ABC/ARIG/GFH/INOVEST/ITHMR/KFH, rest BHD), guarded
-- ON CONFLICT (venue_code, ticker) DO NOTHING. This migration therefore does NOT re-seed securities —
-- it assumes that companion seed has run (both ship together in this change).
--
-- BUDGET: backfill is a one-time-per-security drain routed to the runtime's high-throughput profile.
-- 1 GET/ticker (single native endpoint, no page/hash pre-step) × ~41 BHB symbols. Coarse daily cadence,
-- session_only=false, low priority so it does not eat the live-quote budget.
--
-- IDEMPOTENT: the source dedupes on the (venue,data_type,entry_url) unique key (on conflict do nothing);
-- the schedule inserts only where a matching (source_id) row does not already exist. The entry_url is the
-- GetTabularDataWithDateRangeFilter template — DISTINCT from every existing BHB source (quotes/eod/
-- filings) so it never collides. Safe to re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — BHB 'ohlcv_backfill' via the native webapi DataExportCompanyProfile export.
--    transport 'http' (plain GET; egress is the sticky IPRoyal proxy — see the proxy note). robots_status
--    'allowed'. active=false (activation note above). endpoint_config carries the single-GET url template
--    with {symbol}/{fromYear}/{toYear} placeholders, the PUBLIC Bearer APIKey + JSON Accept + Referer,
--    provider='bhb_webapi', fetch_concurrency 4, fromYear 2000, use_proxy=true, proxy_mode='sticky'.
--    normalize_rules empty — the export is a stable historical close series (the current day's row may
--    move intraday, but that does not change the completed-day bars' content hash meaningfully).

insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  ('BHB', 'ohlcv_backfill',
   'https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'bhb_webapi',
     'strategy', 'per_ticker_dataexport_daterange_json',
     -- {symbol} = RAW BHB ticker (our public.securities.ticker), {fromYear}/{toYear} substituted by the
     -- adapter ({toYear} = current year from ctx.now()). The symbol list is config
     -- (endpoint_config.symbols), auto-populated from public.securities by the runtime — NEVER hardcoded
     -- (CONTRACT §0.6).
     'urlTemplate', 'https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}',
     -- Full history: the year dropdown offers 2000..current; FromDateYear=2000 (adapter default matches).
     'fromYear', 2000,
     'timeoutMs', 45000,
     'headers', jsonb_build_object(
       -- PUBLIC client APIKey from the CompanyProfile page JS (NOT a server secret) — same token as id16.
       'Authorization', 'Bearer 49d257cf9ae44e959eabff6d366bdbe4cb03f2efd3f14e1fbb8456d8aba26ab5',
       'Accept', 'application/json',
       'Referer', 'https://bahrainbourse.com/',
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'),
     'fetch_concurrency', 4,
     -- BHB webapi is CF-gated + IP-geoblocked → DIRECT egress is impossible. Sticky residential IP passes
     -- CF; the rotating pool trips "Attention Required" (same policy as id16 BHB quotes). runtime
     -- .httpClientForSource honors use_proxy + proxy_mode.
     'use_proxy', true,
     'proxy_mode', 'sticky'),
   '[]'::jsonb,
   'http', 'allowed', false)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row for the BHB webapi backfill source. Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--
--   cadence 1440 (coarse one-time daily drain), session_only false — the backfill handler self-throttles
--   per security; low priority so it does not eat the live-quote budget. offset_minutes 14 sits in a free
--   band clear of the primary sources' stagger, the Yahoo backfill band (+9/+10/+11, 0021), the ADX
--   Mubasher backfill (+12, 0033) and the MSX company-chart backfill (+13, 0034). active=false — mirrors
--   the source (a DELIBERATE later flip resumes both together; NOT auto-run — see the activation note).
--
-- The join is on (venue, data_type, entry_url) so it targets ONLY this BHB backfill row.

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, false
from (values
  ('BHB', 'ohlcv_backfill',
   'https://webapi.bahrainbourse.com/api/data/GetTabularDataWithDateRangeFilter?storedProcdure=DataExportCompanyProfile&parameterValue={symbol}&FromDateYear={fromYear}&ToDateYear={toYear}',
   1440, false, 14)
) as v(venue, data_type, entry_url, cadence_minutes, session_only, offset_minutes)
join ingest.sources s
  on s.venue = v.venue and s.data_type = v.data_type and s.entry_url = v.entry_url
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

-- NOTE: BHB securities (the 41 injection targets) are seeded by the companion migration
-- 20260715101000_bhb_securities_seed.sql, which runs FIRST (earlier timestamp). This migration does not
-- touch public.securities — see the SECURITIES PREREQUISITE note in the header.

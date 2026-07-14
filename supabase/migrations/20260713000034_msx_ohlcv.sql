-- 0034_msx_ohlcv — add MSX's OWN native company-chart-data.aspx as the ≥2-year daily-close price
-- backfill source for MSX (01-ingestion.md exit criterion: ≥2y daily OHLCV per security).
--
-- WHY / DESIGN FIT (verified live 2026-07-14 from a plain IP + browser UA):
-- Yahoo Finance (0021/0022) covers only TDWL/QE/DFM — no findable symbols for ADX/MSX/BHB. ADX rides
-- Mubasher (0033). MSX, unlike ADX/BHB, exposes its OWN first-class, plain-HTTP JSON history handler,
-- so it does NOT need the Mubasher aggregator:
--   GET https://www.msx.om/company-chart-data.aspx?s={symbol}
--   → application/json array; ONE response is the FULL daily series to IPO/2003. Verified live:
--     BKMB 5745 daily rows 2003-01-01→2026-07-13 (24 yrs); OQGN 668 rows from its 2023-10-24 IPO —
--     comfortably ≥2y for every symbol. There is NO server paging (the Highstock rangeSelector only
--     zooms client-side), so a single GET per symbol is the whole history. No auth, no captcha.
--
-- ── CLOSE-ONLY (honest depth limit) ───────────────────────────────────────────────────────────────
-- MSX is a CLOSE-ONLY series, NOT true OHLC. Each daily row is
--   {"Date":"YYYY-MM-DD","Value":"close","LTP":"close","Volume":"str","Turnover":"str",
--    "open":null,"high":null,"low":null}
-- LTP == Value == the daily close; open/high/low keys exist but are null in EVERY observed row for
-- every symbol probed. The adapter maps close←LTP(==Value), volume←Volume, valueTraded←Turnover, and
-- emits open/high/low as NULL — it does NOT fabricate OHLC. This still clears the ≥2y daily-price
-- exit criterion and cross-checks the venue-official close against the existing MSX snapshot.aspx
-- quote for the same day. (This replaces the 07-lake-enrichment.md MSX 'GAP → msx.om scrape' price-
-- history row; the retired source-15 reports.aspx?t=Daily 302 is unrelated and left as-is.)
--
-- ── TODAY'S INTRADAY TICKS ────────────────────────────────────────────────────────────────────────
-- The current trading day is appended to the SAME array as space-timestamped intraday ticks
-- ("Date":"YYYY-MM-DD HH:MM:SS"). The adapter's PURE parser keeps only rows whose Date has NO space
-- (mirrors the site's data[i].Date.split(' ').length==1 filter), so the intraday ticks never become
-- ohlcv_daily bars. See ingestion/src/adapters/msx/history.ts.
--
-- ── natural_key COLLISION (deliberate) ────────────────────────────────────────────────────────────
-- The NormalizedOhlcv the adapter emits carries our OWN venue (MSX) + RAW ticker + tradeDate, so
-- runtime.mapOhlcv produces the natural_key
--   OHLCV.CLOSE:MSX:{ticker}:{tradeDate}
-- IDENTICAL to any future MSX EOD-bulletin bar for the same day (CONTRACT §6.5) — when a second MSX
-- OHLCV source lands, the two collide and the 2-source cross-check fires. That is the point of
-- seeding this as the MSX backfill source of record now.
--
-- ── SEEDED INACTIVE (active=false) — activation is a one-line flip AFTER deploy ───────────────────
-- Mirrors the 0021→0022 and 0033 pattern: this migration seeds the row + schedule active=false; a
-- follow-up migration flips active=true AFTER the history.ts adapter + provider routing deploy to the
-- VPS, so the scheduler never dispatches an MSX ohlcv_backfill row before the runtime can serve it.
-- The provider discriminant endpoint_config.provider='msx-company-chart' is the stable key the
-- runtime (runtime.tasksForProvider) routes on and a later activation migration guards on.
--
-- ── PROXY NOTE (data fix, no redeploy) ────────────────────────────────────────────────────────────
-- www.msx.om is fronted by Imperva/Incapsula but returned plain-HTTP 200 to a browser UA from the
-- recon box with NO proxy, so use_proxy=false. IF the VPS IP is 403'd under volume, flip use_proxy
-- =true (and proxy_mode 'rotate') in THIS row — runtime.httpClientForSource honors use_proxy, so it
-- takes effect with no redeploy.
--
-- SYMBOLS: endpoint_config.symbols is auto-injected per cycle from public.securities (RAW listed MSX
-- tickers, NO suffix — the ?s= slug IS our raw ticker, e.g. BKMB/OQGN) by the runtime
-- (withMsxHistorySymbols) — NEVER hardcoded here (CONTRACT §0.6), so the sweep tracks the live
-- securities master. The MSX slugs are not enumerated in this seed.
--
-- BUDGET: backfill is a one-time-per-security drain routed to the runtime's high-throughput profile.
-- 1 GET/ticker (single native endpoint, no page/hash pre-step). Coarse daily cadence,
-- session_only=false, low priority so it does not eat the live-quote budget.
--
-- IDEMPOTENT: the source dedupes on the (venue,data_type,entry_url) unique key (on conflict do
-- nothing); the schedule inserts only where a matching (source_id) row does not already exist. The
-- entry_url is the company-chart handler URL — DISTINCT from every existing MSX source
-- (quotes/filings) so it never collides. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — MSX 'ohlcv_backfill' via the native company-chart-data.aspx JSON. transport
--    'http' (no WAF proxy needed, browser UA). robots_status 'allowed'. active=false (activation
--    note above). endpoint_config carries the single-GET url template, a real browser UA + JSON
--    Accept, provider='msx-company-chart', fetch_concurrency 4, use_proxy false. normalize_rules
--    empty — the daily series is stable historical data (the only volatile part is today's intraday
--    tail, which the parser filters out; it does not affect the daily-bar content hash meaningfully).

insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  ('MSX', 'ohlcv_backfill',
   'https://www.msx.om/company-chart-data.aspx?s={symbol}',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'msx-company-chart',
     'strategy', 'per_ticker_company_chart_json',
     -- {symbol} = RAW MSX ticker (our public.securities.ticker), substituted per security by the
     -- adapter; the symbol list is config (endpoint_config.symbols), auto-populated from
     -- public.securities by the runtime — NEVER hardcoded (CONTRACT §0.6).
     'urlTemplate', 'https://www.msx.om/company-chart-data.aspx?s={symbol}',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json'),
     'fetch_concurrency', 4,
     -- www.msx.om (Imperva-fronted) was plain-HTTP 200 to a browser UA from the recon box; flip to
     -- true (rotate) here if the VPS IP gets 403'd — a data fix, no redeploy (runtime
     -- .httpClientForSource honors use_proxy).
     'use_proxy', false),
   '[]'::jsonb,
   'http', 'allowed', false)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row for the MSX company-chart backfill source. Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--
--   cadence 1440 (coarse daily drain), session_only false — the backfill handler self-throttles per
--   security; low priority so it does not eat the live-quote budget. offset_minutes 13 sits in a free
--   band clear of the primary sources' stagger, the Yahoo backfill band (+9/+10/+11, 0021) and the
--   ADX Mubasher backfill (+12, 0033). active=false — mirrors the source (flip both together in the
--   activation migration).
--
-- The join is on (venue, data_type, entry_url) so it targets ONLY this MSX backfill row.

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, false
from (values
  ('MSX', 'ohlcv_backfill',
   'https://www.msx.om/company-chart-data.aspx?s={symbol}',
   1440, false, 13)
) as v(venue, data_type, entry_url, cadence_minutes, session_only, offset_minutes)
join ingest.sources s
  on s.venue = v.venue and s.data_type = v.data_type and s.entry_url = v.entry_url
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

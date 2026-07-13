-- 0021_yahoo_source — add Yahoo Finance as the SECOND (cross-check) quotes source
-- for TDWL/QE/DFM, plus an ohlcv_backfill source per venue for the ≥2-year daily
-- OHLCV backfill (01-ingestion.md exit criterion).
--
-- WHY / DESIGN FIT (owner idea, verified live this session from the VPS):
-- Yahoo Finance (query1.finance.yahoo.com) republishes DELAYED quotes for 3 of the
-- 6 GCC venues as plain JSON, reachable from the plain VPS IP with NO WAF/proxy and
-- NO crumb/cookie. It becomes the SECOND source per venue for the 2-source
-- cross-check → VERIFIED lake.objects (CONTRACT §7, 02-data-lake.md):
--   * TDWL: Yahoo is the cross-check partner vs the Mubasher aggregator (0019).
--   * QE  : Yahoo is the cross-check partner vs the qe.com.qa official board.
--   * DFM : Yahoo is the cross-check partner vs the api2.dfm.ae official board.
-- Yahoo does NOT cover ADX/MSX/BHB (no findable symbols) — no rows for those.
--
-- The Yahoo NormalizedQuote/NormalizedOhlcv the adapter emits carry our OWN venue
-- (TDWL/QE/DFM) and RAW ticker (Yahoo suffix .SR/.AE/.QA STRIPPED), so
-- runtime.mapRowsToStaging produces the IDENTICAL natural_key as the primary source
--   QUOTE.LAST:{venue}:{ticker}:{session}   /   OHLCV.CLOSE:{venue}:{ticker}:{tradeDate}
-- (CONTRACT §6.5) and the two sources collide → cross-check fires. See
-- ingestion/src/adapters/yahoo/.
--
-- ENDPOINT (per-symbol v8/finance/chart — the v7 batch endpoint 401s unauthenticated
-- from the VPS and needs a fragile crumb+cookie lifecycle, so we stick to per-symbol):
--   quotes  : {SYMBOL}?interval=1d&range=1d   → meta.regularMarketPrice + chartPreviousClose + …
--   backfill: {SYMBOL}?interval=1d&range=2y   → timestamp[] + indicators.quote[0].{o,h,l,c,v}[]  (≥2y)
-- A browser User-Agent header is REQUIRED (set below). {symbol} is substituted per
-- security by the adapter; the per-cycle symbol list is CONFIG, populated from
-- public.securities (never hardcoded — see the wiring note below).
--
-- CRITICAL (verified live, corrects the memory note): the v8/chart meta has NO
-- `previousClose` key — only `chartPreviousClose`. The adapter computes
-- change = regularMarketPrice - chartPreviousClose.
--
-- ── SEEDED INACTIVE (active=false) — RUNTIME WIRING PENDING ──────────────────────
-- The worker resolves a source's parser purely by (venue, data_type) via the
-- ADAPTERS registry (runtime.tasksForSource → tasksForDataType); ingest.sources has
-- NO parser_key column (see 0019's note). Two runtime changes (OUTSIDE the Yahoo
-- adapter's assigned paths, so NOT made in this build) are required before these
-- sources can run, so they are seeded active=false to avoid the scheduler dispatching
-- them to the WRONG (primary) parser:
--   (A) quotes: a Yahoo 'quotes' row sits alongside the primary (distinct entry_url ⇒
--       the (venue,data_type,entry_url) unique key permits it), but
--       tasksForDataType('quotes') returns the SINGLE primary slot. The runtime must
--       select the Yahoo task for a source with endpoint_config.provider='yahoo'
--       (the discriminant seeded below), then flip active=true.
--   (B) ohlcv_backfill: 'ohlcv_backfill' is a valid data_type but
--       runtime.tasksForDataType has no branch for it (only 'eod_bulletin'). The
--       runtime must add an 'ohlcv_backfill' → yahooOhlcv branch, then flip active=true.
-- endpoint_config.provider='yahoo' is the stable discriminant the runtime keys on.
--
-- BUDGET (CONTRACT §5, ≤300 req/day/host on query1.finance.yahoo.com): per-symbol
-- v8/chart = 1 req/security/cycle. ~200 TDWL + a few dozen QE + a few dozen DFM
-- covered securities means ONE full sweep of all three venues already approaches the
-- cap — so the quotes sweep runs ONCE per session-day per venue (cadence 1440,
-- session_only true), NOT intraday, as the cross-check partner. Backfill is a
-- one-time drain: coarse cadence, session_only=false, low priority, spread across days.
--
-- IDEMPOTENT: sources dedupe on the (venue,data_type,entry_url) natural key; schedules
-- are inserted only where a matching (source_id) row does not already exist. The Yahoo
-- rows use a Yahoo-specific entry_url so they never collide with the primary source's
-- row. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. ingest.sources — Yahoo 'quotes' (cross-check) + 'ohlcv_backfill' per covered
--    venue. transport 'http' (no WAF/proxy). robots_status 'allowed'. active=false
--    (see the wiring note above). endpoint_config carries the v8/chart urlTemplate
--    with a {symbol} placeholder, the required browser UA, provider='yahoo', and the
--    strategy. normalize_rules strip Yahoo's volatile per-response timestamps before
--    hashing so an unchanged board dedupes off-hours.

insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active) values

  -- ===== quotes (cross-check partner) — one v8/chart GET per symbol, once/session-day =====
  ('TDWL', 'quotes',
   'https://query1.finance.yahoo.com/v8/finance/chart/TDWL',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart',
     'suffix', '.SR',
     -- {symbol} = per-security Yahoo symbol (our ticker + .SR), substituted by the
     -- adapter; the symbol list is config (endpoint_config.symbols), populated from
     -- public.securities by the runtime — NEVER hardcoded (CONTRACT §0.6).
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   jsonb_build_array(
     jsonb_build_object('pattern', '"regularMarketTime":[0-9]+', 'replacement', '"regularMarketTime":0')),
   'http', 'allowed', false),

  ('DFM', 'quotes',
   'https://query1.finance.yahoo.com/v8/finance/chart/DFM',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart',
     'suffix', '.AE',
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   jsonb_build_array(
     jsonb_build_object('pattern', '"regularMarketTime":[0-9]+', 'replacement', '"regularMarketTime":0')),
   'http', 'allowed', false),

  ('QE', 'quotes',
   'https://query1.finance.yahoo.com/v8/finance/chart/QE',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart',
     'suffix', '.QA',
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   jsonb_build_array(
     jsonb_build_object('pattern', '"regularMarketTime":[0-9]+', 'replacement', '"regularMarketTime":0')),
   'http', 'allowed', false),

  -- ===== ohlcv_backfill (≥2y daily bars) — one v8/chart range=2y GET per symbol, one-time drain =====
  ('TDWL', 'ohlcv_backfill',
   'https://query1.finance.yahoo.com/v8/finance/chart/TDWL?range=2y',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart_history',
     'suffix', '.SR',
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2y',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   '[]'::jsonb,
   'http', 'allowed', false),

  ('DFM', 'ohlcv_backfill',
   'https://query1.finance.yahoo.com/v8/finance/chart/DFM?range=2y',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart_history',
     'suffix', '.AE',
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2y',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   '[]'::jsonb,
   'http', 'allowed', false),

  ('QE', 'ohlcv_backfill',
   'https://query1.finance.yahoo.com/v8/finance/chart/QE?range=2y',
   jsonb_build_object(
     'method', 'GET',
     'responseKind', 'json',
     'provider', 'yahoo',
     'strategy', 'per_symbol_v8_chart_history',
     'suffix', '.QA',
     'urlTemplate', 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2y',
     'headers', jsonb_build_object(
       'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
       'Accept', 'application/json')),
   '[]'::jsonb,
   'http', 'allowed', false)

on conflict (venue, data_type, entry_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. ingest.schedules — one row per Yahoo source. Columns per 0005 DDL:
--    (source_id, cadence_minutes, session_only, offset_minutes, active).
--
--   quotes         : cadence 1440 (once/session-day), session_only true — the
--                    cross-check partner runs once per trading day per venue, NOT
--                    intraday, to stay inside ≤300 req/day/host across ~200+ symbols.
--   ohlcv_backfill : cadence 1440, session_only false — a coarse daily drain the
--                    backfill handler self-throttles per security; low priority so it
--                    does not eat the live-quote budget.
--
-- Stagger offset_minutes so the three venues' Yahoo sweeps do not fire simultaneously
-- and to sit clear of the primary sources' stagger (TDWL+0 DFM+1 ADX+2 QE+3 …). We use
-- a distinct band (+6/+7/+8 for quotes, +9/+10/+11 for backfill).
--
-- The join is on (venue, data_type, entry_url) — NOT (venue, data_type) — so it targets
-- ONLY the Yahoo rows and never the primary quotes source. active mirrors the source
-- (false until the runtime routing lands; flip both together).

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, v.cadence_minutes, v.session_only, v.offset_minutes, false
from (values
  ('TDWL', 'quotes',         'https://query1.finance.yahoo.com/v8/finance/chart/TDWL',          1440, true,  6),
  ('DFM',  'quotes',         'https://query1.finance.yahoo.com/v8/finance/chart/DFM',           1440, true,  7),
  ('QE',   'quotes',         'https://query1.finance.yahoo.com/v8/finance/chart/QE',            1440, true,  8),
  ('TDWL', 'ohlcv_backfill', 'https://query1.finance.yahoo.com/v8/finance/chart/TDWL?range=2y', 1440, false, 9),
  ('DFM',  'ohlcv_backfill', 'https://query1.finance.yahoo.com/v8/finance/chart/DFM?range=2y',  1440, false, 10),
  ('QE',   'ohlcv_backfill', 'https://query1.finance.yahoo.com/v8/finance/chart/QE?range=2y',   1440, false, 11)
) as v(venue, data_type, entry_url, cadence_minutes, session_only, offset_minutes)
join ingest.sources s
  on s.venue = v.venue and s.data_type = v.data_type and s.entry_url = v.entry_url
where not exists (
  select 1 from ingest.schedules sc where sc.source_id = s.id
);

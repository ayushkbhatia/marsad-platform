-- 0019_tdwl_mubasher_source — repoint the TDWL 'quotes' ingest source to the
-- Mubasher aggregator (owner hybrid decision, P1 runtime fix GROUND TRUTH #3).
--
-- WHY: the official saudiexchange.sa portal is Akamai-IP-blocked for every IP we
-- can reach it from (datacenter VPS + IPRoyal residential), so the direct TDWL
-- http_bootstrap path seeded in 0017 cannot run in production. Mubasher
-- (english.mubasher.info) republishes DELAYED Saudi (TDWL) quotes and is
-- reachable from the plain VPS IP with NO proxy and NO WAF bootstrap. So this
-- migration flips the TDWL 'quotes' source from http_bootstrap → http and points
-- it at the Mubasher market board.
--
-- DISCOVERY (captured live this session; fixture at
-- ingestion/fixtures/mubasher/tdwl-quotes.json):
--   GET https://english.mubasher.info/api/1/stocks/prices?country=sa
--   → application/json;charset=UTF-8
--   → { "lastUpdate": "YYYY-MM-DD HH:MM:SS", "prices": [ {row}, ... ] }  (~387 TDWL rows)
--   Row keys: exchange("TDWL"), code(ticker), value(last), change, changePercentage,
--   open/high/low, volume, turnover, status, updatedAt. All numeric fields are STRINGS;
--   prices/turnover/volume use comma thousands separators (the parser strips them).
--
-- PARSER: the Mubasher-backed TaskSpec at ingestion/src/adapters/mubasher/tdwl-quotes.ts
-- (mounted as tdwlAdapter.quotes). The worker resolves the parser by (venue, data_type)
-- = ('TDWL','quotes') via the ADAPTERS registry — ingest.sources has no parser_key
-- column, so there is nothing to set there; the repoint below is endpoint + transport
-- only.
--
-- SCOPE / SAFETY:
--   * There is exactly ONE TDWL 'quotes' row (0017 seed). We UPDATE it in place,
--     keyed by (venue, data_type) = ('TDWL','quotes') — idempotent, safe to re-run.
--   * The saudiexchange.sa portal is NOT a separate row (0017 seeded a single
--     'quotes' source), so nothing is "parked" at the DB level here — we simply
--     repoint the one quotes source. The saudiexchange path lives on, parked, in
--     code (adapters/tdwl/quotes.ts → tdwlSaudiExchangeQuotes) for the day the
--     Akamai block lifts; reviving it is a source repoint + a one-line adapter edit,
--     no schema change.
--   * TDWL 'filings_list' and 'eod_bulletin' sources are UNTOUCHED (still
--     saudiexchange.sa / http_bootstrap) — this is a quotes-only repoint.
--   * The ingest.schedules row for this source is unchanged (cadence 10min,
--     session_only true, offset 0). transport lives on ingest.sources, so flipping
--     it here is sufficient.

update ingest.sources s
set
  entry_url = 'https://english.mubasher.info/markets/TDWL',
  transport = 'http',
  endpoint_config = jsonb_build_object(
    'method', 'GET',
    'responseKind', 'json',
    -- Full-market delayed Saudi board as a single JSON document. country=sa scopes
    -- it to TDWL. The adapter reads urlTemplate (falls back to entry_url) — never
    -- hardcoded in code (CONTRACT §0.6, config over code).
    'urlTemplate', 'https://english.mubasher.info/api/1/stocks/prices?country=sa',
    -- Mubasher's AngularJS site expects a browser-ish request; a Referer keeps the
    -- aggregator API happy from a plain http client. Editable from Desk without a deploy.
    'headers', jsonb_build_object(
      'Referer', 'https://english.mubasher.info/markets/TDWL',
      'Accept', 'application/json')
  ),
  -- Strip the feed's volatile timestamps BEFORE hashing so an unchanged board
  -- dedupes off-hours (SnapshotStore normalize step, CONTRACT §4/§2). The top-level
  -- "lastUpdate" and every per-row "updatedAt" move on each poll even when prices
  -- don't; neutralise them so consecutive identical boards hash equal.
  normalize_rules = jsonb_build_array(
    jsonb_build_object('pattern', '"lastUpdate":"[^"]*"', 'replacement', '"lastUpdate":""'),
    jsonb_build_object('pattern', '"updatedAt":"[^"]*"', 'replacement', '"updatedAt":""')
  ),
  robots_status = 'allowed',
  active = true,
  -- The content shape changed (portal JSON → Mubasher JSON); clear the stale hash so
  -- the next poll is treated as changed and re-snapshots/parses cleanly.
  last_content_hash = null,
  last_changed_at = null
where s.venue = 'TDWL'
  and s.data_type = 'quotes';

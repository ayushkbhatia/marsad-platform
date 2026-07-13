-- 0022_activate_yahoo — flip the Yahoo cross-check + backfill sources LIVE.
--
-- Yahoo Finance becomes the live SECOND cross-check source + the ≥2y OHLCV backfill drain for
-- TDWL/QE/DFM (CONTRACT §7, 02-data-lake.md). Migration 0021 seeded the 6 Yahoo rows
-- (3 × 'quotes' cross-check + 3 × 'ohlcv_backfill') and their schedules active=false, because the
-- runtime resolved a source's parser purely by (venue, data_type) and would have dispatched a Yahoo
-- 'quotes' row to the WRONG (primary) parser, and had no branch for 'ohlcv_backfill' at all.
--
-- The provider-routing code has now landed (ingestion/src/runtime.ts, worker/src/ingest-poller.ts):
--   * runtime.tasksForSource is provider-aware — a source with endpoint_config.provider='yahoo'
--     resolves to the Yahoo quotes / ohlcvBackfill TaskSpec (the aggregator tasks), never the
--     primary (venue,data_type) adapter.
--   * the worker poller maps data_type 'ohlcv_backfill' → the quote_poll handler (source-scoped,
--     provider-agnostic), so the Yahoo backfill task runs through the existing snapshot → parse →
--     OHLCV staging → cross-check path.
--   * the runtime populates endpoint_config.symbols per cycle from public.securities (Yahoo symbols
--     via toYahooSymbol) so the per-symbol v8/chart sweep tracks the live securities master.
-- With that in place it is safe to activate the Yahoo rows.
--
-- CADENCE (unchanged from 0021, restated): Yahoo 'quotes' are session_only=true, cadence 1440 —
-- ONE sweep per trading day per venue as the cross-check partner (stays inside ≤300 req/day/host
-- across ~200+ symbols). Session-only ⇒ they first fire at the next GCC market open (validate Tue
-- ~10:00 GST). 'ohlcv_backfill' is session_only=false, cadence 1440 — a coarse drain that begins
-- immediately at the next ingest-tick.
--
-- IDEMPOTENT: keyed on endpoint_config->>'provider'='yahoo' for sources, and the schedules of those
-- sources. Re-running only ever sets active=true on rows that are already Yahoo rows; a WHERE guard
-- on active=false keeps the write a true no-op on re-run. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Activate the Yahoo ingest.sources rows (the 3 'quotes' + 3 'ohlcv_backfill' seeded by 0021).
update ingest.sources
   set active = true
 where endpoint_config->>'provider' = 'yahoo'
   and active = false;

-- ---------------------------------------------------------------------------
-- 2. Activate the matching ingest.schedules rows (one per Yahoo source). Keyed on the source's
--    provider discriminant via the FK, so it targets ONLY the Yahoo schedules and never a primary
--    source's schedule.
update ingest.schedules sc
   set active = true
  from ingest.sources s
 where sc.source_id = s.id
   and s.endpoint_config->>'provider' = 'yahoo'
   and sc.active = false;

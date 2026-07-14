-- 0042_mubasher_deep_ohlcv_tdwl_dfm_qe — switch TDWL/DFM/QE OHLCV backfill from Yahoo (2y wall) to the
-- Mubasher historical CSV (full listing history), and re-open the stale ADX names.
--
-- WHY: Yahoo chart range=2y capped TDWL/DFM/QE at ~2 years / ~500 daily bars. A live probe of Mubasher
-- (the SAME plain-HTTP aggregator we already use for ADX price history + TDWL quotes) returns the FULL
-- daily series for these venues under our exact tickers — e.g. TDWL 1120 (Al Rajhi) 1993→now (~8,900
-- bars), TDWL 2010 (SABIC) 1993→now, DFM EMAAR 2000→now (~6,900 bars), DFM DIB 2000→now, QE QNBK 2006→now.
-- That is 20–33 years vs Yahoo's 2, from a source already in production — no new provider code, no new
-- egress surface, no new licensing posture (identical to the ADX Mubasher-CSV route, migration 0033).
--
-- Also: the 12 "stale" ADX series (EAND, ADCB, … frozen years ago) are NOT delistings — all trade today
-- and Mubasher currently serves their full current history. They froze because the FIRST backfill fetch
-- returned a truncated CSV and the coverage guard (0041) then stamped them done. Re-opening their flag
-- lets the guard re-drain them against the now-correct Mubasher data (the objectifier's not-exists guard
-- only inserts the missing newer bars, so it extends each series to the current close).
--
-- Mechanism reuse: the mubasher_csv provider (runtime.tasksForProvider + withMubasherCsvSymbols) is
-- venue-generic — the venue travels on each source row — so this is a pure ingest.sources/schedules seed
-- + a coverage-flag reset. No worker code changes.

set search_path = '';

-- 1. Clone the ADX Mubasher-CSV ohlcv_backfill source for TDWL/DFM/QE, swapping only the venue in the
--    stock-page URL template. entry_url (the shared static CSV host) and every other knob (headers,
--    hashPattern, csvUrlTemplate, fetch_concurrency, provider) are inherited verbatim. Guarded so a
--    re-run / from-scratch apply never double-seeds.
insert into ingest.sources (venue, data_type, entry_url, endpoint_config, normalize_rules, transport, robots_status, active, consecutive_failures)
select v.venue, 'ohlcv_backfill', src.entry_url,
       jsonb_set(src.endpoint_config, '{pageUrlTemplate}',
                 to_jsonb('https://english.mubasher.info/markets/' || v.venue || '/stocks/{symbol}'::text)),
       src.normalize_rules, src.transport, src.robots_status, true, 0
from ingest.sources src
cross join (values ('TDWL'), ('DFM'), ('QE')) as v(venue)
where src.venue = 'ADX' and src.data_type = 'ohlcv_backfill'
  and src.endpoint_config->>'provider' = 'mubasher_csv'
  and not exists (
    select 1 from ingest.sources ex
    where ex.venue = v.venue and ex.data_type = 'ohlcv_backfill'
      and ex.endpoint_config->>'provider' = 'mubasher_csv'
  );

-- 2. Schedule each new Mubasher backfill source (daily coarse drain, mirroring the ADX schedule; the
--    coverage guard 0041 makes it idle once a venue is fully seeded). Staggered offsets so the three do
--    not all fire in the same minute.
insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes, active)
select s.id, 1440, false, 15 + (row_number() over (order by s.venue)) * 5, true
from ingest.sources s
where s.data_type = 'ohlcv_backfill' and s.venue in ('TDWL', 'DFM', 'QE')
  and s.endpoint_config->>'provider' = 'mubasher_csv'
  and not exists (select 1 from ingest.schedules sc where sc.source_id = s.id);

-- 3. Retire the Yahoo 2y backfill for these three venues (source + schedule). Yahoo QUOTES sources stay
--    active — Yahoo remains the live 2-source cross-check; only the shallow backfill is superseded.
update ingest.schedules set active = false
 where source_id in (
   select id from ingest.sources
   where data_type = 'ohlcv_backfill' and venue in ('TDWL', 'DFM', 'QE')
     and endpoint_config->>'provider' = 'yahoo');

update ingest.sources set active = false
 where data_type = 'ohlcv_backfill' and venue in ('TDWL', 'DFM', 'QE')
   and endpoint_config->>'provider' = 'yahoo';

-- NOTE: re-opening the coverage flag (securities.ohlcv_backfilled_at = null) to trigger the deep
-- Mubasher re-drain is done as a SEPARATE, validated operational rollout (small sample per venue first,
-- confirm deep bars land, then the rest) — NOT in this migration, so a from-scratch reset never mass-clears
-- flags and prod re-backfill can be staged. The affected set: all TDWL/DFM/QE listed securities, plus the
-- 12 stale ADX names (EAND, EMSTEEL, AGTHIA, ALDAR, ADCB, DANA, ANAN, ESG, ADNH, ADIB, AMR, ADNHC).

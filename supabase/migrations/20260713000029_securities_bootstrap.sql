-- 0029_securities_bootstrap — populate public.securities NOW so ohlcv is testable
-- tonight (P1.7a). 07-lake-enrichment.md P1.7a §3 (securities_bootstrap).
--
-- WHY: public.securities is EMPTY, and it blocks everything downstream —
--   • the Yahoo runtime reads securities to build its per-symbol backfill sweep,
--   • cross-check resolves (venue_code, ticker) → securities.id to stamp
--     lake.objects.security_id (NULL id ⇒ the 0028 OHLCV trigger skips the bar),
--   • the ohlcv_daily FK requires the security row to exist first.
-- The quote parsers only RESOLVE (venue,ticker)→id and drop unmatched rows; they
-- never INSERT securities. The Tue-market-open population is both too slow and does
-- not actually create rows. So a one-off bootstrap loader is required regardless.
--
-- SOURCE: the Mubasher full-market endpoint (single family, all 6 venues, plain
-- HTTP, no auth), fetched by the worker through the rotating IPRoyal proxy and
-- handed to this function as a JSONB array:
--   GET https://english.mubasher.info/api/1/stocks/prices?country={sa|ae|qa|om|bh}
--   → { lastUpdate, prices: [ { exchange, name, code, value, open, high, low, volume, ... } ] }
-- (country=ae returns BOTH ADX and DFM — split on the per-row `exchange`, never
-- assume one venue per country.)
--
-- This is a SEED function (idempotent upsert), not a recurring source. A proper
-- securities ingest source belongs in P2; tonight this validates the whole
-- ohlcv path end-to-end without waiting for Tuesday.

set search_path = '';

-- ---------------------------------------------------------------------------
-- Placeholder sector. securities.sector is NOT NULL references sectors(key) and
-- the Mubasher list endpoint carries no sector; bootstrap rows land under
-- 'unknown' and P1.7b/e backfills real sectors from the Mubasher /profile page.
insert into public.sectors (key, name, sort_order)
values ('unknown', 'Unknown / Unclassified', 999)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- bootstrap_securities_from_board(p_rows jsonb) → int (rows upserted)
--
-- p_rows is the Mubasher `prices` array (or the concatenation of several country
-- pages). Each element must carry at least { exchange, code, name }. The function:
--   • maps Mubasher `exchange` → our venue_code (TDWL/DFM/ADX/QE/MSX/BHB),
--   • derives currency from public.venues (never hardcoded per row),
--   • upserts on the (venue_code, ticker) unique key,
--   • leaves shares_outstanding NULL (backfilled later — market_cap/per-share
--     ratios stay null until it lands, which is fine for Momentum: price only),
--   • sets status='listed', sector='unknown'.
-- Rows with an unrecognized exchange or a blank code/name are skipped (not fatal).
-- Idempotent: re-running refreshes name_en for existing rows, inserts new ones,
-- and never overwrites a curated sector/shares_outstanding set by a later phase
-- (we only touch name_en + updated_at on conflict).

create or replace function public.bootstrap_securities_from_board(p_rows jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  with raw as (
    select
      upper(trim(elem ->> 'exchange')) as exchange_raw,
      trim(elem ->> 'code')            as ticker,
      trim(elem ->> 'name')            as name_en
    from jsonb_array_elements(p_rows) as elem
  ),
  mapped as (
    select
      case exchange_raw
        when 'TDWL' then 'TDWL'
        when 'DFM'  then 'DFM'
        when 'ADX'  then 'ADX'
        when 'QE'   then 'QE'
        when 'QSE'  then 'QE'    -- Mubasher has used both QE and QSE for Qatar
        when 'MSM'  then 'MSX'
        when 'MSX'  then 'MSX'
        when 'BB'   then 'BHB'
        when 'BHB'  then 'BHB'
        else null
      end as venue_code,
      ticker,
      name_en
    from raw
    where ticker is not null and ticker <> ''
      and name_en is not null and name_en <> ''
  ),
  resolved as (
    select m.venue_code, m.ticker, m.name_en, v.currency
    from mapped m
    join public.venues v on v.code = m.venue_code and v.is_active
    where m.venue_code is not null
  ),
  -- de-dupe within the batch (a ticker can appear once per venue)
  deduped as (
    select distinct on (venue_code, ticker) venue_code, ticker, name_en, currency
    from resolved
    order by venue_code, ticker, name_en
  ),
  upserted as (
    insert into public.securities (venue_code, ticker, name_en, sector, currency, status)
    select venue_code, ticker, name_en, 'unknown', currency, 'listed'
    from deduped
    on conflict (venue_code, ticker) do update set
      name_en    = excluded.name_en,
      updated_at = now()
    returning 1
  )
  select count(*)::int into v_count from upserted;
  return v_count;
end $$;

comment on function public.bootstrap_securities_from_board(jsonb) is
  'P1.7a one-off seed: upsert public.securities from a Mubasher stocks/prices `prices` '
  'array (all 6 venues). Idempotent on (venue_code, ticker). sector=unknown, '
  'shares_outstanding NULL — backfilled by a later phase.';

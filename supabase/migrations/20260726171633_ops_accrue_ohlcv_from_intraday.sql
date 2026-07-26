-- 20260726171633 — ops.accrue_ohlcv_from_intraday: reconstruct a day's OHLCV bars from the
-- surviving intraday poll history, for disaster recovery when the quote-board accrual path
-- (public.accrue_ohlcv_from_quotes) missed a day.
--
-- WHY THIS EXISTS: accrue_ohlcv_from_quotes reads public.quotes_latest — a SNAPSHOT table
-- overwritten on every poll — so once a trading day passes it can never be re-accrued (a
-- re-invocation matches zero rows). The 2026-07-22..26 accrual outage (see 20260726171614)
-- lost 4 trading days that quotes_latest can no longer supply. public.quotes_intraday, however,
-- retains every poll, so the day's OHLC is reconstructable from it. This is the permanent
-- recovery lever for any future accrual gap, not a one-shot script.
--
-- Lives in `ops` (not `public`) precisely so it inherits 0014_rls.sql:64's blanket
-- `grant execute on all functions in schema ops to marsad_worker` — it structurally cannot
-- repeat the public-schema grant gap that caused the outage.

set search_path = '';

create or replace function ops.accrue_ohlcv_from_intraday(p_trade_date date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  with day_ticks as (
    select qi.security_id, qi.captured_at, qi.last, qi.volume
    from public.quotes_intraday qi
    join public.securities s on s.id = qi.security_id
    join public.venues v on v.code = s.venue_code
    where s.status = 'listed'
      and qi.last is not null
      -- venue-local trading day, same expression accrue_ohlcv_from_quotes uses
      and (qi.captured_at at time zone v.timezone)::date = p_trade_date
  ),
  bar as (
    select
      security_id,
      -- open = first poll of the day, close = last poll (ordered by capture time)
      (array_agg(last order by captured_at asc))[1]  as open,
      max(last)                                       as high,
      min(last)                                       as low,
      (array_agg(last order by captured_at desc))[1] as close,
      -- session volume is cumulative within the day, so the last (max) reading is the day total
      max(volume)                                     as volume
    from day_ticks
    group by security_id
  ),
  upserted as (
    insert into public.ohlcv_daily
      (security_id, trade_date, open, high, low, close, volume, value_traded)
    select b.security_id, p_trade_date, b.open, b.high, b.low, b.close, b.volume, null
    from bar b
    -- Additive only, identical contract to accrue_ohlcv_from_quotes: never overwrite a
    -- higher-fidelity (bulletin/Yahoo) bar for the same (security_id, trade_date).
    on conflict (security_id, trade_date) do nothing
    returning 1
  )
  select count(*)::int into v_count from upserted;
  return v_count;
end $$;

comment on function ops.accrue_ohlcv_from_intraday(date) is
  'Disaster-recovery OHLCV accrual: rebuild p_trade_date bars from public.quotes_intraday when '
  'the quotes_latest snapshot is gone. LOWEST-FIDELITY source in the system — intraday polls are '
  '~10 min apart (10-20/day), so open is 5-25 min late and high/low understate the true session '
  'range. ADDITIVE ONLY (on conflict do nothing): a later venue-bulletin/Mubasher bar still '
  'overwrites these via the lake.objects->ohlcv_daily trigger (path a), so the approximation is '
  'not permanent. Idempotent on (security_id, trade_date).';

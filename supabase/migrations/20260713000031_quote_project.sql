-- 0031_quote_project — project QUOTE.LAST lake.objects → public.quotes_latest + quotes_intraday.
--
-- THE GAP THIS CLOSES (found 2026-07-14, live-verified): the quotes pipeline runs end to end —
-- fetch → parse → QUOTE.LAST staging → cross_check → lake.objects(QUOTE.LAST) — but NOTHING
-- projected those objects into the serving tables. public.quotes_latest and public.quotes_intraday
-- were EMPTY all-time for every venue despite thousands of quotes parsed (3k+ QUOTE.LAST staging
-- rows, 100+ objects). The OHLCV path got its object→serving projection in 0028
-- (fn_ohlcv_daily_project); the QUOTE equivalent was simply never built. Consequences: (1) the reader
-- has no live price; (2) accrue_ohlcv_from_quotes (0028 path-b) reads quotes_latest, so the ENTIRE
-- EOD accrual accrues ZERO bars for all 6 venues. This projection is the true gate — mirror 0028.
--
-- Source object: QUOTE.LAST, natural_key QUOTE.LAST:{venue}:{ticker}:{session-date} — ONE per security
-- per trading day, UPDATED as new intraday quotes fold in (runtime.mapQuote). payload is the
-- NormalizedQuote (camelCase: last/change/changePct/open/high/low/volume/asOf/week52High/week52Low);
-- numeric_value = last; effective_date = session date.
--
-- Single-source honesty: quotes are single-source until the Yahoo cross-check partner lands, so the
-- object is usually PENDING. Project PENDING+VERIFIED on INSERT+UPDATE (like OHLCV; owner D-src-1), so
-- a lone board quote still serves and a later 2nd source converges for free.

set search_path = '';

create or replace function lake.fn_quote_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.object_type <> 'QUOTE.LAST' then return null; end if;
  if new.security_id is null then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.numeric_value is null then return null; end if;

  -- Latest-per-security serving row. Only advance when this print is at least as recent as the stored
  -- one, so an out-of-order re-projection can't overwrite a newer quote with a stale value.
  insert into public.quotes_latest
    (security_id, as_of, captured_at, delay_minutes, last, change, change_pct,
     open, high, low, volume, week52_high, week52_low)
  values (
    new.security_id,
    coalesce(nullif(new.payload ->> 'asOf','')::timestamptz, now()),
    now(),
    15,                                    -- delayed-data floor; per-venue delay refined later
    new.numeric_value,
    nullif(new.payload ->> 'change','')::numeric,
    nullif(new.payload ->> 'changePct','')::numeric,
    nullif(new.payload ->> 'open','')::numeric,
    nullif(new.payload ->> 'high','')::numeric,
    nullif(new.payload ->> 'low','')::numeric,
    nullif(new.payload ->> 'volume','')::numeric,
    nullif(new.payload ->> 'week52High','')::numeric,
    nullif(new.payload ->> 'week52Low','')::numeric
  )
  on conflict (security_id) do update set
    as_of         = excluded.as_of,
    captured_at   = excluded.captured_at,
    delay_minutes = excluded.delay_minutes,
    last          = excluded.last,
    change        = excluded.change,
    change_pct    = excluded.change_pct,
    open          = excluded.open,
    high          = excluded.high,
    low           = excluded.low,
    volume        = excluded.volume,
    week52_high   = excluded.week52_high,
    week52_low    = excluded.week52_low
  where excluded.as_of >= public.quotes_latest.as_of;

  -- Intraday tick (PK security_id, captured_at). do nothing on a rare same-instant collision.
  insert into public.quotes_intraday (security_id, captured_at, last, change_pct, volume)
  values (
    new.security_id,
    now(),
    new.numeric_value,
    nullif(new.payload ->> 'changePct','')::numeric,
    nullif(new.payload ->> 'volume','')::numeric
  )
  on conflict (security_id, captured_at) do nothing;

  return null;
end $$;

drop trigger if exists objects_quote_project_ins on lake.objects;
create trigger objects_quote_project_ins after insert on lake.objects
  for each row when (new.object_type = 'QUOTE.LAST')
  execute function lake.fn_quote_project();

drop trigger if exists objects_quote_project_upd on lake.objects;
create trigger objects_quote_project_upd after update on lake.objects
  for each row when (new.object_type = 'QUOTE.LAST')
  execute function lake.fn_quote_project();

-- One-time backfill of quotes_latest from the QUOTE.LAST objects that already exist (created before
-- this trigger). DISTINCT ON picks the most-recent object per security so the single INSERT never
-- hits a same-security PK conflict twice. Idempotent. (Intraday is NOT backfilled — it accrues going
-- forward from new quotes; historical intraday ticks are not reconstructable from per-session objects.)
insert into public.quotes_latest
  (security_id, as_of, captured_at, delay_minutes, last, change, change_pct,
   open, high, low, volume, week52_high, week52_low)
select distinct on (o.security_id)
  o.security_id,
  coalesce(nullif(o.payload ->> 'asOf','')::timestamptz, o.created_at),
  now(), 15, o.numeric_value,
  nullif(o.payload ->> 'change','')::numeric,
  nullif(o.payload ->> 'changePct','')::numeric,
  nullif(o.payload ->> 'open','')::numeric,
  nullif(o.payload ->> 'high','')::numeric,
  nullif(o.payload ->> 'low','')::numeric,
  nullif(o.payload ->> 'volume','')::numeric,
  nullif(o.payload ->> 'week52High','')::numeric,
  nullif(o.payload ->> 'week52Low','')::numeric
from lake.objects o
where o.object_type = 'QUOTE.LAST'
  and o.security_id is not null
  and o.state in ('PENDING','VERIFIED')
  and o.numeric_value is not null
  and o.superseded_by is null
order by o.security_id, coalesce(nullif(o.payload ->> 'asOf','')::timestamptz, o.created_at) desc
on conflict (security_id) do update set
  as_of = excluded.as_of, captured_at = excluded.captured_at, last = excluded.last,
  change = excluded.change, change_pct = excluded.change_pct, open = excluded.open,
  high = excluded.high, low = excluded.low, volume = excluded.volume,
  week52_high = excluded.week52_high, week52_low = excluded.week52_low
where excluded.as_of >= public.quotes_latest.as_of;

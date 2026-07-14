-- 0041_ohlcv_backfill_coverage_flag — a sticky per-security "backfilled" flag so the ≥2y OHLCV
-- backfill GRACEFULLY STOPS once a venue is fully seeded (only EOD accrual + intraday quotes carry the
-- lake forward henceforth).
--
-- THE PROBLEM: the ohlcv_backfill schedules are cadence 1440 / active=true and the symbol injectors
-- (runtime.withYahooSymbols / withMubasherCsvSymbols / withMsxHistorySymbols) inject the FULL listed
-- universe every run — so a fully-backfilled venue re-fetches all ~N securities' entire history daily,
-- forever, to gain one new bar each (which EOD accrual, 0028, already produces). No completion state.
--
-- WHY A STICKY FLAG, NOT A DAY-COUNT THRESHOLD: a backfill fetch is ATOMIC — one range=2y GET returns
-- the provider's ENTIRE available window (≈2y for a mature stock, or a young listing's full short
-- history — "as many days as feasible per the provider"). So a security backfilled ONCE already holds
-- as much history as Yahoo/Mubasher/MSX will ever give. A hard "has N days of history" rule is both too
-- shallow (would stop a stock at N days even though 2y is available) and wrong for young listings; a
-- one-shot completion flag captures "provider delivered" exactly, with no magic number.
--
-- HOW: securities.ohlcv_backfilled_at, set the moment the bulk objectifier lands a security's backfill
-- bars. runtime.listedTickersForVenue then injects only `ohlcv_backfilled_at is null` securities for the
-- ohlcv_backfill data_type; when every listed security is stamped the injected list is empty and
-- runTask skips the fetch (graceful stop). Quotes are never coverage-filtered. A new listing (flag null)
-- or a manual reset (set back to null) re-opens backfill for that security only.

set search_path = '';

-- 1. The flag.
alter table public.securities add column if not exists ohlcv_backfilled_at timestamptz;

-- 2. Retro-stamp every already-backfilled security. A live lake.objects OHLCV.CLOSE row means the
--    security has been objectified from a price source (bulk backfill OR the earlier cross_check path) —
--    EOD accrual (0028) writes straight to public.ohlcv_daily and NEVER creates a lake.object, so this
--    is a precise "has backfilled history" signal at any depth (shallow young listings included). One-
--    time; idempotent.
update public.securities s
   set ohlcv_backfilled_at = now()
 where s.ohlcv_backfilled_at is null
   and exists (
     select 1 from lake.objects o
     where o.security_id = s.id
       and o.object_type = 'OHLCV.CLOSE'
       and o.superseded_by is null
   );

-- 3. Objectifier now stamps ohlcv_backfilled_at for every security whose backfill bars it lands. The
--    insert becomes a data-modifying CTE so the stamp keys on the ACTUAL inserted security_ids (via
--    RETURNING) — no table scan, and it fires exactly once per security (guarded by is null). Everything
--    else (advisory lock, parse_run lineage, batch selection, on-conflict race guard) is unchanged.
create or replace function ops.objectify_ohlcv_backfill(p_limit int default 5000)
  returns int
  language plpgsql
  security definer
  set search_path to ''
as $$
declare
  v_agent uuid;
  v_parse_run bigint;
  v_inserted int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('ops.objectify_ohlcv_backfill')::bigint) then
    return 0;
  end if;

  select id into v_agent from iam.principals where handle = 'SYSTEM' limit 1;
  if v_agent is null then
    raise exception 'objectify_ohlcv_backfill: SYSTEM principal not found';
  end if;

  insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
  values (v_agent, 'ohlcv_bulk', '1', 'running')
  returning id into v_parse_run;

  -- ins: the batch insert (unchanged), returning the security_id of each landed bar.
  -- stamp: mark those securities backfilled. A data-modifying CTE always runs to completion even though
  -- the primary query only counts ins, so the stamp fires without being selected.
  with batch as (
    select distinct on (sr.natural_key)
           sr.natural_key,
           sr.venue_code,
           sr.payload,
           sr.numeric_value,
           sr.effective_date,
           sr.price_sensitive,
           sr.source_rank,
           (sr.payload ->> 'unit')   as unit,
           (sr.payload ->> 'ticker') as ticker
    from lake.staging_rows sr
    join ingest.sources src on src.id = sr.source_id
    where src.data_type = 'ohlcv_backfill'
      and sr.object_type = 'OHLCV.CLOSE'
      and sr.consumed_at is null
      and not exists (
        select 1 from lake.objects o
        where o.natural_key = sr.natural_key and o.superseded_by is null
      )
    order by sr.natural_key, sr.source_rank asc, sr.id asc
    limit p_limit
  ),
  ins as (
    insert into lake.objects (
      object_type, natural_key, security_id, venue_code, payload,
      numeric_value, unit, effective_date, state, revision,
      parse_run_id, source_rank, price_sensitive
    )
    select 'OHLCV.CLOSE', b.natural_key, sec.id, b.venue_code, b.payload,
           b.numeric_value, b.unit, b.effective_date, 'PENDING', 1,
           v_parse_run, b.source_rank, b.price_sensitive
    from batch b
    left join public.securities sec
      on sec.venue_code = b.venue_code and sec.ticker = b.ticker
    on conflict (natural_key, revision) do nothing
    returning security_id
  ),
  stamp as (
    update public.securities s
       set ohlcv_backfilled_at = now()
     where s.ohlcv_backfilled_at is null
       and s.id in (select security_id from ins where security_id is not null)
    returning 1
  )
  select count(*) into v_inserted from ins;

  update lake.parse_runs
     set status = 'succeeded', finished_at = now(), objects_created = v_inserted
   where id = v_parse_run;

  return v_inserted;
end $$;

grant execute on function ops.objectify_ohlcv_backfill(int) to marsad_worker;

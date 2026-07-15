-- 20260715145325_restore_ohlcv_backfill_stamp — fix a regression introduced by 20260715080537
-- (throttle_crosscheck_idle_ohlcv_bulk, "0045"): its create-or-replace of ops.objectify_ohlcv_backfill
-- was based on the 0040 body and DROPPED the ohlcv_backfilled_at stamp CTE that 0041
-- (ohlcv_backfill_coverage_flag) had added.
--
-- OBSERVED BLAST RADIUS (2026-07-15): the coverage guard (runtime.listedTickersForVenue, chunk size 25,
-- `ohlcv_backfilled_at is null`, order by ticker) kept re-injecting the SAME first-25 chunk because no
-- security ever got stamped. MSX backfill (source 26) landed 66k bars for 25 securities with 0 stamped —
-- 307 self-chained jobs / 2,150 fetches in 24h fetching the same 25 tickers on repeat, never advancing
-- to the remaining listed securities and never emptying.
--
-- THE FIX: recreate the function merging BOTH behaviors verbatim —
--   • 0045's self-gate early-return (no parse_run churn when no un-objectified backfill bar is pending);
--   • 0041's data-modifying `stamp` CTE keyed on the insert's RETURNING security_id (fires exactly once
--     per security, no table scan).
-- Then retro-stamp securities that already hold live OHLCV.CLOSE lake.objects (same idempotent update as
-- 0041 step 2) so already-landed venues (the stuck MSX 25 included) exit the injector immediately.

set search_path = '';

-- 1. ops.objectify_ohlcv_backfill = 0045 self-gate + 0041 stamp CTE. Everything else (advisory lock,
--    SYSTEM lineage, batch selection, on-conflict race guard) carried forward unchanged.
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
  -- Single-flight: if a prior tick is still running (a big batch under load), skip rather than overlap.
  if not pg_try_advisory_xact_lock(hashtext('ops.objectify_ohlcv_backfill')::bigint) then
    return 0;
  end if;

  -- Self-gate (0045): no un-objectified backfill bar pending ⇒ do nothing. No parse_run, no churn. Every
  -- venue whose backfill is drained makes this a cheap existence check; it auto-wakes when remaining-ADX,
  -- MSX or BHB backfill staging lands. Same predicate as the batch CTE below, so it is exact.
  if not exists (
    select 1
    from lake.staging_rows sr
    join ingest.sources src on src.id = sr.source_id
    where src.data_type = 'ohlcv_backfill'
      and sr.object_type = 'OHLCV.CLOSE'
      and sr.consumed_at is null
      and not exists (
        select 1 from lake.objects o
        where o.natural_key = sr.natural_key and o.superseded_by is null
      )
  ) then
    return 0;
  end if;

  -- SYSTEM is the documented actor for auto/cron flows (iam seed 0002), same verifier cross_check uses.
  select id into v_agent from iam.principals where handle = 'SYSTEM' limit 1;
  if v_agent is null then
    raise exception 'objectify_ohlcv_backfill: SYSTEM principal not found';
  end if;

  -- One parse_run per batch for lineage (lake.objects.parse_run_id is NOT NULL).
  insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
  values (v_agent, 'ohlcv_bulk', '1', 'running')
  returning id into v_parse_run;

  -- ins: the batch insert (unchanged), returning the security_id of each landed bar.
  -- stamp: mark those securities backfilled (0041). A data-modifying CTE always runs to completion even
  -- though the primary query only counts ins, so the stamp fires without being selected.
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

-- 2. Retro-stamp every security whose backfill bars landed while the stamp was missing (identical
--    idempotent update to 0041 step 2 — a live OHLCV.CLOSE lake.object is a precise "has backfilled
--    history" signal; EOD accrual never creates lake.objects).
update public.securities s
   set ohlcv_backfilled_at = now()
 where s.ohlcv_backfilled_at is null
   and exists (
     select 1 from lake.objects o
     where o.security_id = s.id
       and o.object_type = 'OHLCV.CLOSE'
       and o.superseded_by is null
   );

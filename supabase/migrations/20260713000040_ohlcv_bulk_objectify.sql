-- 0037_ohlcv_bulk_objectify — drain the OHLCV backfill set-based, out of the per-key cross_check path.
--
-- THE PROBLEM (throughput, found 2026-07-14): the OHLCV price backfill is ~95% of the q_pipeline
-- backlog (TDWL 125k + DFM 11k + QE 15k `OHLCV.CLOSE`). Every bar is routed through cross_check, which
-- runs ~8 sequential statements inside one transaction per key. The worker (Hetzner/EU) talks to the DB
-- (ap-south-1/Mumbai) at ~140ms RTT, so each key costs ~1.1s of almost-pure network wait; the pool caps
-- useful concurrency at ~12, pinning drain at ~325 msg/min against a 500/min enqueue rate — the queue
-- diverges and the backfill would take ~8h to materialize (TDWL never, before 0036's fairness fix).
--
-- THE INSIGHT: a backfill bar is single-source FOREVER (0032) — it can never cross-check against a 2nd
-- source, so the entire 2-source machinery is dead weight for it. All it needs is one INSERT into
-- lake.objects; the existing AFTER-INSERT triggers do the rest IN-PROCESS (no client round-trips):
--   • fn_ohlcv_daily_project (0028) → upsert public.ohlcv_daily (the reader bar)
--   • fn_consume_ohlcv_backfill_staging (0032) → consume the backfill staging rows for the key
--
-- THE FIX (two coupled changes):
--   (1) ops.objectify_ohlcv_backfill — a set-based objectifier: one INSERT ... SELECT lands up to
--       p_limit backfill bars per call, firing the triggers per row server-side. A 10k-row batch is ONE
--       client round-trip instead of 80k, so RTT stops mattering. Runs as its OWN pg_cron job (in-DB,
--       zero worker hops). Drains the ~150k backlog in minutes, not hours.
--   (2) enqueue_crosscheck_sweep stops enqueuing `ohlcv_backfill` OHLCV.CLOSE keys — they are handled by
--       (1) now. eod_bulletin-sourced OHLCV.CLOSE is UNTOUCHED (still cross-checked for the legitimate
--       Yahoo-vs-bulletin 2-source verify), exactly matching 0032's source scoping. cross_check remains
--       the path for every genuinely multi-source fact (quotes, filings, dividends).
--
-- Safety: the objectifier is idempotent. It skips keys that already have a live object (guard) and uses
-- `on conflict (natural_key, revision) do nothing` (one_live_per_key) so a race with an in-flight
-- cross_check message for the same key can never double-insert — the loser no-ops. An in-flight
-- cross_check that arrives after the bulk insert finds its staging already consumed (0032 trigger) →
-- gathers zero candidates → returns the live object, no write. security_id resolution and payload
-- passthrough are identical to cross_check.insertObject, so the 0028 projection sees identical input.

set search_path = '';

-- ── (1) set-based objectifier ────────────────────────────────────────────────────────────────────────
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
  -- xact-scoped, so it auto-releases when this function's implicit transaction ends.
  if not pg_try_advisory_xact_lock(hashtext('ops.objectify_ohlcv_backfill')::bigint) then
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

  -- Set-based insert. distinct on (natural_key) picks the primary source row per key (lowest
  -- source_rank, then id) — mirrors cross_check.winnerRow. The `not exists` guard skips keys already
  -- objectified; `on conflict` guards the concurrent-insert race. Every inserted row fires the 0028
  -- projection + 0032 consume triggers in-process.
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
  )
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
  on conflict (natural_key, revision) do nothing;

  get diagnostics v_inserted = row_count;

  update lake.parse_runs
     set status = 'succeeded', finished_at = now(), objects_created = v_inserted
   where id = v_parse_run;

  return v_inserted;
end $$;

grant execute on function ops.objectify_ohlcv_backfill(int) to marsad_worker;

-- Own pg_cron job. Every minute (pg_cron floor); the advisory lock makes an over-running batch skip the
-- next tick instead of piling up. 10k/tick drains the ~150k backfill backlog in ~15 min. Heartbeat so
-- the sentinel sees it alive.
select cron.schedule('ohlcv_bulk_objectify', '* * * * *',
  $$select ops.objectify_ohlcv_backfill(10000); select ops.beat('ohlcv_bulk_objectify', 120);$$);

-- ── (2) sweep exclusion: stop enqueuing backfill OHLCV to cross_check ─────────────────────────────────
-- Carries forward 0036's fair per-venue round-robin + 0030's per-key cooldown verbatim; the ONLY change
-- is the added exclusion of `ohlcv_backfill` OHLCV.CLOSE keys (now handled by objectify_ohlcv_backfill).
create or replace function ops.enqueue_crosscheck_sweep(p_limit int default 500)
  returns int
  language plpgsql
  security definer
  set search_path to ''
as $$
declare
  v_count int := 0;
  v_cooldown constant interval := interval '5 minutes';
  r record;
begin
  for r in
    with eligible as (
      select sr.natural_key,
             sr.object_type,
             sr.venue_code,
             min(sr.ingested_at) as first_ingested
      from lake.staging_rows sr
      where sr.consumed_at is null
        and (sr.swept_at is null or sr.swept_at < now() - v_cooldown)
        -- Backfill OHLCV is drained set-based by ops.objectify_ohlcv_backfill (0037), NOT cross_check.
        -- eod_bulletin OHLCV stays in cross_check for the Yahoo-vs-bulletin 2-source verify (0032 scope).
        and not (
          sr.object_type = 'OHLCV.CLOSE'
          and exists (
            select 1 from ingest.sources src
            where src.id = sr.source_id and src.data_type = 'ohlcv_backfill'
          )
        )
        and not exists (
          select 1
          from lake.objects o
          where o.natural_key = sr.natural_key
            and o.superseded_by is null
            and o.created_at >= sr.ingested_at   -- a live object already reflects this evidence
        )
      group by sr.natural_key, sr.object_type, sr.venue_code
    ),
    ranked as (
      select natural_key,
             object_type,
             venue_code,
             row_number() over (
               partition by venue_code
               order by first_ingested, natural_key
             ) as rn
      from eligible
    )
    select natural_key, object_type
    from ranked
    order by rn, venue_code
    limit p_limit
  loop
    perform pgmq.send(
      'q_pipeline',
      jsonb_build_object('handler', 'cross_check',
                         'naturalKey', r.natural_key,
                         'objectType', r.object_type));
    update lake.staging_rows
       set swept_at = now()
     where natural_key = r.natural_key
       and object_type = r.object_type
       and consumed_at is null;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

grant execute on function ops.enqueue_crosscheck_sweep(int) to marsad_worker;

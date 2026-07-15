-- 20260715080537_throttle_crosscheck_idle_ohlcv_bulk — reclaim worker compute burned on no-op parse_runs.
-- (Sequential tag "0045" in comments below = next after main's 0043 adx_quotes / 0044; the real applied
--  version is this file's timestamp prefix, which is what the remote migration ledger recorded.)
--
-- THE PROBLEM (found 2026-07-15, deep-backfill now complete): two pg_cron lanes run hot with ~100% no-op
-- output, doing work that can never produce an object:
--
--   • crosscheck_sweep (0040): fires EVERY MINUTE, enqueues up to 500 staging keys → q_pipeline →
--     cross_check handler → parse_run. ~5,452 runs/day, 100% empty. Root cause: ~1,155 distinct staging
--     keys are STRUCTURALLY SINGLE-SOURCE — QUOTE.LAST (one venue feed each), FILING.REF (one venue each),
--     and eod_bulletin OHLCV.CLOSE whose 2nd (Yahoo) source never arrived. The 2-source rule can never be
--     satisfied for them, yet the 5-min cooldown re-qualifies them forever. They churn cross_check with
--     zero writes, and they never consume (verified: oldest unconsumed since 2026-07-13, never landed).
--
--   • ohlcv_bulk_objectify (0040): fires EVERY MINUTE draining ohlcv_backfill staging. Backfill for
--     TDWL/DFM/QE (and all but 14 ADX) is fully drained, so every tick finds nothing yet still opens +
--     closes a parse_run. ~450 no-op runs/day.
--
-- THE FIX (both are self-healing — no data dropped, no manual re-enable needed):
--   (1) enqueue_crosscheck_sweep: PARK a key once its oldest unconsumed evidence is older than
--       v_park_after AND it still has < 2 distinct sources. A parked key is simply not re-swept; the
--       instant a 2nd source lands (count(distinct source_id) >= 2) it re-qualifies automatically. Genuine
--       multi-source facts and anything younger than the grace window are swept exactly as before. This
--       mirrors 0040's ohlcv_backfill exclusion (single-source-forever ⇒ out of the 2-source machinery),
--       but generalized: it keys off "single-source AND aged" instead of an enumerated data_type, so
--       QUOTE.LAST / FILING.REF / stranded eod_bulletin OHLCV all stop churning without a type allowlist.
--   (2) crosscheck_sweep cadence 1 min → 5 min (matches the 5-min per-key cooldown — a tighter tick just
--       re-scanned the same cooled-down set). Heartbeat freshness widened 60 s → 300 s to match.
--   (3) objectify_ohlcv_backfill: SELF-GATE — return early (no parse_run) when no un-objectified backfill
--       bar is pending. The every-minute cron becomes a cheap existence check; it auto-wakes the moment
--       remaining-ADX / MSX / BHB backfill staging lands. Cadence unchanged.
--
-- Safety: (1) only stops RE-SWEEPING; it deletes nothing and cannot lose a verifiable fact — a parked key
-- resumes on its next source. (3) is guarded by the same advisory lock + idempotent guards as 0040; an
-- empty tick now short-circuits before touching lake.parse_runs. Everything else in both functions
-- (0039 fair per-venue rotation, 0030 cooldown, 0040 ohlcv exclusion, on-conflict race guard) is carried
-- forward verbatim.

set search_path = '';

-- ── (1)+(2) cross_check: park aged single-source keys, throttle the tick ──────────────────────────────
create or replace function ops.enqueue_crosscheck_sweep(p_limit int default 500)
  returns int
  language plpgsql
  security definer
  set search_path to ''
as $$
declare
  v_count int := 0;
  v_cooldown constant interval := interval '5 minutes';
  -- Park a still-single-source key once its OLDEST unconsumed row is older than this. The only object_type
  -- with a legitimate 2nd source is eod_bulletin OHLCV.CLOSE (venue bulletin vs Yahoo), and both land the
  -- SAME session within the close+30 sweep (~1-2h apart). 6h keeps a ~3x margin over that while parking
  -- the structurally-single-source long tail (QUOTE.LAST / FILING.REF) fast. A 2nd source re-qualifies a
  -- parked key on the next tick (self-healing) — widen this only if a >6h-apart 2-source type is added.
  v_park_after constant interval := interval '6 hours';
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
        -- Backfill OHLCV is drained set-based by ops.objectify_ohlcv_backfill (0040), NOT cross_check.
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
      -- PARK rule (0045): sweep only if a 2nd source exists (cross-checkable) OR the key is still within
      -- the grace window. Aged single-source keys are skipped until a 2nd source appears — at which point
      -- count(distinct source_id) >= 2 re-qualifies them on the very next tick (self-healing, no state).
      having count(distinct sr.source_id) >= 2
          or min(sr.ingested_at) > now() - v_park_after
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

-- Throttle the sweep tick 1 min → 5 min (== the per-key cooldown). cron.schedule upserts by jobname.
select cron.schedule('crosscheck_sweep', '*/5 * * * *',
  $$select ops.enqueue_crosscheck_sweep(); select ops.beat('crosscheck_sweep', 300);$$);

-- ── (3) ohlcv_bulk: self-gate when nothing is pending ─────────────────────────────────────────────────
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

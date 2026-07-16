-- 20260716100000_fleet_productivity_guard — soft auto-stop / auto-resume for ingest workers.
--
-- GOAL (owner ask): any scraper/worker producing NO incremental data-lake benefit should recognize
-- that and auto-stop — but SOFTLY (back off cadence), never a hard stop, and auto-resume the instant
-- real work returns. Applies fleet-wide to the cadence-driven ingest pollers.
--
-- DESIGN (verified by a multi-agent audit + adversarial review):
--  * BENEFIT PROXY: a run produced incremental lake benefit ⟺ it wrote ingest.fetch_log.changed=true
--    (a new snapshot / a landed filing PDF / a staged bar). Every dedup/skip/failure path writes
--    changed=false. This holds for quotes, filings_list, filing_detail (verified against the handlers).
--  * DERIVED IDLE (no trigger): consecutive_idle_runs = count of fetch_log rows since the source's last
--    changed=true row. Recomputed set-based inside enqueue_due_jobs each tick — IDEMPOTENT (the COUNT
--    self-resets to ~0 the moment a changed run lands), so there is no accumulator to double-count and
--    ZERO added load on the hot fetch_log INSERT path (the audit rejected an AFTER-INSERT trigger for
--    hot-path lock contention). source→schedule is 1:1 (verified), so per-source derivation is exact.
--  * BACKOFF: effective_cadence = base × least(max_mult, 2^floor(idle/3)). enqueue_due_jobs gates on the
--    EFFECTIVE cadence. Any changed=true collapses idle → base cadence next tick (auto-resume).
--    Event-driven wake-ups (filing_detail) are DIRECT job_queue inserts that bypass the schedule, so a
--    backed-off backstop still drains real work immediately.
--  * EXEMPTIONS: eod_bulletin (close-gate) and ohlcv_backfill (coverage guard) already soft-stop in the
--    handler and write no fetch_log on their planned skips — mark them backoff_exempt so the guard never
--    mis-scores them. Their handler gate IS the correct auto-stop.
--  * SENTINEL SAFETY (the confirmed HIGH bug): a backed-off source polls slower than its hardcoded
--    heartbeat window, which would trip a FALSE 'degraded' incident. ops.heartbeat_sentinel is made
--    session-aware + backoff-aware: it suppresses incidents for an ingest job whose venue is
--    session-closed OR whose matching schedule is currently backed off. A genuinely dead feed (not
--    backed off, session open) still alerts at 2× base cadence.
--
-- NO worker code changes, NO trigger. Pure SQL. Kill-switch: `update ingest.schedules set
-- max_backoff_mult=1` reverts every source to flat cadence with no deploy.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (1) Per-schedule backoff state. Defaults make an un-migrated schedule behave EXACTLY as today
--     (max_backoff_mult=1 ⇒ effective==base; the config seed in step 5 opts each class in).
alter table ingest.schedules
  add column if not exists consecutive_idle_runs int         not null default 0,
  add column if not exists last_benefit_at        timestamptz,
  add column if not exists max_backoff_mult        int         not null default 1,
  add column if not exists backoff_exempt          boolean     not null default false;

comment on column ingest.schedules.consecutive_idle_runs is
  'Runs since the source''s last changed=true fetch_log. Derived set-based by enqueue_due_jobs; self-resets on benefit.';
comment on column ingest.schedules.max_backoff_mult is
  'Cap on the cadence backoff multiplier. 1 = no backoff. Config-over-code: the Desk UPDATEs this row.';
comment on column ingest.schedules.backoff_exempt is
  'true for schedules whose idle is a planned handler gate (eod close-gate, ohlcv coverage), not real idleness.';

-- Supports the derived-idle lookback (max(fetched_at) where changed) as an index-only scan.
create index if not exists fetch_log_source_changed
  on ingest.fetch_log (source_id, fetched_at desc) where changed;

-- ---------------------------------------------------------------------------
-- (2) Effective-cadence helper — the SINGLE source of truth used by the scheduler AND the sentinel,
--     so backoff, the enqueue gate, and incident suppression can never disagree.
--     mult = least(cap, 2^floor(idle/3)), with the exponent bounded so the ::int cannot overflow on a
--     source that has been idle for hundreds of runs.
create or replace function ingest.effective_cadence_minutes(
  p_cadence_minutes int, p_idle int, p_max_mult int, p_exempt boolean
) returns int
language sql immutable set search_path = ''
as $$
  select case
    when p_exempt or coalesce(p_max_mult, 1) <= 1 or coalesce(p_idle, 0) < 3
      then p_cadence_minutes
    else p_cadence_minutes * least(
      p_max_mult,
      greatest(1, (2 ^ least(6, floor(coalesce(p_idle, 0) / 3.0)))::int)
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- (3) Backoff-aware scheduler. Reconcile derived idle, then gate on effective cadence.
create or replace function ingest.enqueue_due_jobs() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int := 0;
  r record;
begin
  -- Reconcile idle state (DERIVED, idempotent) for non-exempt schedules. idle = number of fetch_log
  -- rows since the source's last changed=true row; last_benefit = that row's time. Only write when the
  -- value actually changes (no WAL churn on a stable fleet).
  with derived as (
    select sc.id as schedule_id,
           (select max(fl.fetched_at) from ingest.fetch_log fl
              where fl.source_id = sc.source_id and fl.changed) as last_benefit,
           (select count(*)::int from ingest.fetch_log fl
              where fl.source_id = sc.source_id
                and fl.fetched_at > coalesce(
                  (select max(fl2.fetched_at) from ingest.fetch_log fl2
                     where fl2.source_id = sc.source_id and fl2.changed),
                  'epoch'::timestamptz)) as idle
    from ingest.schedules sc
    where sc.active and not sc.backoff_exempt
  )
  update ingest.schedules sc
     set consecutive_idle_runs = d.idle,
         last_benefit_at = d.last_benefit
    from derived d
   where d.schedule_id = sc.id
     and (sc.consecutive_idle_runs is distinct from d.idle
          or sc.last_benefit_at   is distinct from d.last_benefit);

  -- Gate + enqueue on EFFECTIVE cadence. Session-only sources skip off-hours WITHOUT touching
  -- last_enqueued_at (freezes backoff state → no weekend false-park, resumes cleanly on reopen).
  for r in
    select sc.id as schedule_id, sc.source_id, sc.session_only, sc.offset_minutes, s.venue
    from ingest.schedules sc
    join ingest.sources s on s.id = sc.source_id and s.active
    where sc.active
      and (sc.last_enqueued_at is null
           or now() - sc.last_enqueued_at >= make_interval(mins =>
                ingest.effective_cadence_minutes(sc.cadence_minutes, sc.consecutive_idle_runs,
                                                 sc.max_backoff_mult, sc.backoff_exempt)))
  loop
    if r.session_only
       and not ingest.venue_is_open(r.venue, now(), interval '10 minutes', interval '20 minutes') then
      continue;
    end if;
    insert into ingest.job_queue (source_id, run_after)
    values (r.source_id, now() + make_interval(mins => r.offset_minutes));
    update ingest.schedules set last_enqueued_at = now() where id = r.schedule_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- (4) Sentinel: never raise a false incident for an ingest job that is intentionally quiet — its venue
--     is session-closed, OR its matching schedule is currently backed off by the guard. The heartbeat
--     job_name is 'ingest:<kind>:<VENUE>'; map <kind> to the schedule's data_type so a backed-off
--     FILINGS schedule can never suppress a genuinely-dead QUOTES incident for the same venue.
create or replace function ops.heartbeat_sentinel() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into ops.incidents (severity, source, message)
  select 'degraded', 'job:' || h.job_name,
         'job ' || h.job_name || ' silent since ' || coalesce(h.last_run_at::text, 'never')
  from ops.job_heartbeats h
  where coalesce(h.last_run_at, 'epoch'::timestamptz) < now() - make_interval(secs => 2 * h.expected_interval_s)
    and not exists (select 1 from ops.incidents i
                    where i.source = 'job:' || h.job_name and i.resolved_at is null)
    and not (
      h.job_name like 'ingest:%'
      and exists (
        select 1
        from ingest.schedules sc
        join ingest.sources s on s.id = sc.source_id
        where s.venue = split_part(h.job_name, ':', 3)
          and sc.active
          and case split_part(h.job_name, ':', 2)
                when 'quote_poll'          then s.data_type in ('quotes','indices')
                when 'filings_poll'        then s.data_type = 'filings_list'
                when 'filings_detail_poll' then s.data_type = 'filing_detail'
                when 'eod_sweep'           then s.data_type = 'eod_bulletin'
                else false
              end
          and (
            (sc.session_only and not ingest.venue_is_open(s.venue, now(),
                                        interval '10 minutes', interval '20 minutes'))
            or ingest.effective_cadence_minutes(sc.cadence_minutes, sc.consecutive_idle_runs,
                                                sc.max_backoff_mult, sc.backoff_exempt) > sc.cadence_minutes
          )
      )
    );
end $$;

-- ---------------------------------------------------------------------------
-- (5) Config defaults by data_type (audit-recommended caps). Idempotent (re-run safe). Quotes protect
--     freshness (cap 2×); filings/detail back off harder (8×); eod/backfill are exempt (their handler
--     gate is the real auto-stop). A human overrides any single source from the Desk with one UPDATE.
update ingest.schedules sc
   set max_backoff_mult = v.mult,
       backoff_exempt   = v.exempt
from (values
  ('quotes',         2, false),
  ('indices',        2, false),
  ('filings_list',   8, false),
  ('filing_detail',  8, false),
  ('eod_bulletin',   1, true),
  ('ohlcv_backfill', 1, true)
) as v(data_type, mult, exempt)
join ingest.sources s on s.data_type = v.data_type
where s.id = sc.source_id
  and (sc.max_backoff_mult is distinct from v.mult or sc.backoff_exempt is distinct from v.exempt);

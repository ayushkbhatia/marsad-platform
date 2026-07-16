-- harden_ops_beat_interval_fix_crosscheck_sweep_cadence
--
-- The last standing false heartbeat incident (job:crosscheck_sweep, id 45, open
-- since 2026-07-15) has two coupled causes:
--   * ops.beat(job, interval_s)'s ON CONFLICT refreshed last_run_at/last_ok_at but
--     NEVER expected_interval_s. So when 20260715080537 changed the crosscheck_sweep
--     cron from '* * * * *' (ops.beat(...,60)) to '*/5 * * * *' (ops.beat(...,300)),
--     the heartbeat row kept the stale 60 s interval.
--   * ops.heartbeat_sentinel flags silence past 2× expected_interval = 120 s, but the
--     job now only beats every 300 s → the row is stale between every run → a
--     permanent false 'degraded' incident.
--
-- Fix:
--   (1) ops.beat now writes expected_interval_s = excluded on conflict, matching the
--       worker's heartbeatRun upsert (worker/src/handlers/job-heartbeat.ts). The cron
--       command IS the source of truth for its own cadence, so a future cadence change
--       self-propagates on the next beat instead of silently drifting. Only pure-SQL
--       crons call ops.beat, each with its correct current interval, so no other
--       registry row changes meaning.
--   (2) One-time correction so the row is fixed immediately, not on the next */5 tick.
--   (3) Resolve the false incident iff crosscheck is healthy under the 300 s window.
--
-- Pure SQL, idempotent.

set search_path = '';

-- (1) Self-healing interval. create-or-replace preserves the existing ACL; the grant
--     below is re-stated for parity with 0015 and is a no-op if already present.
create or replace function ops.beat(p_job text, p_interval_s int) returns void
language sql security definer set search_path = ''
as $$
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at)
  values (p_job, p_interval_s, now(), now())
  on conflict (job_name) do update
    set expected_interval_s = excluded.expected_interval_s,
        last_run_at = now(), last_ok_at = now(), consecutive_failures = 0;
$$;
grant execute on function ops.beat(text, int) to marsad_worker;

-- (2) Immediate correction (ops.beat's on-conflict would also fix it on the next */5
--     tick, but the sentinel runs every 10 min — don't wait).
update ops.job_heartbeats set expected_interval_s = 300
where job_name = 'crosscheck_sweep' and expected_interval_s <> 300;

-- (3) Resolve the false incident iff crosscheck is now within its corrected 2× window.
update ops.incidents i set resolved_at = now()
where i.source = 'job:crosscheck_sweep' and i.resolved_at is null
  and exists (
    select 1 from ops.job_heartbeats h
    where h.job_name = 'crosscheck_sweep'
      and coalesce(h.last_run_at, 'epoch'::timestamptz)
            >= now() - make_interval(secs => 2 * h.expected_interval_s)
  );

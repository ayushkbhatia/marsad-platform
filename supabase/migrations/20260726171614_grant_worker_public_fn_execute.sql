-- 20260726171614 — restore marsad_worker EXECUTE on the worker-called public.* RPCs,
-- and add a standing guard so a future REVOKE can never again silently lock the worker out.
--
-- ROOT CAUSE (fixed here): 20260722140000_sec_revoke_anon_mutation_and_desk_view.sql:17-18
-- ran `revoke execute ... from anon, authenticated, public`. The third grantee is the PUBLIC
-- pseudo-role, not the `public` schema. accrue_ohlcv_from_quotes / bootstrap_securities_from_board
-- had NO explicit `grant ... to marsad_worker` (0014_rls.sql:64 grants execute on all functions
-- for ingest/ops/analytics only — `public` is deliberately excluded), so both leaned on Postgres'
-- implicit EXECUTE-TO-PUBLIC default. Revoking PUBLIC therefore removed the worker's access, and
-- the nightly `ohlcv_accrual` job (cron.job id 23) began failing 2026-07-22 18:00 UTC with
-- `permission denied for function accrue_ohlcv_from_quotes` — freezing public.ohlcv_daily across
-- all 6 venues for 5 days while every other feed kept flowing.
--
-- Pattern followed: the same one-off grant already used for public.refresh_market_mvs (0014:65).

set search_path = '';

-- 1. Restore the two grants the 20260722140000 revoke stripped.
grant execute on function public.accrue_ohlcv_from_quotes(date)         to marsad_worker;
grant execute on function public.bootstrap_securities_from_board(jsonb) to marsad_worker;

-- ---------------------------------------------------------------------------
-- 2. Standing guard: assert the worker can execute every public.* function it
--    depends on. Because `public` is excluded from the blanket ops/ingest/analytics
--    function grant, each such function needs an explicit grant — an allow-list the
--    next security sweep must keep whole. This surfaces a violation on the SAME
--    silence→incident channel the sentinel already watches, instead of a 5-day
--    invisible outage.

-- Returns the worker-called public.* functions the marsad_worker role currently
-- CANNOT execute. Empty result = healthy.
create or replace function ops.check_worker_function_grants()
returns table (fn text)
language sql stable security definer set search_path = ''
as $$
  select f.fn
  from (values
    ('public.accrue_ohlcv_from_quotes(date)'),
    ('public.bootstrap_securities_from_board(jsonb)'),
    ('public.refresh_market_mvs()')
  ) as f(fn)
  where not has_function_privilege('marsad_worker', f.fn, 'EXECUTE');
$$;

comment on function ops.check_worker_function_grants() is
  'Guard for the 0014_rls public-schema grant gap: returns the allow-listed worker-called '
  'public.* functions marsad_worker currently lacks EXECUTE on. Empty = healthy. Extend the '
  'allow-list whenever the worker starts calling a new public.* SECURITY DEFINER function.';

-- Cron entrypoint: raise if any grant is missing so the job FAILS and never reaches
-- its beat — the file's own doctrine (0015_cron.sql:5-8): "a failed job never reaches
-- the beat, so silence still means failure", and ops.heartbeat_sentinel opens a
-- `job:worker_grant_check` incident after the expected interval lapses.
create or replace function ops.assert_worker_function_grants()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_missing text;
begin
  select string_agg(fn, ', ') into v_missing from ops.check_worker_function_grants();
  if v_missing is not null then
    raise exception 'marsad_worker missing EXECUTE on: %', v_missing;
  end if;
end $$;

grant execute on function ops.assert_worker_function_grants() to marsad_worker;

-- Daily at 22:00 UTC (02:00 GST), alongside the other nightly guards. Success beats
-- the heartbeat; a raise leaves it silent → incident. Registered below so the
-- sentinel knows the expected cadence from deploy.
select cron.schedule('worker_grant_check', '0 22 * * *',
  $$select ops.assert_worker_function_grants(); select ops.beat('worker_grant_check', 86400);$$);

insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
values ('worker_grant_check', 86400, now())
on conflict (job_name) do nothing;

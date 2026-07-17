-- Regression: ops.heartbeat_sentinel FAILURE rule + auto-resolve
-- (migration 20260717120000_failure_sentinel_job_health).
--
-- Pins the silent-failure blind spot observed live 2026-07-17: ingest:quote_poll:ADX ran
-- every ~24 min, failed every time, had not succeeded in 47 h, and raised NO incident —
-- because the sentinel keyed only on last_run_at, and the productivity guard's backoff
-- (caused BY the failures, since a failed fetch writes changed=false) additionally made
-- ops.ingest_job_expected_silent() return true. CASE F2 is that exact scenario.
--
-- Runs entirely inside a transaction against a synthetic venue 'ZY' and ROLLBACKs, so it
-- leaves zero trace and is safe against the live DB. Assertions RAISE EXCEPTION on failure
-- — a clean run (no error) is a pass.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/failure_sentinel_job_health.sql
--   or  Supabase MCP execute_sql with this whole file as one call.
--
-- Time-independent by construction, same trick as
-- heartbeat_sentinel_session_source_aware.sql: the synthetic venue's timezone is chosen so
-- its LOCAL now() is always ~12:MM, keeping fixed session windows clear of the midnight
-- wrap. Session variants are selected by swapping trading_days, never by wall-clock.

begin;

do $$
declare
  v_off_h   int := 12 - extract(hour from (now() at time zone 'UTC'))::int;
  v_tz      text;
  v_today   int;
  v_off_dow int;
  v_src_q   bigint;
  v_n       int;
  v_msg     text;
  v_reason  text;
begin
  v_tz := case when v_off_h = 0 then 'UTC'
               when v_off_h > 0 then 'Etc/GMT-' || v_off_h::text
               else                  'Etc/GMT+' || (-v_off_h)::text end;
  v_today   := extract(dow from (now() at time zone v_tz))::int;
  v_off_dow := (v_today + 3) % 7;

  insert into public.venues (code, name, country, timezone, currency, trading_days, is_active)
  values ('ZY', 'Failure Sentinel Test Venue', 'ZY', v_tz, 'USD', array[v_today], true);
  insert into public.market_sessions (venue_code, open_local, close_local, effective_from)
  values ('ZY', '01:00:00', '23:00:00', '2000-01-01');

  -- Active, in-session quotes source. NOT backed off yet (idle 0, cap 2).
  insert into ingest.sources (venue, data_type, entry_url, endpoint_config, transport, active)
  values ('ZY', 'quotes', 'http://x/quotes', '{}', 'http', true) returning id into v_src_q;
  insert into ingest.schedules (source_id, cadence_minutes, session_only, active,
                                consecutive_idle_runs, max_backoff_mult, backoff_exempt)
  values (v_src_q, 10, true, true, 0, 2, false);

  -- THE BLIND SPOT: last_run_at FRESH (the job is beating happily every cycle) but
  -- last_ok_at 47 h stale and 28 consecutive failures. This row is what ADX looked like.
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at,
                                  last_error, consecutive_failures)
  values ('ingest:quote_poll:ZY', 600, now() - interval '2 minutes', now() - interval '47 hours',
          'browserContext.newPage: Target page, context or browser has been closed', 28);

  -- CASE F1 — beating but failing MUST alert (the whole point). --------------------
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'F1 FAIL: fresh-last_run_at + 28 failures + stale last_ok_at must raise 1, got %', v_n;
  end if;
  -- The message must name the FAILING mode, not silence — a "silent" message for a job
  -- that is visibly running would send the on-call down the wrong path.
  select message into v_msg from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_msg not like '%FAILING%' or v_msg not like '%28 consecutive failures%' then
    raise exception 'F1 FAIL: message must report the failure mode + streak, got: %', v_msg;
  end if;
  update ops.incidents set resolved_at = now()
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;

  -- CASE F2 — THE REGRESSION: backed off AND failing MUST STILL alert. -------------
  -- A failed fetch writes changed=false → the guard reads that as "idle" → backs the
  -- source off → the OLD expected_silent() returned true → the alarm went quiet. Backoff
  -- is a SYMPTOM of the failure and must never excuse it.
  update ingest.schedules set consecutive_idle_runs = 30, max_backoff_mult = 8
   where source_id = v_src_q;

  -- Pin the precondition: this state IS backoff-suppressed for silence...
  if not ops.ingest_job_expected_silent('ingest:quote_poll:ZY') then
    raise exception 'F2 PRECONDITION FAIL: backed-off source must still be expected_silent';
  end if;
  -- ...but must NOT be expected_idle, which is what the failure rule consults.
  if ops.ingest_job_expected_idle('ingest:quote_poll:ZY') then
    raise exception 'F2 FAIL: backoff must NOT make a job expected_idle (it would mask failure)';
  end if;

  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'F2 FAIL: a BACKED-OFF failing job must still raise (this is the 46h bug), got %', v_n;
  end if;
  update ops.incidents set resolved_at = now()
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;

  -- CASE F3 — off-session failing must NOT alert. -----------------------------------
  -- Nothing can fetch quotes on a non-trading day; a stale last_ok_at is expected.
  update public.venues set trading_days = array[v_off_dow] where code = 'ZY';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'F3 FAIL: off-session failing quote_poll must NOT raise, got %', v_n;
  end if;
  update public.venues set trading_days = array[v_today] where code = 'ZY';  -- back in session

  -- CASE F4 — deactivated source failing must NOT alert. ----------------------------
  update ingest.sources set active = false where id = v_src_q;
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'F4 FAIL: deactivated-source failing job must NOT raise, got %', v_n;
  end if;
  update ingest.sources set active = true where id = v_src_q;

  -- CASE F5 — a transient blip (cf < 3) must NOT alert. -----------------------------
  update ops.job_heartbeats set consecutive_failures = 2 where job_name = 'ingest:quote_poll:ZY';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'F5 FAIL: 2 consecutive failures is a blip, must NOT raise, got %', v_n;
  end if;

  -- CASE F6 — a fresh success must NOT alert even with a stale streak count. ---------
  -- Guards the AND: last_ok_at inside 2x the interval means the feed is delivering.
  update ops.job_heartbeats
     set consecutive_failures = 28, last_ok_at = now() - interval '1 minute'
   where job_name = 'ingest:quote_poll:ZY';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'F6 FAIL: a job that succeeded 1 min ago must NOT raise, got %', v_n;
  end if;

  -- CASE F7 — AUTO-RESOLVE: a recovered job closes its own incident. ----------------
  -- Until this migration, job:* incidents never self-closed (three migrations exist purely
  -- to hand-clean stale ones). Raise one, recover the job, assert the sentinel closes it.
  update ops.job_heartbeats
     set consecutive_failures = 28, last_ok_at = now() - interval '47 hours'
   where job_name = 'ingest:quote_poll:ZY';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'F7 SETUP FAIL: expected 1 open incident to resolve, got %', v_n;
  end if;
  -- The feed recovers: heartbeatOk() resets the streak and stamps last_ok_at.
  update ops.job_heartbeats
     set consecutive_failures = 0, last_ok_at = now(), last_run_at = now(), last_error = null
   where job_name = 'ingest:quote_poll:ZY';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'F7 FAIL: a recovered job must auto-resolve its incident, got % open', v_n;
  end if;

  -- CASE F8 — a desk-pinned (auto_expire=false) incident must NOT auto-resolve. ------
  insert into ops.incidents (severity, source, message, auto_expire)
  values ('degraded', 'job:ingest:quote_poll:ZY', 'pinned by the desk', false);
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null and not auto_expire;
  if v_n <> 1 then
    raise exception 'F8 FAIL: a pinned incident must survive auto-resolve, got %', v_n;
  end if;
  update ops.incidents set resolved_at = now()
   where source = 'job:ingest:quote_poll:ZY' and resolved_at is null;

  -- CASE F9 — a NON-ingest job (no suppression path) failing MUST alert. ------------
  -- This is the `nightly` case: cf=5, never succeeded, 'numeric field overflow', and it
  -- writes no fetch_log at all — so only a heartbeat-keyed rule can ever see it.
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at,
                                  last_error, consecutive_failures)
  values ('zy_test_nightly', 86400, now() - interval '11 hours', null, 'numeric field overflow', 5);
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:zy_test_nightly' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'F9 FAIL: non-ingest job that has NEVER succeeded must raise, got %', v_n;
  end if;

  -- CASE F10 — an unknown ingest kind must fail SAFE (alert, never auto-suppress). ---
  if ops.ingest_job_expected_idle('ingest:future_kind:ZY')
     or ops.ingest_job_expected_silent('ingest:future_kind:ZY') then
    raise exception 'F10 FAIL: an unknown ingest kind must never be auto-suppressed';
  end if;

  -- CASE F11 — the silence rule still honours backoff (20260716121312 preserved). ----
  -- Silent + backed off = expected. Regression against over-correcting the split.
  update ops.job_heartbeats
     set last_run_at = now() - interval '3 hours', last_ok_at = now() - interval '3 hours',
         consecutive_failures = 0
   where job_name = 'ingest:quote_poll:ZY';
  select ops.job_unhealthy_reason('ingest:quote_poll:ZY') into v_reason;
  if v_reason is not null then
    raise exception 'F11 FAIL: a silent BACKED-OFF healthy job must stay suppressed, got %', v_reason;
  end if;

  raise notice 'failure_sentinel regression: ALL 11 CASES PASSED (tz=%, local_hour~12)', v_tz;
end $$;

rollback;

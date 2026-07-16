-- Regression: ops.heartbeat_sentinel session- AND source-awareness
-- (migration 20260716121312_fix_heartbeat_sentinel_session_source_aware).
--
-- Pins the suppression cases the fix guarantees AND the two alert cases it must NOT
-- suppress. Runs entirely inside a transaction against a synthetic venue 'ZZ' and
-- ROLLBACKs, so it leaves zero trace and is safe against the live DB. Assertions
-- RAISE EXCEPTION on failure — a clean run (no error) is a pass.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/heartbeat_sentinel_session_source_aware.sql
--   or  Supabase MCP execute_sql with this whole file as one call.
--
-- Time-independent by construction: the synthetic venue's timezone is chosen so its
-- LOCAL now() is always ~12:MM (an Etc/GMT whole-hour offset centred on noon), which
-- keeps every fixed session/eod window clear of the midnight wrap in `time + interval`.
-- Session variants are selected by swapping trading_days, never by wall-clock.

begin;

do $$
declare
  v_utc_hour int := extract(hour from (now() at time zone 'UTC'))::int;
  v_off_h    int := 12 - extract(hour from (now() at time zone 'UTC'))::int;  -- shift local → noon
  v_tz       text;
  v_today    int;
  v_off_dow  int;
  v_src_q bigint;
  v_src_e bigint;
  v_n int;
begin
  -- Whole-hour Etc/GMT zone that puts venue-local now() at ~12:MM (Etc sign inverted).
  v_tz := case when v_off_h = 0 then 'UTC'
               when v_off_h > 0 then 'Etc/GMT-' || v_off_h::text
               else                  'Etc/GMT+' || (-v_off_h)::text end;
  v_today   := extract(dow from (now() at time zone v_tz))::int;
  v_off_dow := (v_today + 3) % 7;

  insert into public.venues (code, name, country, timezone, currency, trading_days, is_active)
  values ('ZZ', 'Sentinel Test Venue', 'ZZ', v_tz, 'USD', array[v_today], true);

  -- Wide session (01:00–23:00) so "in session" holds at the ~noon run time. NOT
  -- 00:00/23:59 — venue_is_open subtracts a 10-min grace from open_local, and
  -- '00:00' - 10min wraps to '23:50', which would read as closed at noon.
  insert into public.market_sessions (venue_code, open_local, close_local, effective_from)
  values ('ZZ', '01:00:00', '23:00:00', '2000-01-01');

  -- quotes source (session_only) + schedule, explicitly NOT backed off.
  insert into ingest.sources (venue, data_type, entry_url, endpoint_config, transport, active)
  values ('ZZ', 'quotes', 'http://x/quotes', '{}', 'http', true) returning id into v_src_q;
  insert into ingest.schedules (source_id, cadence_minutes, session_only, active,
                                consecutive_idle_runs, max_backoff_mult, backoff_exempt)
  values (v_src_q, 10, true, true, 0, 1, false);

  -- A STALE quote heartbeat (silent 1 h ≫ 2×600 s).
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
  values ('ingest:quote_poll:ZZ', 600, now() - interval '1 hour');

  -- CASE 1 — in-session genuine failure MUST alert. -----------------------------
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZZ' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'CASE1 FAIL: in-session stale quote_poll must raise 1 incident, got %', v_n;
  end if;
  update ops.incidents set resolved_at = now()
   where source = 'job:ingest:quote_poll:ZZ' and resolved_at is null;

  -- CASE 2 — off-session gap must NOT alert (non-trading day). --------------------
  update public.venues set trading_days = array[v_off_dow] where code = 'ZZ';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZZ' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'CASE2 FAIL: off-session quote_poll gap must NOT raise, got %', v_n;
  end if;

  -- CASE 3 — deactivated source must NOT alert (source-aware). --------------------
  update public.venues set trading_days = array[v_today] where code = 'ZZ';  -- back in session
  update ingest.sources set active = false where id = v_src_q;
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:quote_poll:ZZ' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'CASE3 FAIL: deactivated-source quote_poll must NOT raise, got %', v_n;
  end if;
  update ingest.sources set active = true where id = v_src_q;

  -- eod source (active, backoff-exempt, session_only=false) + stale heartbeat.
  insert into ingest.sources (venue, data_type, entry_url, endpoint_config, transport, active)
  values ('ZZ', 'eod_bulletin', 'http://x/eod', '{}', 'http', true) returning id into v_src_e;
  insert into ingest.schedules (source_id, cadence_minutes, session_only, active,
                                consecutive_idle_runs, max_backoff_mult, backoff_exempt)
  values (v_src_e, 60, false, true, 0, 1, true);
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
  values ('ingest:eod_sweep:ZZ', 3600, now() - interval '6 hours');

  -- CASE 4 — eod_sweep OUTSIDE its post-close window must NOT alert. --------------
  -- close 16:00 → window [16:00, 19:00]; local now ~12:MM is before it.
  update public.market_sessions set close_local = '16:00:00' where venue_code = 'ZZ';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:eod_sweep:ZZ' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'CASE4 FAIL: eod_sweep outside post-close window must NOT raise, got %', v_n;
  end if;

  -- CASE 5 — eod_sweep INSIDE its window with a dead active feed MUST alert. -------
  -- close 11:00 → window [11:00, 14:00]; local now ~12:MM is inside it.
  update public.market_sessions set close_local = '11:00:00' where venue_code = 'ZZ';
  perform ops.heartbeat_sentinel();
  select count(*) into v_n from ops.incidents
   where source = 'job:ingest:eod_sweep:ZZ' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'CASE5 FAIL: in-window stale eod_sweep with active feed must raise 1, got %', v_n;
  end if;

  raise notice 'heartbeat_sentinel session/source regression: ALL 5 CASES PASSED (tz=%, local_hour~12)', v_tz;
end $$;

rollback;

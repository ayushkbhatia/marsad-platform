-- Regression: ingest.sweep_feed_status() feed:* incident dedupe + closed→live resolve
-- (migration 20260717143000_fix_feed_status_sweep_incident_dedup).
--
-- Pins the duplicate-incident bug observed live 2026-07-17: ops.incidents held TWO open
-- feed:ADX rows with identical messages, ids 17879 (07-16 06:00) and 18145 (07-17 06:00) —
-- exactly 24 h apart, one per trading day — because the raise was edge-triggered on the
-- previous STORED state and 'closed' (written at every market close) reset that memory, so
-- the next session's first tick read closed→offline as a fresh transition. CASE D3 is that
-- exact scenario. CASE D5 is its mirror image (a recovery that never resolves).
--
-- Runs entirely inside a transaction against a synthetic venue 'ZX' and ROLLBACKs, so it
-- leaves zero trace and is safe against the live DB. Assertions RAISE EXCEPTION on failure
-- — a clean run (no error) is a pass. Note the sweep loops over ALL active venues, so it
-- touches the real ones too; every assertion is therefore scoped to 'feed:ZX', and the
-- rollback discards whatever it did to the rest.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/feed_status_sweep_incident_dedup.sql
--   or  Supabase MCP execute_sql with this whole file as one call.
--
-- Time-independent by construction, same trick as heartbeat_sentinel_session_source_aware
-- .sql: the synthetic venue's timezone is chosen so its LOCAL now() is always ~12:MM (an
-- Etc/GMT whole-hour offset centred on noon), keeping the fixed 01:00–23:00 session clear
-- of the midnight wrap in `time ± interval`. In-session vs closed is selected by swapping
-- trading_days, never by wall-clock.

begin;

do $$
declare
  v_off_h   int := 12 - extract(hour from (now() at time zone 'UTC'))::int;  -- shift local → noon
  v_tz      text;
  v_today   int;
  v_off_dow int;
  v_src_q   bigint;
  v_n       int;
  v_state   text;
  v_msg     text;
begin
  -- Whole-hour Etc/GMT zone that puts venue-local now() at ~12:MM (Etc sign inverted).
  v_tz := case when v_off_h = 0 then 'UTC'
               when v_off_h > 0 then 'Etc/GMT-' || v_off_h::text
               else                  'Etc/GMT+' || (-v_off_h)::text end;
  v_today   := extract(dow from (now() at time zone v_tz))::int;
  v_off_dow := (v_today + 3) % 7;

  insert into public.venues (code, name, country, timezone, currency, trading_days, is_active)
  values ('ZX', 'Feed Sweep Test Venue', 'ZX', v_tz, 'USD', array[v_today], true);

  -- Wide session (01:00–23:00) so "in session" holds at the ~noon run time. NOT 00:00 —
  -- venue_is_open compares against open_local - p_grace_before and '00:00' would wrap.
  insert into public.market_sessions (venue_code, open_local, close_local, effective_from)
  values ('ZX', '01:00:00', '23:00:00', '2000-01-01');

  -- Active quotes source, DEAD: last success 3 h ago ≫ the sweep's 45-min offline
  -- threshold. This is the only input the sweep reads besides the calendar.
  insert into ingest.sources (venue, data_type, entry_url, endpoint_config, transport,
                              active, last_success_at)
  values ('ZX', 'quotes', 'http://x/quotes', '{}', 'http', true, now() - interval '3 hours')
  returning id into v_src_q;

  -- CASE D1 — in-session dead feed MUST raise exactly one incident. -----------------
  perform ingest.sweep_feed_status();
  select state into v_state from public.venue_feed_status where venue_code = 'ZX';
  if v_state is distinct from 'offline' then
    raise exception 'D1 FAIL: 3h-stale in-session feed must read offline, got %', v_state;
  end if;
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D1 FAIL: offline feed must raise exactly 1 incident, got %', v_n;
  end if;

  -- CASE D2 — a second tick while still offline must NOT stack. ---------------------
  perform ingest.sweep_feed_status();
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D2 FAIL: repeated offline ticks must not stack, got % open', v_n;
  end if;

  -- CASE D3 — THE REGRESSION: offline → closed → offline must NOT stack. ------------
  -- This is the live feed:ADX/feed:BHB duplicate, reproduced. Pre-fix the closed→offline
  -- edge read `v_old = 'closed' <> 'offline'` as a fresh transition and inserted a 2nd
  -- incident on top of the still-open 1st — one duplicate per venue per trading day.
  update public.venues set trading_days = array[v_off_dow] where code = 'ZX';   -- market closes
  perform ingest.sweep_feed_status();
  select state into v_state from public.venue_feed_status where venue_code = 'ZX';
  if v_state is distinct from 'closed' then
    raise exception 'D3 FAIL: off-session venue must read closed, got %', v_state;
  end if;
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D3 FAIL: market close must neither raise nor resolve, got % open', v_n;
  end if;

  update public.venues set trading_days = array[v_today] where code = 'ZX';      -- next open
  perform ingest.sweep_feed_status();
  select state into v_state from public.venue_feed_status where venue_code = 'ZX';
  if v_state is distinct from 'offline' then
    raise exception 'D3 FAIL: still-dead feed must read offline at next open, got %', v_state;
  end if;
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D3 FAIL: closed->offline must NOT stack a duplicate (the 2026-07-17 feed:ADX bug), got % open', v_n;
  end if;

  -- CASE D4 — recovery resolves (the pre-existing offline → live path, preserved). ---
  update ingest.sources set last_success_at = now() where id = v_src_q;
  perform ingest.sweep_feed_status();
  select state into v_state from public.venue_feed_status where venue_code = 'ZX';
  if v_state is distinct from 'live' then
    raise exception 'D4 FAIL: fresh feed must read live, got %', v_state;
  end if;
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'D4 FAIL: offline->live must resolve the incident, got % open', v_n;
  end if;

  -- CASE D5 — THE MIRROR HOLE: offline → closed → live must resolve. ----------------
  -- The scheduler enqueues session_only feeds with a 10-min PRE-OPEN grace while the sweep
  -- gates on venue_is_open(code, now()) with NO grace, so a feed that recovers overnight is
  -- already fresh on the sweep's first in-session tick: closed→live is the NORMAL recovery
  -- edge. Pre-fix the resolve required v_old = 'offline' exactly, so the incident orphaned.
  update ingest.sources set last_success_at = now() - interval '3 hours' where id = v_src_q;
  perform ingest.sweep_feed_status();                                            -- re-raise
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D5 FAIL(setup): a NEW outage after a resolve must raise again (the dedupe guard must not be a permanent mute), got % open', v_n;
  end if;

  update public.venues set trading_days = array[v_off_dow] where code = 'ZX';    -- market closes
  perform ingest.sweep_feed_status();                                            -- v_old := 'closed'
  update ingest.sources set last_success_at = now() where id = v_src_q;          -- pre-open grace poll lands
  update public.venues set trading_days = array[v_today] where code = 'ZX';      -- next open
  perform ingest.sweep_feed_status();
  select state into v_state from public.venue_feed_status where venue_code = 'ZX';
  if v_state is distinct from 'live' then
    raise exception 'D5 FAIL: recovered feed must read live, got %', v_state;
  end if;
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 0 then
    raise exception 'D5 FAIL: closed->live must resolve (v_old is ''closed'', not ''offline'', whenever the pre-open grace poll beats the sweep), got % open', v_n;
  end if;

  -- CASE D6 — a desk-PINNED incident suppresses the raise and survives recovery. -----
  -- auto_expire = false is the desk saying "I own this one". The raise's not-exists guard
  -- is deliberately NOT scoped to auto_expire (same as ops.heartbeat_sentinel): there is
  -- already an open incident about this feed, so the sweep must not add its own. The
  -- resolve IS scoped to auto_expire, so the pin outlives the recovery.
  insert into ops.incidents (severity, source, message, auto_expire)
  values ('degraded', 'feed:ZX', 'desk-pinned ZX feed investigation', false);
  update ingest.sources set last_success_at = now() - interval '3 hours' where id = v_src_q;
  perform ingest.sweep_feed_status();
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_n <> 1 then
    raise exception 'D6 FAIL: an open desk-pinned incident must suppress the sweep''s raise, got % open', v_n;
  end if;
  select message into v_msg from ops.incidents
   where source = 'feed:ZX' and resolved_at is null;
  if v_msg not like 'desk-pinned%' then
    raise exception 'D6 FAIL: the surviving incident must be the desk pin, got: %', v_msg;
  end if;

  update ingest.sources set last_success_at = now() where id = v_src_q;
  perform ingest.sweep_feed_status();
  select count(*) into v_n from ops.incidents
   where source = 'feed:ZX' and resolved_at is null and not auto_expire;
  if v_n <> 1 then
    raise exception 'D6 FAIL: recovery must NOT auto-resolve a desk-pinned (auto_expire=false) incident, got % open', v_n;
  end if;

  raise notice 'sweep_feed_status incident dedupe regression: ALL 6 CASES PASSED (tz=%, local_hour~12)', v_tz;
end $$;

rollback;

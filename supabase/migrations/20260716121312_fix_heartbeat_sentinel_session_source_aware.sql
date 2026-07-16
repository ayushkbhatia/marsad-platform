-- fix_heartbeat_sentinel_session_source_aware
--
-- Kill the remaining FALSE heartbeat incidents (audit 2026-07-15 open item
-- "sentinel not session-aware"; BUILD-STATUS §7 note under the 0715161005 entry).
--
-- The 20260716100000 fleet-guard already made ops.heartbeat_sentinel session- and
-- backoff-aware, but it only ever inspects an ACTIVE schedule+source: its whole
-- suppression EXISTS is gated on `sc.active`. So three legitimate silences still
-- raise a degraded incident every 10-min tick:
--   * ingest:filings_poll:<venue>       — the base LIST source is deactivated
--                                         (DEF-VENUE-FILINGS: TDWL/QE off), so the
--                                         schedule never enqueues and never beats.
--   * ingest:filings_detail_poll:BHB/DFM — deactivated BY DESIGN (BHB is list-only,
--                                         DEF-VENUE-FILINGS-BHB-PDF; DFM detail off,
--                                         DEF-VENUE-FILINGS-DFM-PDF). These names
--                                         never beat, ever.
--   * ingest:eod_sweep:<venue>          — for a venue whose eod_bulletin source is
--                                         deactivated (DFM/MSX/QE/TDWL) nothing beats;
--                                         and even an ACTIVE eod source only does real
--                                         work inside its post-close window, so the
--                                         fleet-guard's `session_only`-keyed eod branch
--                                         (eod is session_only=false) never matched.
--
-- Fix, four parts:
--   (1) ingest.venue_in_eod_window() — SQL mirror of the worker close-gate
--       (eod-sweep.ts eodCloseGate, POST_CLOSE_WINDOW_MINUTES=180): is now() inside
--       [close_local, close_local+window] for the venue's local trading day. Reads
--       public.market_sessions + public.venues.timezone with the SAME `at time zone`
--       + ::date/::time casting ingest.venue_is_open uses, so there is no postgres.js
--       Date-vs-string trap (PR #25/#30) and holiday/session semantics match the
--       scheduler and the eod handler exactly.
--   (2) ops.ingest_job_expected_silent(job_name) — the single suppression predicate.
--       Silence is EXPECTED when EITHER (A) there is NO active backing source for the
--       job's venue+kind (deactivated source = not a failing job — req #2), OR (B) an
--       active backing source exists but is intentionally quiet right now: a
--       session-only feed off-session, an eod sweep outside its post-close window, or
--       a source the productivity guard has backed off below base cadence. A genuinely
--       dead feed (active source, session open / in window, not backed off) is NOT
--       expected-silent and still alerts at 2× base cadence.
--   (3) ops.heartbeat_sentinel() — delegates ingest:* suppression to (2).
--   (4) Registry reconcile: DELETE the ingest:filings_detail_poll:BHB / :DFM heartbeat
--       rows — they are deactivated by design and never beat, so a permanent registry
--       row is misleading noise (same call the 0715161005 reconcile made for
--       wire_brief/analytics_rollup/notify_drain). Self-healing: ops.beat re-inserts
--       the row if the source is ever reactivated. Every OTHER deactivated source
--       (eod DFM/MSX/QE/TDWL, filings QE/TDWL) keeps its row and is covered by the
--       (A) inactive-source rule, so it resumes alerting the instant it is reactivated.
--
-- Then resolve the false incidents the new sentinel will no longer regenerate.
--
-- Pure SQL, idempotent (CREATE OR REPLACE / guarded DELETE / conditional UPDATE) —
-- safe to replay from scratch or re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (1) Post-close window calendar helper. Mirrors worker/src/handlers/eod-sweep.ts
--     eodCloseGate: venue active + local trading day + not a holiday + now-local in
--     [close_local, close_local + window). Same tables/casting as ingest.venue_is_open.
create or replace function ingest.venue_in_eod_window(
  p_venue text, p_at timestamptz, p_window_minutes int default 180
) returns boolean
language plpgsql stable set search_path = ''
as $$
declare
  v_tz    text;
  v_days  int[];
  v_local timestamptz;
  v_date  date;
  v_time  time;
  v_close time;
begin
  select timezone, trading_days into v_tz, v_days
  from public.venues where code = p_venue and is_active;
  if not found then return false; end if;

  v_local := p_at at time zone v_tz;
  v_date  := v_local::date;
  v_time  := v_local::time;

  -- trading day? (02 convention: trading_days uses 0=Sun … 6=Sat, like extract(dow))
  if not (extract(dow from v_local)::int = any (v_days)) then
    return false;
  end if;
  if exists (select 1 from public.market_holidays
             where venue_code = p_venue and holiday_date = v_date) then
    return false;
  end if;

  select ms.close_local into v_close
  from public.market_sessions ms
  where ms.venue_code = p_venue
    and ms.effective_from <= v_date
    and (ms.effective_to is null or ms.effective_to >= v_date)
  order by ms.effective_from desc
  limit 1;
  if v_close is null then return false; end if;

  return v_time >= v_close
     and v_time <  v_close + make_interval(mins => p_window_minutes);
end $$;

comment on function ingest.venue_in_eod_window(text, timestamptz, int) is
  'True when p_at is inside the venue-local post-close EOD window [close_local, close_local+window] '
  'on a trading day. SQL mirror of the worker eodCloseGate close-gate; used by ops.heartbeat_sentinel '
  'to suppress false eod_sweep silence outside the window.';

-- ---------------------------------------------------------------------------
-- (2) Suppression predicate. Only meaningful for 'ingest:<kind>:<venue>' job names.
--     kind → data_type: quote_poll→quotes/indices, filings_poll→filings_list,
--     filings_detail_poll→filing_detail, eod_sweep→eod_bulletin. An unknown kind is
--     NEVER auto-suppressed (fail safe: alert), so a future ingest job can't be
--     silently masked by the (A) not-exists branch.
create or replace function ops.ingest_job_expected_silent(p_job_name text)
returns boolean
language sql stable set search_path = ''
as $$
  select case
    when split_part(p_job_name, ':', 2) not in
         ('quote_poll', 'filings_poll', 'filings_detail_poll', 'eod_sweep')
      then false
    else
      -- (A) no ACTIVE backing source for this venue+kind → deactivated, not failing.
      not exists (
        select 1
        from ingest.sources s
        join ingest.schedules sc on sc.source_id = s.id and sc.active
        where s.active
          and s.venue = split_part(p_job_name, ':', 3)
          and case split_part(p_job_name, ':', 2)
                when 'quote_poll'          then s.data_type in ('quotes', 'indices')
                when 'filings_poll'        then s.data_type = 'filings_list'
                when 'filings_detail_poll' then s.data_type = 'filing_detail'
                when 'eod_sweep'           then s.data_type = 'eod_bulletin'
              end
      )
      -- (B) an active backing source exists but is INTENTIONALLY quiet right now.
      or exists (
        select 1
        from ingest.sources s
        join ingest.schedules sc on sc.source_id = s.id and sc.active
        where s.active
          and s.venue = split_part(p_job_name, ':', 3)
          and case split_part(p_job_name, ':', 2)
                when 'quote_poll'          then s.data_type in ('quotes', 'indices')
                when 'filings_poll'        then s.data_type = 'filings_list'
                when 'filings_detail_poll' then s.data_type = 'filing_detail'
                when 'eod_sweep'           then s.data_type = 'eod_bulletin'
              end
          and (
            -- session-only feed (quotes/indices) outside its trading session
            (sc.session_only and not ingest.venue_is_open(s.venue, now(),
                                        interval '10 minutes', interval '20 minutes'))
            -- eod sweep outside its post-close window (its only real-work window)
            or (split_part(p_job_name, ':', 2) = 'eod_sweep'
                and not ingest.venue_in_eod_window(s.venue, now(), 180))
            -- productivity guard has backed this source off below base cadence
            or ingest.effective_cadence_minutes(sc.cadence_minutes, sc.consecutive_idle_runs,
                                                sc.max_backoff_mult, sc.backoff_exempt) > sc.cadence_minutes
          )
      )
  end;
$$;

comment on function ops.ingest_job_expected_silent(text) is
  'True when an ingest:<kind>:<venue> heartbeat is EXPECTED to be silent: no active backing source '
  '(deactivated), or an active source that is off-session / outside its eod window / backed off. '
  'ops.heartbeat_sentinel suppresses incidents for these; a genuinely dead active in-window feed is not '
  'expected-silent and still alerts.';

-- ---------------------------------------------------------------------------
-- (3) Sentinel: raise a degraded incident for any heartbeat silent past 2× its
--     expected interval, EXCEPT ingest:* jobs whose silence is expected (2).
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
    and not (h.job_name like 'ingest:%' and ops.ingest_job_expected_silent(h.job_name));
end $$;

-- ---------------------------------------------------------------------------
-- (4) Registry reconcile — drop the deactivated-by-design filing_detail rows that
--     never beat (BHB list-only, DFM detail off). ops.beat re-seeds on reactivation.
delete from ops.job_heartbeats
where job_name in ('ingest:filings_detail_poll:BHB', 'ingest:filings_detail_poll:DFM');

-- ---------------------------------------------------------------------------
-- Resolve the false incidents the fixed sentinel will no longer regenerate: every
-- open job:* incident whose backing heartbeat is NOT currently flaggable by the new
-- sentinel (healthy, expected-silent, or row deleted above). A genuine in-session
-- failure keeps its incident open. Scoped to job:* — feed:* incidents belong to
-- ingest.sweep_feed_status, a separate subsystem, and are left untouched.
update ops.incidents i
   set resolved_at = now()
 where i.resolved_at is null
   and i.source like 'job:%'
   and not exists (
     select 1 from ops.job_heartbeats h
     where 'job:' || h.job_name = i.source
       and coalesce(h.last_run_at, 'epoch'::timestamptz)
             < now() - make_interval(secs => 2 * h.expected_interval_s)
       and not (h.job_name like 'ingest:%' and ops.ingest_job_expected_silent(h.job_name))
   );

-- failure_sentinel_job_health
--
-- Close the SILENT-FAILURE blind spot: a job that runs on schedule and fails every
-- single time is currently invisible to ops.heartbeat_sentinel.
--
-- HOW THE GAP WORKS (observed live 2026-07-17: ingest:quote_poll:ADX had 28 consecutive
-- failures and had not succeeded for 47 h, while raising no incident at all):
--
--   1. worker/src/handlers/job-heartbeat.ts heartbeatRun() stamps last_run_at at the TOP
--      of every handler, before the work. heartbeatError() then records last_error +
--      consecutive_failures. But ops.heartbeat_sentinel keys ONLY on last_run_at, so a
--      perpetually-failing job has a perpetually-fresh liveness stamp: "is it beating?"
--      stays true while zero data lands. last_ok_at / consecutive_failures were written
--      by nobody's reader.
--
--   2. Worse, the fleet productivity guard (20260716100000) ACTIVELY suppresses exactly
--      this case. Its benefit proxy is fetch_log.changed=true, and every FAILURE path
--      writes changed=false. So a broken feed looks "idle" → consecutive_idle_runs climbs
--      → effective_cadence > base → ops.ingest_job_expected_silent() returns true → the
--      sentinel goes quiet. After ~3 failures a broken feed silences its own alarm.
--      Live proof: ADX quotes (idle 28, eff 20 min vs base 10) and BHB filings (idle 39,
--      eff 40 min vs base 5) both returned expected_silent = true while dead.
--
-- THE FIX, three parts:
--
--   (1) Split the suppression predicate. Backoff is a legitimate excuse for SILENCE (a
--       backed-off source genuinely polls slower) but NEVER for FAILURE (the backoff is a
--       SYMPTOM of the failure). So:
--         ops.ingest_job_backing()       — the one home for the job_name → source mapping.
--         ops.ingest_job_expected_idle() — deactivated / off-session / outside eod window.
--         ops.ingest_job_expected_silent() = expected_idle OR backed_off.
--       The silent predicate is UNCHANGED in meaning: exists(P or Q) ≡ exists(P) or
--       exists(Q), so 20260716121312's suppression cases all still hold (its regression
--       test still passes). The mapping now lives in ONE place instead of two copies.
--
--   (2) ops.job_unhealthy_reason(job) → 'silent' | 'failing' | null. 'failing' =
--       consecutive_failures >= 3 AND nothing has succeeded for 2× the expected interval
--       AND the job is not expected-idle. The >= 3 floor means a transient blip never
--       pages (any success resets the counter to 0); the 2× last_ok_at window is the same
--       rhythm the silence rule already uses, so the threshold scales with each job's own
--       cadence rather than a fleet-wide constant.
--
--   (3) ops.heartbeat_sentinel() raises on EITHER reason, keyed on the SAME
--       'job:<name>' incident source (one open incident per job, whatever the mode), and
--       — new — AUTO-RESOLVES job:* incidents once the job is healthy again. Until now
--       job:* incidents never self-closed: three separate migrations (20260715161005,
--       20260716121312, 20260716130004) exist purely to hand-clean stale ones. A rule that
--       fires more without a resolver would just grow that treadmill. Mirrors the feed:*
--       convention in ingest.sweep_feed_status: only auto_expire incidents are closed, so a
--       desk-pinned incident stays pinned.
--
-- NOT keyed on ingest.fetch_log error streaks (the first-instinct design): logFetchSkipped
-- writes error='skipped: <reason>' on HEALTHY skips, so `error is not null` false-fires
-- every off-session; and ops.job_heartbeats already aggregates the identical signal at one
-- row per job with no 30-day scan — and covers jobs like `nightly` that write no fetch_log
-- at all. fetch_log stays the audit trail; job_heartbeats is the alarm.
--
-- Pure SQL, idempotent (CREATE OR REPLACE only) — safe to replay from scratch or re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (1a) The single home for the ingest job_name → active backing source mapping. Returns
--      one row per ACTIVE (source, schedule) pair backing an 'ingest:<kind>:<venue>' job,
--      with the two facts the suppression predicates need. Output columns are b_-prefixed
--      so they can never be ambiguous against the body's own column references.
create or replace function ops.ingest_job_backing(p_job_name text)
returns table (b_venue text, b_session_only boolean, b_backed_off boolean)
language sql stable set search_path = ''
as $$
  select s.venue, sc.session_only,
         ingest.effective_cadence_minutes(sc.cadence_minutes, sc.consecutive_idle_runs,
                                          sc.max_backoff_mult, sc.backoff_exempt)
           > sc.cadence_minutes
  from ingest.sources s
  join ingest.schedules sc on sc.source_id = s.id and sc.active
  where s.active
    and s.venue = split_part(p_job_name, ':', 3)
    and case split_part(p_job_name, ':', 2)
          when 'quote_poll'          then s.data_type in ('quotes', 'indices')
          when 'filings_poll'        then s.data_type = 'filings_list'
          when 'filings_detail_poll' then s.data_type = 'filing_detail'
          when 'eod_sweep'           then s.data_type = 'eod_bulletin'
          else false
        end;
$$;

comment on function ops.ingest_job_backing(text) is
  'Active (source, schedule) pairs backing an ingest:<kind>:<venue> heartbeat, with session_only '
  'and whether the productivity guard has backed the schedule off below base cadence. The single '
  'source of truth for the job_name → source mapping used by both suppression predicates.';

-- ---------------------------------------------------------------------------
-- (1b) EXPECTED IDLE — the job is intentionally not working right now, so neither silence
--      NOR a stale last_ok_at means anything. Deliberately EXCLUDES backoff.
create or replace function ops.ingest_job_expected_idle(p_job_name text)
returns boolean
language sql stable set search_path = ''
as $$
  select case
    -- Unknown kind → NEVER auto-suppress (fail safe: alert). Keeps a future ingest job
    -- from being silently masked by the no-backing-source branch below, which would
    -- otherwise match it vacuously.
    when split_part(p_job_name, ':', 2) not in
         ('quote_poll', 'filings_poll', 'filings_detail_poll', 'eod_sweep')
      then false
    -- (A) no ACTIVE backing source for this venue+kind → deactivated, not failing.
    when not exists (select 1 from ops.ingest_job_backing(p_job_name))
      then true
    -- (B) an active backing source exists but is INTENTIONALLY quiet right now:
    --     a session-only feed off-session, or an eod sweep outside its post-close window.
    else exists (
      select 1 from ops.ingest_job_backing(p_job_name) b
      where (b.b_session_only
             and not ingest.venue_is_open(b.b_venue, now(),
                                          interval '10 minutes', interval '20 minutes'))
         or (split_part(p_job_name, ':', 2) = 'eod_sweep'
             and not ingest.venue_in_eod_window(b.b_venue, now(), 180))
    )
  end;
$$;

comment on function ops.ingest_job_expected_idle(text) is
  'True when an ingest job is EXPECTED to do no work right now: no active backing source '
  '(deactivated), a session-only feed off-session, or an eod sweep outside its post-close window. '
  'Excludes backoff BY DESIGN — a backed-off source is still expected to SUCCEED when it does run, '
  'so this is the correct suppression for the failure rule (ops.job_unhealthy_reason).';

-- ---------------------------------------------------------------------------
-- (1c) EXPECTED SILENT — idle, OR polling slower than its hardcoded heartbeat window
--      because the guard backed it off. Semantics unchanged from 20260716121312.
create or replace function ops.ingest_job_expected_silent(p_job_name text)
returns boolean
language sql stable set search_path = ''
as $$
  select ops.ingest_job_expected_idle(p_job_name)
      or exists (select 1 from ops.ingest_job_backing(p_job_name) b where b.b_backed_off);
$$;

comment on function ops.ingest_job_expected_silent(text) is
  'True when an ingest:<kind>:<venue> heartbeat is EXPECTED to be silent: expected-idle, or an '
  'active source the productivity guard has backed off below base cadence. Suppresses the '
  'sentinel''s SILENCE rule only — the FAILURE rule uses ops.ingest_job_expected_idle, because a '
  'failing fetch writes changed=false and thus causes its own backoff.';

-- ---------------------------------------------------------------------------
-- (2) The one health verdict, shared by the sentinel's raise AND resolve passes so they
--     can never disagree (a raise/resolve predicate drift would flap incidents every tick).
--     Returns null for a healthy job AND for a job_name with no heartbeat row — so an
--     incident whose registry row was reconciled away resolves instead of pinning forever.
create or replace function ops.job_unhealthy_reason(p_job_name text)
returns text
language sql stable set search_path = ''
as $$
  select case
    -- SILENT — the job stopped running. Backoff IS a valid excuse here.
    when coalesce(h.last_run_at, 'epoch'::timestamptz)
           < now() - make_interval(secs => 2 * h.expected_interval_s)
         and not (h.job_name like 'ingest:%' and ops.ingest_job_expected_silent(h.job_name))
      then 'silent'
    -- FAILING — the job runs on time but errors every time, and has not succeeded for 2×
    -- its own expected interval. Backoff is NOT a valid excuse (see header). >= 3 is a
    -- CONSECUTIVE count: any success resets it to 0, so this only ever means a sustained
    -- streak, never a flaky one-off.
    when h.consecutive_failures >= 3
         and coalesce(h.last_ok_at, 'epoch'::timestamptz)
               < now() - make_interval(secs => 2 * h.expected_interval_s)
         and not (h.job_name like 'ingest:%' and ops.ingest_job_expected_idle(h.job_name))
      then 'failing'
    else null
  end
  from ops.job_heartbeats h
  where h.job_name = p_job_name;
$$;

comment on function ops.job_unhealthy_reason(text) is
  'The sentinel''s single health verdict for a job: ''silent'' (not running), ''failing'' '
  '(running but erroring, >=3 consecutive, nothing succeeded for 2x its interval), or null when '
  'healthy / expected-quiet / no such heartbeat row.';

-- ---------------------------------------------------------------------------
-- (3) Sentinel: raise on either failure mode, then resolve what has recovered.
create or replace function ops.heartbeat_sentinel() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- RAISE — one open incident per job, whatever the mode. The not-exists keeps a job that
  -- degrades silent→failing (or back) from stacking a second incident for one root cause.
  insert into ops.incidents (severity, source, message)
  select 'degraded', 'job:' || h.job_name,
         case r.reason
           when 'silent' then
             'job ' || h.job_name || ' silent since ' || coalesce(h.last_run_at::text, 'never')
           else
             'job ' || h.job_name || ' FAILING — ' || h.consecutive_failures ||
             ' consecutive failures, last success ' || coalesce(h.last_ok_at::text, 'never') ||
             coalesce(': ' || left(h.last_error, 200), '')
         end
  from ops.job_heartbeats h
  cross join lateral (select ops.job_unhealthy_reason(h.job_name) as reason) r
  where r.reason is not null
    and not exists (select 1 from ops.incidents i
                    where i.source = 'job:' || h.job_name and i.resolved_at is null);

  -- RESOLVE — close auto-expiring job:* incidents whose job is healthy again (or whose
  -- heartbeat row is gone). substring(source from 5) strips the 'job:' prefix; the rest of
  -- the name keeps its own colons ('job:ingest:quote_poll:ADX' → 'ingest:quote_poll:ADX').
  -- Scoped to job:* — feed:* belongs to ingest.sweep_feed_status, a separate subsystem.
  update ops.incidents i
     set resolved_at = now()
   where i.resolved_at is null
     and i.auto_expire
     and i.source like 'job:%'
     and ops.job_unhealthy_reason(substring(i.source from 5)) is null;
end $$;

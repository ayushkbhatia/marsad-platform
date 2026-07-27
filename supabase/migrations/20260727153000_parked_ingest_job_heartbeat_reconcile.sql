-- parked_ingest_job_heartbeat_reconcile
--
-- Stop a DELIBERATELY PARKED ingest job from reading as a dead one forever.
--
-- WHAT HAPPENED (diagnosed 2026-07-27). ops.job_heartbeats has carried this row since
-- 2026-07-15, unchanged, for twelve days:
--
--   ingest:filings_poll:TDWL | consecutive_failures 326 | last_ok_at NULL
--                            | last_run_at 2026-07-15 15:00:03
--                            | last_error 'browserContext.newPage: Target page, context
--                                          or browser has been closed'
--
-- Read cold, that is a live venue feed dying under a browser fault. It is not. Source id2
-- was DEACTIVATED on purpose at 15:01 that day by 20260715150100 §(3), because
-- saudiexchange.sa is Akamai-blocked and the route was never pinnable (DEF-VENUE-FILINGS-
-- TDWL). ingest.enqueue_due_jobs() joins `ingest.sources s ... and s.active`, so dispatch
-- stopped on the spot — the row froze mid-failure-streak and nothing has touched it since.
-- Same story for ingest:filings_poll:QE (id11) and the four eod_sweep venues parked in the
-- same statement, plus ingest:eod_sweep:ADX (20260720140000).
--
-- The ALERTING was right the whole time: 20260717101959's ops.job_unhealthy_reason gates
-- both its rules on ops.ingest_job_expected_idle, whose branch (A) is "no active backing
-- source", so none of these raised an incident. The REGISTRY is what lied. A stale
-- consecutive_failures/last_error pair is not evidence of anything once the job stopped
-- being dispatched — it is a snapshot of the last poll before the park, preserved forever.
-- It cost a real audit: BUILD-STATUS §7 gained a DEF-TDWL-FILINGS-POLL row on 2026-07-26
-- describing a browser-context fault to go and diagnose, from reading exactly this row.
--
-- 20260716121312 §(4) already faced the choice and DELETED two such rows, but deliberately
-- kept these ("resumes alerting the instant it is reactivated"). That reasoning holds for
-- the row's EXISTENCE — a registry that forgets its parked jobs is worse — but not for its
-- FAILURE STATE, which is what a human actually reads.
--
-- THE FIX: clear the failure residue (consecutive_failures, last_error) on any ingest job
-- with no active backing source; keep last_run_at / last_ok_at, which are honest history
-- ("it genuinely last ran then, and it genuinely never succeeded"). Done as a pass inside
-- ops.heartbeat_sentinel (pg_cron, every 10 min) rather than a one-shot cleanup, so the
-- NEXT park does not re-lay the same landmine. Self-healing in both directions: ops.beat
-- and the worker's heartbeatError re-arm the real counters the moment a reactivated source
-- runs again, and ops.ingest_job_parked goes false the moment it does.
--
-- Pure SQL, idempotent (CREATE OR REPLACE + a guarded UPDATE) — safe to replay or re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (1) PARKED — branch (A) of ops.ingest_job_expected_idle, given its own name because two
--     callers now need it and only it: the idle predicate (where it is one of several
--     reasons a job may be quiet) and the reconcile below (where it is the ONLY reason
--     that justifies discarding a failure count). Unknown kind ⇒ false, so a future
--     ingest job can never be mistaken for parked by the vacuous not-exists.
create or replace function ops.ingest_job_parked(p_job_name text)
returns boolean
language sql stable set search_path = ''
as $$
  select split_part(p_job_name, ':', 2) in
           ('quote_poll', 'filings_poll', 'filings_detail_poll', 'eod_sweep')
     and not exists (select 1 from ops.ingest_job_backing(p_job_name));
$$;

comment on function ops.ingest_job_parked(text) is
  'True when an ingest:<kind>:<venue> job has NO active backing (source, schedule) pair — it was '
  'deliberately deactivated, so ingest.enqueue_due_jobs never dispatches it and it can neither '
  'succeed nor fail. Unknown kinds are never parked (fail safe).';

-- ---------------------------------------------------------------------------
-- (2) Re-express expected-idle branch (A) through (1). Semantics UNCHANGED — the inlined
--     kind guard + not-exists is exactly ops.ingest_job_parked — so 20260716121312's and
--     20260717101959's regression tests still hold.
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
    when ops.ingest_job_parked(p_job_name)
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
  'True when an ingest job is EXPECTED to do no work right now: parked (no active backing source), '
  'a session-only feed off-session, or an eod sweep outside its post-close window. Excludes backoff '
  'BY DESIGN — a backed-off source is still expected to SUCCEED when it does run, so this is the '
  'correct suppression for the failure rule (ops.job_unhealthy_reason).';

-- ---------------------------------------------------------------------------
-- (3) Sentinel: reconcile parked rows FIRST, then raise, then resolve.
--
--     RAISE/RESOLVE are byte-identical to 20260717101959 — only the RECONCILE pass is new.
--     It runs first so the registry a human reads and the registry the rules read can never
--     disagree within a tick. (The rules were already immune: job_unhealthy_reason's
--     'failing' branch excludes expected-idle, of which parked is a subset.)
create or replace function ops.heartbeat_sentinel() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- RECONCILE — a parked job is not dispatched at all, so its counters cannot advance and
  -- whatever they froze at is a fossil of the last poll before the park, not a signal. Zero
  -- the failure state; leave last_run_at/last_ok_at, which remain true statements about
  -- history. Guarded so this is a no-op on every tick after the first.
  update ops.job_heartbeats h
     set consecutive_failures = 0,
         last_error = null
   where h.job_name like 'ingest:%'
     and (h.consecutive_failures <> 0 or h.last_error is not null)
     and ops.ingest_job_parked(h.job_name);

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

-- ---------------------------------------------------------------------------
-- (4) Clear the seven rows standing today, rather than waiting up to 10 min for the first
--     cron tick. Same predicate as the pass above — this is the identical statement, not a
--     hand-written list, so it cannot drift from the rule that maintains it.
--
--     Expected effect on the live DB at the time of writing (2026-07-27):
--       ingest:filings_poll:TDWL  326 → 0, last_error cleared
--       ingest:eod_sweep:ADX        3 → 0, last_error cleared
--     The other parked rows (filings_poll:QE, eod_sweep:{TDWL,DFM,QE,MSX}) already sit at
--     0 failures with no error — they were parked mid-success — and are untouched.
update ops.job_heartbeats h
   set consecutive_failures = 0,
       last_error = null
 where h.job_name like 'ingest:%'
   and (h.consecutive_failures <> 0 or h.last_error is not null)
   and ops.ingest_job_parked(h.job_name);

-- Give the researcher fleet a heartbeat, and reap runs that never finished.
--
-- ── THE GAP ───────────────────────────────────────────────────────────────────
-- ops.heartbeat_sentinel() raises an ops.incidents row for any job in
-- ops.job_heartbeats that has not run in 2x its expected interval. It works: the
-- ingest fleet's quote polls and sweeps are all registered and alert correctly.
--
-- The 18 researcher scripts under scripts/researchers/ are registered NOWHERE. So
-- when five of them stopped between 2026-07-20 and 2026-07-31, nothing fired. As of
-- 2026-08-16 they had been silent 16 to 27 days:
--   tadawul_xbrl 20d · adx_fspdf_llm 17d · dfm_fspdf_llm 17d · msx_pdf_llm 16d ·
--   bhb_fs_llm 27d · stockanalysis_financials_* 26d
-- The visible consequence is that Q2 2026 fundamentals exist for 5 of 387 Saudi
-- securities against 47 of 49 Qatari ones — Qatar being the one venue whose
-- researcher (qe_xbrl) is still alive. Nobody was told.
--
-- ── WHY THIS SYNCS RATHER THAN INSTRUMENTS ────────────────────────────────────
-- The obvious fix is a heartbeat helper imported by all 18 scripts. This does the
-- opposite, for three reasons:
--   1. Every researcher ALREADY writes lake.parse_runs on every run — start, status
--      and error. That is a heartbeat; it was simply never projected to where the
--      sentinel looks. The data exists today, for jobs that have been dead for weeks.
--   2. It needs no deploy. The researchers run from the VPS, and Worker Deploy has
--      been failing since 2026-07-18, so an instrumented script would sit in git
--      unmonitored — the exact failure this migration exists to end.
--   3. It cannot drift. A helper can be forgotten in a new script; a projection over
--      parse_runs covers every script that writes a run, including ones not yet written.
--
-- ── ON THE INTERVALS ──────────────────────────────────────────────────────────
-- Deliberately generous. The sentinel alerts at 2x expected_interval_s, so 43200
-- means "tell me after 24h of silence" for a lane that should run every 30m-6h. GCC
-- venues close Friday and Saturday and several researchers are session-bound, so a
-- tight threshold would flap every weekend — and an alert that cries wolf gets muted,
-- which is how a fleet ends up unwatched in the first place. 24h still catches a
-- 16-day death within one day. Session-bound lanes get 48h.
--
-- One-shot and manual keys (mubasher_shares_*, tadawul_eps_reproject, financials_extract,
-- qe_board_profile, tadawul_xbrl_replay, tadawul_financials, tadawul_fspdf_llm,
-- tadawul_xbrl_profile, ohlcv_bulk) are deliberately NOT registered: they are backfills
-- that ran once and are supposed to be silent. Registering them would manufacture
-- permanent false alarms.

-- ─── 1. Which researchers are expected to keep running, and how often ─────────
create table if not exists ops.researcher_registry (
  parser_key          text primary key,
  unit_name           text,
  expected_interval_s int  not null,
  active              boolean not null default true,
  note                text
);

comment on table ops.researcher_registry is
  'The scheduled researcher fleet. A row here means "this lane is expected to keep '
  'producing, and its silence is an incident". Absence means one-shot/backfill/manual. '
  'ops.sync_researcher_heartbeats() projects lake.parse_runs for these keys into '
  'ops.job_heartbeats so ops.heartbeat_sentinel() can see them.';

insert into ops.researcher_registry (parser_key, unit_name, expected_interval_s, active, note) values
  ('tadawul_xbrl',      'marsad-researcher.timer',       43200, true,  'Saudi XBRL statements — timer 6h. The largest venue: 387 of 762 securities.'),
  ('adx_fspdf_llm',     'marsad-adx-gapfill.timer',      43200, true,  'ADX statement PDFs via claude -p — timer 6h.'),
  ('dfm_fspdf_llm',     'marsad-dfm-backfill.timer',     43200, true,  'DFM statement PDFs via claude -p — timer 30m.'),
  ('msx_pdf_llm',       'marsad-msx-stmt-extract.timer', 43200, true,  'MSX member-PDF statement extraction — timer 1h.'),
  ('bhb_fs_llm',        'marsad-bhb-financials.timer',   43200, true,  'Bahrain statements — timer 6h.'),
  ('qe_xbrl',           'marsad-qe-financials.timer',    86400, true,  'Qatar XBRL — session-bound, so 48h to survive a weekend.'),
  ('index_levels',      null,                            86400, true,  'Index tape — session-bound by design (in-session only), so 48h.'),
  ('cross_check',       null,                             7200, true,  'Worker lane, not a researcher, but the same blindness applies.'),
  ('score_batch',       null,                            86400, true,  'Nightly recompute.'),
  ('key_ratios',        null,                            86400, true,  'Nightly recompute.')
on conflict (parser_key) do nothing;

-- The five stockanalysis lanes are the SECOND source behind every corroborated
-- financial statement (see 20260816120000_pe6c). Their silence is why verification
-- stopped earning new objects, so they are registered per-venue rather than in bulk.
insert into ops.researcher_registry (parser_key, unit_name, expected_interval_s, active, note)
select 'stockanalysis_financials_' || v, null, 604800, true,
       'Second extraction source for ' || upper(v) || ' — the corroboration lane behind '
       'financial_statement_xcheck. Weekly cadence, so 14d before it is called silent.'
  from unnest(array['tdwl','adx','dfm','msx','qe','bhb']) as v
on conflict (parser_key) do nothing;

-- ─── 2. Project parse_runs into the sentinel's table ─────────────────────────
create or replace function ops.sync_researcher_heartbeats() returns void
language plpgsql security definer set search_path to ''
as $$
begin
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at,
                                  last_error, consecutive_failures)
  select 'researcher:' || r.parser_key,
         r.expected_interval_s,
         agg.last_run_at,
         agg.last_ok_at,
         agg.last_error,
         agg.consecutive_failures
    from ops.researcher_registry r
    cross join lateral (
      select max(pr.started_at)                                              as last_run_at,
             max(pr.started_at) filter (where pr.status = 'succeeded')       as last_ok_at,
             (select pr2.error from lake.parse_runs pr2
               where pr2.parser_key = r.parser_key and pr2.status = 'failed'
               order by pr2.started_at desc limit 1)                         as last_error,
             -- Consecutive failures = runs since the last success. Any success resets it,
             -- which is the semantics ops.job_unhealthy_reason already assumes.
             (select count(*) from lake.parse_runs pr3
               where pr3.parser_key = r.parser_key
                 and pr3.status = 'failed'
                 and pr3.started_at > coalesce(
                       (select max(pr4.started_at) from lake.parse_runs pr4
                         where pr4.parser_key = r.parser_key and pr4.status = 'succeeded'),
                       '-infinity'::timestamptz))::int                       as consecutive_failures
        from lake.parse_runs pr
       where pr.parser_key = r.parser_key
    ) agg
   where r.active
  on conflict (job_name) do update
    set expected_interval_s  = excluded.expected_interval_s,
        last_run_at          = excluded.last_run_at,
        last_ok_at           = excluded.last_ok_at,
        last_error           = excluded.last_error,
        consecutive_failures = excluded.consecutive_failures;
end $$;

comment on function ops.sync_researcher_heartbeats() is
  'Projects lake.parse_runs into ops.job_heartbeats for every active row in '
  'ops.researcher_registry, so ops.heartbeat_sentinel() can raise on a dead researcher. '
  'parse_runs IS the heartbeat — this only moves it where the sentinel looks.';

-- ─── 3. Reap runs that never finished ────────────────────────────────────────
-- A run left 'running' is worse than a failed one: it is invisible to the failure
-- count above, and if the researcher takes a flock it can wedge every later run.
-- stockanalysis_financials_tdwl has been 'running' since 2026-07-21.
create or replace function ops.reap_stuck_parse_runs(p_age interval default interval '6 hours')
returns int
language plpgsql security definer set search_path to ''
as $$
declare v_n int;
begin
  update lake.parse_runs
     set status      = 'failed',
         finished_at = now(),
         error       = coalesce(error, '') ||
                       case when coalesce(error, '') = '' then '' else ' | ' end ||
                       'reaped: still running after ' || p_age::text
   where status = 'running' and started_at < now() - p_age;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ─── 4. Schedule ─────────────────────────────────────────────────────────────
select cron.unschedule('researcher_heartbeat_sync') where exists
  (select 1 from cron.job where jobname = 'researcher_heartbeat_sync');
select cron.schedule('researcher_heartbeat_sync', '*/5 * * * *',
  $$select ops.sync_researcher_heartbeats()$$);

select cron.unschedule('parse_run_reaper') where exists
  (select 1 from cron.job where jobname = 'parse_run_reaper');
select cron.schedule('parse_run_reaper', '17 * * * *',
  $$select ops.reap_stuck_parse_runs()$$);

-- ─── 5. Run both now, so the fleet's real state is visible immediately ───────
select ops.reap_stuck_parse_runs();
select ops.sync_researcher_heartbeats();
select ops.heartbeat_sentinel();

do $$
declare v_registered int; v_silent int;
begin
  select count(*) into v_registered from ops.job_heartbeats where job_name like 'researcher:%';
  select count(*) into v_silent from ops.job_heartbeats h
   where h.job_name like 'researcher:%' and ops.job_unhealthy_reason(h.job_name) is not null;
  raise notice 'researcher heartbeats: % registered, % unhealthy', v_registered, v_silent;
  if v_registered = 0 then raise exception 'no researcher heartbeats were written'; end if;
end $$;

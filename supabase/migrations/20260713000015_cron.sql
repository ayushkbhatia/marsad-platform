-- 0015_cron — pg_cron registrations (02 §21 as revised: pg_cron only runs
-- set-based SQL or enqueues pgmq messages; the VPS worker executes everything
-- heavy — there are NO Edge Functions). All times UTC; GST = UTC+4.

-- Heartbeat upsert. Pure-SQL cron commands call it as their last statement
-- (pg_cron runs multi-statement commands; a failed job never reaches the
-- beat, so silence still means failure). The VPS worker calls the same
-- function after finishing each queue task, keyed by the pgmq task key.
create or replace function ops.beat(p_job text, p_interval_s int) returns void
language sql security definer set search_path = ''
as $$
  insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at)
  values (p_job, p_interval_s, now(), now())
  on conflict (job_name) do update
    set last_run_at = now(), last_ok_at = now(), consecutive_failures = 0;
$$;
-- 0014's blanket ops-function grant ran before this function existed.
grant execute on function ops.beat(text, int) to marsad_worker;

-- Ingestion scheduler + freshness machine (01 §4.1).
select cron.schedule('ingest_tick',        '*/5 * * * *',
  $$select ingest.enqueue_due_jobs(); select ops.beat('ingest_tick', 300);$$);
select cron.schedule('feed_status_sweep',  '* * * * *',
  $$select ingest.sweep_feed_status(); select ops.beat('feed_status_sweep', 60);$$);
select cron.schedule('queue_reaper',       '*/10 * * * *', $$select ingest.requeue_stuck_jobs(interval '15 minutes')$$);

-- 04:00 GST Marsad Score batch (chunked per venue by the worker).
select cron.schedule('score_batch',        '0 0 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','score_batch'))$$);

-- Wire Brief: assemble 06:00 GST, send 07:30 GST; PM 16:30 GST Sun–Thu (D5).
select cron.schedule('wire_brief_am_assemble', '0 2 * * *',
  $$select pgmq.send('q_email', jsonb_build_object('task','wire_brief','edition','am','step','assemble'))$$);
select cron.schedule('wire_brief_am_send',     '30 3 * * *',
  $$select pgmq.send('q_email', jsonb_build_object('task','wire_brief','edition','am','step','send'))$$);
select cron.schedule('wire_brief_pm',          '30 12 * * 0-4',
  $$select pgmq.send('q_email', jsonb_build_object('task','wire_brief','edition','pm'))$$);

-- 12:00 GST dunning retry batch (SYSTEM actor; worker talks to Stripe and
-- writes billing via the server API path — marsad_worker holds no billing grants).
select cron.schedule('dunning_batch',      '0 8 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','dunning_batch'))$$);

-- 00:05 GST guard job: acts only when the Gulf date is the 1st (02 §21 job 5).
select cron.schedule('monthly_reset_guard', '5 20 * * *', $$select billing.monthly_reset()$$);

-- 02:00 GST nightly omnibus: key_ratios recompute, screen re-runs + diffs,
-- estimate aggregation, dividend-vs-registrar queue, staleness scans,
-- review-due flags, leaderboard MV refresh (worker fans out per batch).
select cron.schedule('nightly_omnibus',    '0 22 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','nightly'))$$);

-- 06:02 GST front-page AM auto-flow (SYSTEM actor version row).
select cron.schedule('frontpage_autoflow', '2 2 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','frontpage_autoflow'))$$);

-- 06:00 GST daily lifecycle: ex-date reminders (ex_date = Gulf today + 2),
-- trial T-3 emails, evergreen review flags, IPO milestone comms.
select cron.schedule('daily_lifecycle',    '0 2 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','daily_lifecycle'))$$);

-- Outbox drain tick: quiet-hours release + dispatch in batches of 500.
select cron.schedule('outbox_drain',       '* * * * *',
  $$select pgmq.send('q_dispatch', jsonb_build_object('task','notify_drain'))$$);

-- Hourly analytics rollups.
select cron.schedule('analytics_rollup',   '15 * * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','analytics_rollup'))$$);

-- During-session housekeeping (Sun–Thu, 05:00–15:00 UTC window): heatmap +
-- movers MV refresh; feed staleness is the per-minute sweep above.
select cron.schedule('session_housekeeping', '*/15 1-11 * * 0-4', $$select public.refresh_market_mvs()$$);

-- Partition pre-create (weekly) + retention (daily) — 02 §21 jobs 12/13.
select cron.schedule('ensure_partitions',  '0 1 * * 0',  $$select ops.ensure_partitions()$$);
select cron.schedule('apply_retention',    '30 1 * * *',
  $$select ops.apply_retention(); select ops.beat('apply_retention', 86400);$$);

-- 01:00 GST PDPL purge: deletion requests past the 30-day grace (worker task —
-- deletes auth.users rows; FKs cascade everywhere except invoices/audit).
select cron.schedule('pdpl_purge',         '0 21 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','pdpl_purge'))$$);

-- 00:05 GST audit chain anchor → ops.audit_anchors + owner email (05 §6.4).
select cron.schedule('audit_anchor_daily', '5 20 * * *', $$select ops.audit_anchor_daily()$$);

-- Job silence detector → ops.incidents (06 §4.1 job 21).
select cron.schedule('heartbeat_sentinel', '*/10 * * * *', $$select ops.heartbeat_sentinel()$$);

-- Prune fetch heartbeats (01 §4.1).
select cron.schedule('fetch_log_prune',    '20 1 * * *',
  $$delete from ingest.fetch_log where fetched_at < now() - interval '30 days'$$);

-- Expected-interval registry so the sentinel knows what silence means.
-- Pure-SQL cron jobs beat themselves (wrapped above); the rest are keyed by
-- the pgmq TASK KEY the VPS worker heartbeats after each run — registering a
-- name nothing writes would open a permanent false incident. last_run_at is
-- seeded to now() so the sentinel grace period starts at deploy, not epoch.
insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at) values
  ('ingest_tick',          300, now()),
  ('feed_status_sweep',     60, now()),
  ('apply_retention',    86400, now()),
  ('score_batch',        86400, now()),
  ('wire_brief',         86400, now()),
  ('nightly',            86400, now()),
  ('notify_drain',          60, now()),
  ('analytics_rollup',    3600, now())
on conflict (job_name) do nothing;

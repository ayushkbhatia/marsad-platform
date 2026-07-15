-- reconcile_heartbeat_registry_retire_notify_drain
--
-- Fixes two live heartbeat-monitoring bugs (audit 2026-07-15, "heartbeat false
-- incidents"). Companion to the worker change in worker/src/consumer.ts.
--
-- BUG 1 — permanent false incidents. 0015 seeded ops.job_heartbeats with
-- task-level rows for pgmq tasks the VPS worker was meant to beat by task key,
-- but the consumer only ever beat the QUEUE-level name ('worker:<queue>'). So
-- every seeded task row went silent forever and ops.heartbeat_sentinel raised a
-- degraded incident per healthy job — and a genuinely failing score_batch was
-- indistinguishable from that permanent noise. The worker now records a
-- per-task heartbeat for q_maintenance/q_dispatch handler runs (consumer.ts, same
-- change), so the registry is reconciled to match what actually beats:
--   KEEP (now beaten): score_batch, nightly            (worker per-task beat)
--   KEEP (unchanged) : ingest_tick, feed_status_sweep, apply_retention
--                                                       (pure-SQL cron self-beat)
--   DROP (no handler — nothing beats them): wire_brief (P2 email, not built),
--        analytics_rollup (not built), notify_drain (retired below).
--
-- BUG 2 — notify_drain poison spam. The outbox_drain pg_cron enqueued a
-- {"task":"notify_drain"} q_dispatch message every minute, but no handler is
-- mapped (notifications are P2), so the worker poison-archived ~1,440 msgs/day.
-- Retire the producer until the notify/alerts system is built (BUILD-STATUS §7
-- DEF-NOTIFY-DRAIN).

-- BUG 2: retire the every-minute notify_drain producer. Guarded so a from-scratch
-- migration replay (0015 creates it) and a re-run are both idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'outbox_drain') then
    perform cron.unschedule('outbox_drain');
  end if;
end $$;

-- BUG 1 + 2: drop registry rows for tasks nothing beats (no handler mapped).
delete from ops.job_heartbeats
where job_name in ('wire_brief', 'analytics_rollup', 'notify_drain');

-- BUG 1: the kept handler-tasks now beat, but their seeded rows are currently
-- stale (never beaten since the 0015 seed). Refresh last_run_at to now() so the
-- sentinel grace window restarts at this deploy and does not re-raise before the
-- worker's next daily run beats them (02:00 GST nightly / 04:00 GST score_batch).
-- expected_interval_s stays 86400 — the worker's recordSuccess preserves it on
-- conflict, so only last_run_at is refreshed here.
update ops.job_heartbeats
   set last_run_at = now()
 where job_name in ('score_batch', 'nightly');

-- Close out the stale false incidents these rows raised. Safe to resolve because
-- either the row is gone (wire_brief/analytics_rollup/notify_drain) or refreshed
-- (score_batch/nightly), so ops.heartbeat_sentinel's not-exists dedup will not
-- re-raise on its next 10-min tick.
update ops.incidents
   set resolved_at = now()
 where resolved_at is null
   and source in ('job:notify_drain', 'job:wire_brief', 'job:analytics_rollup',
                  'job:score_batch', 'job:nightly');

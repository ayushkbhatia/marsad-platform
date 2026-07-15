-- 20260715190000_storage_purge_cron — schedule the consumer for the
-- ops.storage_purge_queue that 20260715185413 introduced (02 §3/§20).
--
-- apply_retention (pg_cron `30 1 * * *`) nulls aged-out lake.snapshots blob
-- pointers and enqueues each freed lake-raw Storage path into
-- ops.storage_purge_queue. Postgres cannot delete the backing Storage object,
-- so the VPS worker's `storage_purge` handler drains the queue via the Storage
-- API and stamps deleted_at. This cron pokes it daily, 15 min after retention
-- (so the day's purge is already enqueued). All times UTC (0015 canon); the
-- consumer aliases `task`→`handler`, so no worker migration is needed.
--
-- No ops.job_heartbeats seed row: the handler self-registers its heartbeat on
-- first run (mirrors ohlcv_accrual), which avoids a false silence-incident in
-- the window before the worker is redeployed with the handler.

select cron.schedule('storage_purge', '45 1 * * *',
  $$select pgmq.send('q_maintenance', jsonb_build_object('task','storage_purge'))$$);

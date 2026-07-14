-- 0030_crosscheck_sweep_dedup — stop crosscheck_sweep from re-enqueueing in-flight keys.
--
-- The 0026 sweep enqueues a cross_check job for every unconsumed staging key with no live object
-- yet, EVERY minute. But a key stays "unconsumed + no object" for the whole window between enqueue
-- and the consumer creating its (single-source PENDING) object — so under any consumer lag the sweep
-- RE-ENQUEUES the same keys every 60s and the queue DIVERGES with duplicates (observed live: ~10k
-- q_pipeline messages for ~2.8k real keys; the consumer churns duplicates of the same tickers instead
-- of reaching new ones, so the OHLCV backfill could not converge).
--
-- Fix: a per-key enqueue COOLDOWN. Stamp lake.staging_rows.swept_at when a key is enqueued; the sweep
-- skips keys swept within the cooldown. A genuinely-new 2nd source arrives as a NEW staging row
-- (swept_at null) so it still enqueues immediately — the cooldown only suppresses re-enqueuing the
-- SAME already-swept rows. A key the consumer fails to objectify re-enqueues once per cooldown (a
-- bounded retry, not a per-minute storm). Once a live object exists the pre-existing guard skips the
-- key anyway, so swept_at only governs the enqueue→object window.

alter table lake.staging_rows add column if not exists swept_at timestamptz;

-- Supports the sweep's scan + the per-key cooldown stamp over unconsumed rows.
create index if not exists staging_rows_sweep_idx
  on lake.staging_rows (natural_key, object_type)
  where consumed_at is null;

create or replace function ops.enqueue_crosscheck_sweep(p_limit int default 500)
  returns int
  language plpgsql
  security definer
  set search_path to ''
as $$
declare
  v_count int := 0;
  -- Enqueue at most once per key per this window (until a live object exists). Long enough that a
  -- reasonably-drained consumer objectifies the key first; short enough that a stuck key still retries.
  v_cooldown constant interval := interval '5 minutes';
  r record;
begin
  for r in
    select sr.natural_key, sr.object_type
    from lake.staging_rows sr
    where sr.consumed_at is null
      and (sr.swept_at is null or sr.swept_at < now() - v_cooldown)
      and not exists (
        select 1
        from lake.objects o
        where o.natural_key = sr.natural_key
          and o.superseded_by is null
          and o.created_at >= sr.ingested_at   -- a live object already reflects this evidence
      )
    group by sr.natural_key, sr.object_type
    order by sr.natural_key
    limit p_limit
  loop
    perform pgmq.send(
      'q_pipeline',
      jsonb_build_object('handler', 'cross_check',
                         'naturalKey', r.natural_key,
                         'objectType', r.object_type));
    -- Cooldown stamp: suppress re-enqueue of THIS key's current unconsumed rows until the cooldown
    -- elapses. A later 2nd-source row for the same key arrives with swept_at=null → enqueues next sweep.
    update lake.staging_rows
       set swept_at = now()
     where natural_key = r.natural_key
       and object_type = r.object_type
       and consumed_at is null;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

grant execute on function ops.enqueue_crosscheck_sweep(int) to marsad_worker;

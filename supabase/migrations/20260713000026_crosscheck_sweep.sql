-- 0026_crosscheck_sweep — periodically drive staged rows through cross-check → lake.objects.
--
-- runTask stages candidate rows (lake.staging_rows) but nothing triggered the cross-check
-- service, so staged data never became lake.objects / public reader tables. This wires a
-- pg_cron sweep that enqueues a `cross_check` pgmq job (q_pipeline, the existing handler) per
-- distinct (natural_key, object_type) that has NEW evidence to fold in.
--
-- WHY the guard (not "all unconsumed"): a SINGLE-SOURCE candidate creates a PENDING lake.object
-- but INTENTIONALLY leaves its staging row unconsumed (CONTRACT §7: held so a genuinely distinct
-- 2nd source in a later pass is gathered alongside it → VERIFIED). Filings are always single-source
-- and quotes are single-source until their cross-check partner (Yahoo) lands, so a naive "enqueue
-- every unconsumed row" sweep would re-enqueue those keys every minute forever (resolve() no-ops
-- once the live object exists, but the q_pipeline churn is pure waste). The guard enqueues a key
-- only when there is unconsumed staging AND no live object already reflects it (no live object, OR
-- the staging is NEWER than the live object's created_at = genuinely new evidence, e.g. the 2nd
-- source arriving or a changed value). Steady-state single-source keys are skipped.

create or replace function ops.enqueue_crosscheck_sweep(p_limit int default 500)
  returns int
  language plpgsql
  security definer
  set search_path to ''
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select sr.natural_key, sr.object_type
    from lake.staging_rows sr
    where sr.consumed_at is null
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
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

grant execute on function ops.enqueue_crosscheck_sweep(int) to marsad_worker;

-- Every minute (pg_cron floor). Cross-check is not latency-critical (delayed data), and the guard
-- keeps each run to just keys with new evidence. Heartbeat so the 33a sentinel doesn't flag it.
select cron.schedule('crosscheck_sweep', '* * * * *',
  $$select ops.enqueue_crosscheck_sweep(); select ops.beat('crosscheck_sweep', 60);$$);

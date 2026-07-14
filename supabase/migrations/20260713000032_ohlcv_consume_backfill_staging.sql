-- 0032_ohlcv_consume_backfill_staging — stop the crosscheck_sweep from re-churning objectified
-- Yahoo-backfill OHLCV keys (the permanent fix for the dup-churn found 2026-07-14).
--
-- THE PROBLEM: cross_check holds a single-source PENDING key's staging UNCONSUMED (CONTRACT §7) so a
-- genuinely-distinct 2nd source in a later pass is gathered alongside it → VERIFIED. That is correct
-- for quotes/filings/recent-bulletin bars. But a Yahoo *backfill* bar (a 2-year-old daily close) is
-- single-source FOREVER — no going-forward venue bulletin ever cross-checks a historical bar. So its
-- staging sits unconsumed permanently, and once a re-run stages the same key again (a second staging
-- row with a newer ingested_at than the already-created object), the sweep's "new evidence" guard
-- (object.created_at >= staging.ingested_at) is FALSE for that newer row → the key is re-enqueued
-- every cooldown → cross_check resolves it to the existing object (a no-op) → the queue fills with
-- tens of thousands of no-op messages that starve the real un-objectified keys (observed: 44k dup
-- messages churning QE while DFM/TDWL never materialized). 0030's swept_at cooldown only bounds the
-- RATE; this removes the CAUSE.
--
-- THE FIX: when an OHLCV.CLOSE object is created, consume the staging rows for that key that came from
-- an `ohlcv_backfill` source. Scoped to backfill sources only, so an eod_bulletin-sourced OHLCV key
-- still keeps its staging for a legitimate Yahoo-vs-bulletin 2-source verify. Historical backfill
-- staging is done the moment its bar exists — the object (and the ohlcv_daily bar via 0028) already
-- carry the value; nothing is lost by consuming it.

set search_path = '';

create or replace function lake.fn_consume_ohlcv_backfill_staging() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update lake.staging_rows sr
     set consumed_at = now()
    from ingest.sources src
   where sr.source_id = src.id
     and src.data_type = 'ohlcv_backfill'
     and sr.object_type = 'OHLCV.CLOSE'
     and sr.natural_key = new.natural_key
     and sr.consumed_at is null;
  return null;
end $$;

-- AFTER INSERT only: the backfill bar is single-source, so its object is created once and never
-- UPDATE-verified. (A 2-source upgrade path for recent bulletin bars is untouched — those are not
-- ohlcv_backfill-sourced, so this trigger does not consume their staging.)
drop trigger if exists objects_ohlcv_consume_backfill on lake.objects;
create trigger objects_ohlcv_consume_backfill after insert on lake.objects
  for each row when (new.object_type = 'OHLCV.CLOSE')
  execute function lake.fn_consume_ohlcv_backfill_staging();

-- One-time cleanup: consume any already-objectified backfill OHLCV staging still sitting unconsumed
-- (the keys this trigger will handle going forward). Idempotent.
update lake.staging_rows sr
   set consumed_at = now()
  from ingest.sources src
 where sr.source_id = src.id
   and src.data_type = 'ohlcv_backfill'
   and sr.object_type = 'OHLCV.CLOSE'
   and sr.consumed_at is null
   and exists (
     select 1 from lake.objects o
     where o.natural_key = sr.natural_key and o.object_type = 'OHLCV.CLOSE' and o.superseded_by is null
   );

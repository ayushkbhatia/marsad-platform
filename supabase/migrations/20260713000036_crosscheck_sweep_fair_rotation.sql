-- 0036_crosscheck_sweep_fair_rotation — stop one venue starving the others in crosscheck_sweep.
--
-- 0026 selected the sweep batch with `order by natural_key limit 500`. natural_key is
-- `OBJECT_TYPE:VENUE:SYMBOL:DATE`, so that global ascending order is a fixed pecking order across
-- venues: FILING.REF:* < OHLCV.CLOSE:DFM < OHLCV.CLOSE:QE < OHLCV.CLOSE:TDWL < QUOTE.LAST:TDWL.
-- Whichever venue sorts smallest monopolises every 500-key window; venues further down never get a
-- slot. 0030's per-key cooldown did NOT fix this: traversing one venue's backlog at 500/min takes far
-- longer (DFM ~11k eligible ≈ 23 min) than the 5-min cooldown, so the smallest keys come back off
-- cooldown and re-enter before the cursor ever reaches the next venue. The cursor oscillates inside the
-- lexicographically-first venue forever.
--
-- Observed live (2026-07-14): q_pipeline held 21.6k messages that were 100% DFM (4.9k distinct keys,
-- ~4.5x duplicated); QE was re-starved and TDWL — the largest venue, 125k keys, ingested last and
-- sorting last — had swept_at=0 / consumed_at=0 on every row. Never touched, not merely slow.
--
-- Fix: fair round-robin across venues. Rank each venue's eligible keys independently (oldest evidence
-- first) and fill the batch rank-first — every venue's rank-1 key, then every venue's rank-2, and so on
-- — so each active venue gets ~limit/venues slots per run regardless of alphabetical position. A venue
-- with fewer eligible keys than its share simply drops out of the lower ranks and the remaining budget
-- flows to the deeper venues (the `limit` fills straight down the rank ladder). The 0030 cooldown +
-- live-object guard are preserved verbatim; only the ORDER of selection changes.

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
    with eligible as (
      select sr.natural_key,
             sr.object_type,
             sr.venue_code,
             min(sr.ingested_at) as first_ingested
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
      group by sr.natural_key, sr.object_type, sr.venue_code
    ),
    ranked as (
      -- Rank within each venue by arrival (oldest first). row_number gives every venue its own
      -- 1..N ladder independent of how the keys sort lexicographically.
      select natural_key,
             object_type,
             venue_code,
             row_number() over (
               partition by venue_code
               order by first_ingested, natural_key
             ) as rn
      from eligible
    )
    -- Round-robin: take rank 1 of every venue, then rank 2 of every venue, ... until the budget is
    -- spent. This interleaves venues fairly; no single venue can occupy the whole window.
    select natural_key, object_type
    from ranked
    order by rn, venue_code
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

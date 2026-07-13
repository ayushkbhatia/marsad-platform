-- 0028_ohlcv_daily — populate public.ohlcv_daily (P1.7a, 07-lake-enrichment.md family B).
--
-- THE GAP THIS CLOSES
-- The lake ingests quotes + filings and materializes lake.objects, but nothing
-- projected OHLCV.CLOSE objects into public.ohlcv_daily — the price-history table
-- the charts and the Score's Momentum factor (≥126 daily bars) both require. The
-- only pre-existing lake→public projection (0007 fn_datapoint_fanout) targets
-- public.datapoints and only fires PENDING→VERIFIED; OHLCV bars carry no
-- metric_key and (see below) stay PENDING, so they were never projected anywhere.
--
-- TWO WRITE PATHS INTO ohlcv_daily (both idempotent on the PK (security_id, trade_date)):
--
--   (a) lake.objects (OHLCV.CLOSE) → ohlcv_daily.  Trigger lake.fn_ohlcv_daily_project()
--       below. Fires AFTER INSERT *and* UPDATE. WHY BOTH: ohlcv_daily is a plain
--       historical series, NOT a 2-source-VERIFIED fact. A backfill bar (Yahoo-only)
--       or a lone venue-bulletin bar has a single source, so cross-check INSERTs it
--       PENDING and never UPDATEs it (owner decision D-src-1: per-venue verification
--       tier; delayed, non-price-sensitive prices persist at single source). A
--       VERIFIED-only / UPDATE-only trigger (like the datapoint fan-out) would miss
--       every backfill bar. So we project on state in ('PENDING','VERIFIED'); a later
--       2nd source that UPGRADES the same key to VERIFIED simply re-fires the upsert
--       (converges for free). security_id must be resolved (guarded) — a NULL
--       security_id means securities is not yet bootstrapped (see 0029); such objects
--       are skipped and re-projected when the object is later revised with a resolved id.
--
--   (b) EOD accrual from the quote board close — public.accrue_ohlcv_from_quotes(date).
--       One bar/security/trading-day for ALL 6 venues going forward, from
--       public.quotes_latest, independent of whether a venue EOD-bulletin adapter
--       exists yet. This is the "start a daily EOD snapshot job now so history accrues
--       regardless of backfill depth" guarantee. The worker's ohlcv_accrual handler
--       calls it at close+; venue EOD bulletins (higher fidelity) layer over the same
--       bar via path (a)'s upsert as their adapters land.
--
-- DELAYED-DATA HONESTY: every close projected here is ≥15-min delayed at source
-- (quotes) or an official EOD figure (bulletin/Yahoo). ohlcv_daily is end-of-day
-- history — no realtime claim is made or implied.

set search_path = '';

-- Speeds the trigger's per-row work and any (security_id, trade_date desc) read the
-- Momentum compute will issue over ohlcv_daily. The PK already covers this order,
-- but an explicit desc index documents the read pattern and helps range scans.
create index if not exists ohlcv_daily_sec_date_desc
  on public.ohlcv_daily (security_id, trade_date desc);

-- ---------------------------------------------------------------------------
-- (a) lake.objects (OHLCV.CLOSE) → public.ohlcv_daily projection trigger.
--
-- Mirrors the fn_datapoint_fanout pattern (0007) — a proven projection off
-- lake.objects — but fires on INSERT as well as UPDATE and does an idempotent
-- upsert keyed by the ohlcv_daily PK. The payload IS the NormalizedOhlcv row
-- (camelCase keys: open/high/low/close/volume/valueTraded); numeric_value carries
-- the close, effective_date the trade date (runtime.mapOhlcv).

create or replace function lake.fn_ohlcv_daily_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Only OHLCV close objects, only once a security_id is resolved, only in a
  -- persistable state. RETIRED/CONFLICT bars are not projected.
  if new.object_type <> 'OHLCV.CLOSE' then return null; end if;
  if new.security_id is null then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.effective_date is null or new.numeric_value is null then return null; end if;

  insert into public.ohlcv_daily
    (security_id, trade_date, open, high, low, close, volume, value_traded)
  values (
    new.security_id,
    new.effective_date,
    nullif(new.payload ->> 'open',  '')::numeric,
    nullif(new.payload ->> 'high',  '')::numeric,
    nullif(new.payload ->> 'low',   '')::numeric,
    new.numeric_value,
    nullif(new.payload ->> 'volume','')::numeric,
    nullif(new.payload ->> 'valueTraded','')::numeric
  )
  on conflict (security_id, trade_date) do update set
    open         = excluded.open,
    high         = excluded.high,
    low          = excluded.low,
    close        = excluded.close,
    volume       = excluded.volume,
    value_traded = excluded.value_traded;

  return null;
end $$;

-- Two triggers (INSERT and UPDATE) rather than one FOR EACH ROW on both events,
-- so each stays simple and the INSERT path catches the single-source PENDING bar
-- that never receives an UPDATE.
drop trigger if exists objects_ohlcv_project_ins on lake.objects;
create trigger objects_ohlcv_project_ins after insert on lake.objects
  for each row when (new.object_type = 'OHLCV.CLOSE')
  execute function lake.fn_ohlcv_daily_project();

drop trigger if exists objects_ohlcv_project_upd on lake.objects;
create trigger objects_ohlcv_project_upd after update on lake.objects
  for each row when (new.object_type = 'OHLCV.CLOSE')
  execute function lake.fn_ohlcv_daily_project();

-- ---------------------------------------------------------------------------
-- (b) EOD accrual: project the day's quote-board close into one ohlcv_daily bar
--     per listed security, for ALL 6 venues. Reads public.quotes_latest (the hot
--     row updated by the quote pollers) and INSERTS missing (security_id, date) bars.
--
-- Uses quotes_latest.open/high/low/volume when the board carries them; close is
-- quotes_latest.last (the delayed board close). Only securities whose board was
-- captured ON the given trading day contribute (as_of::date = p_trade_date in the
-- venue's local tz), so a stale row from a prior session cannot mint a bogus bar.
--
-- FIDELITY RULE (why ON CONFLICT DO NOTHING, not DO UPDATE): the delayed quote
-- board is the LOWEST-fidelity OHLCV source. A venue EOD bulletin or a Yahoo bar
-- (both official EOD figures, landed via path (a)) carry the authoritative close
-- AND real turnover. Board accrual must therefore be purely ADDITIVE — it fills
-- days for which no higher-fidelity bar exists yet, and MUST NOT clobber an
-- existing bar. ohlcv_daily has no per-row provenance column, so we cannot tell a
-- board-derived row from a bulletin one at conflict time; the safe rule is: never
-- overwrite. Ordering-independent — whether the bulletin lands before or after the
-- nightly accrual, the authoritative bar always wins (path (a)'s upsert overwrites
-- a prior board bar; this accrual leaves a prior bulletin bar untouched).
--
-- value_traded is left to the higher-fidelity sources: it is REAL turnover
-- (sum of price×qty per trade) in the bulletins, NOT volume×last. We deliberately
-- do not fabricate volume×last here (the movers/heatmap MVs already approximate
-- that on the fly) so a persisted value_traded always means genuine turnover.
-- Idempotent: re-running for the same date is a no-op on already-present bars.

create or replace function public.accrue_ohlcv_from_quotes(p_trade_date date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  with board as (
    select q.security_id,
           q.last                                   as close,
           q.open, q.high, q.low, q.volume
    from public.quotes_latest q
    join public.securities s on s.id = q.security_id
    join public.venues v on v.code = s.venue_code
    where s.status = 'listed'
      and q.last is not null
      -- board must have been captured on the target trading day (venue-local date)
      and (q.as_of at time zone v.timezone)::date = p_trade_date
  ),
  upserted as (
    insert into public.ohlcv_daily
      (security_id, trade_date, open, high, low, close, volume, value_traded)
    select b.security_id, p_trade_date, b.open, b.high, b.low, b.close, b.volume, null
    from board b
    -- Additive only: a higher-fidelity (bulletin/Yahoo) bar for the same
    -- (security_id, trade_date) is authoritative and is never overwritten here.
    on conflict (security_id, trade_date) do nothing
    returning 1
  )
  select count(*)::int into v_count from upserted;
  return v_count;
end $$;

comment on function public.accrue_ohlcv_from_quotes(date) is
  'P1.7a EOD accrual: insert one ohlcv_daily bar/security for p_trade_date from the '
  'delayed quote-board close (all 6 venues), ADDITIVE ONLY (on conflict do nothing) so '
  'a higher-fidelity bulletin/Yahoo bar is never overwritten. Idempotent on (security_id, trade_date).';

-- Heartbeat row so ops.heartbeat_sentinel can alert if the nightly accrual goes silent.
insert into ops.job_heartbeats (job_name, expected_interval_s)
values ('ohlcv_accrual', 24 * 60 * 60)
on conflict (job_name) do nothing;

-- ---------------------------------------------------------------------------
-- Schedule the daily accrual (path b). WITHOUT this the handler is registered and
-- the heartbeat above is seeded, but nothing ever enqueues the job — so history
-- never accrues AND heartbeat_sentinel would raise a false "job silent" incident
-- within 2 days. The consumer routes on the `handler`/`task` key (worker
-- consumer.ts), so we pgmq.send the ohlcv_accrual envelope; the handler defaults
-- tradeDate to the current UTC date, which equals the venue-local trade date for
-- all 6 GCC venues (UTC+3/+4) at this hour.
--
-- 18:00 UTC daily: AFTER every GCC venue's close (latest ~12:00 UTC / TDWL 15:00
-- AST) so the board is the settled delayed close, and BEFORE the 22:00 UTC
-- nightly_omnibus that reads ohlcv_daily to recompute key_ratios/Momentum.
-- cron.schedule upserts by job name (idempotent re-run). Guarded so a DB without
-- pg_cron (shadow/CI) still applies the migration.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'ohlcv_accrual',
      '0 18 * * *',
      $cron$select pgmq.send('q_pipeline', jsonb_build_object('handler','ohlcv_accrual'))$cron$
    );
  end if;
end $$;

-- 20260720163000_index_level_project — project INDEX.LEVEL lake.objects → public.index_levels
-- + public.index_levels_daily (the index tape the reader front page leads with).
--
-- THE GAP THIS CLOSES
-- The lake has a NormalizedIndexLevel contract (core/types.ts §6.2), a mapIndex staging mapper
-- (runtime.ts → INDEX.LEVEL objects, natural_key INDEX.LEVEL:{venue}:{indexCode}:{session-date}),
-- and — as of the sibling cross-check change — INDEX.LEVEL in LIVE_LATEST_TYPES so a single-source
-- index refreshes intraday instead of freezing at the day's first poll. But NOTHING projected those
-- objects into the serving tables: public.index_levels and public.index_levels_daily are EMPTY
-- all-time for every venue, so the reader's index tape has no data. This is the endpoint-INDEPENDENT
-- wiring: the moment a producer emits an INDEX.LEVEL object, it flows to both serving tables. The
-- per-venue index-level ENDPOINTS (WAF/session-gated) are captured separately (see the adapter
-- scaffold ingestion/src/adapters/adx/indices.ts + docs/BUILD-STATUS.md).
--
-- Mirrors the proven object→serving projections: fn_quote_project (0031) and fn_ohlcv_daily_project
-- (0028). SECURITY DEFINER, search_path '', fires AFTER INSERT *and* UPDATE, state in
-- ('PENDING','VERIFIED') — an index is single-source-authoritative (the bourse publishes its own
-- headline index; there is no second exchange to cross-check it against, owner D-src-1), so it lands
-- PENDING and never receives a VERIFIED-only UPDATE; a VERIFIED-only trigger would miss every index
-- print. INDEX.LEVEL is also a LIVE_LATEST feed, so cross-check refreshes the day's object IN PLACE
-- on each poll (an UPDATE) — the UPDATE trigger is what advances the tape intraday.
--
-- PAYLOAD SHAPE (runtime.mapIndex): the object payload IS the NormalizedIndexLevel row, camelCase —
-- indexCode / level / change / changePct / dayHigh / dayLow / valueTraded / asOf. numeric_value = level
-- (the authoritative scalar, like close/last on the OHLCV/quote paths); effective_date = the UTC
-- session date the runtime stamped (dateOnly(asOf)). We read the LEVEL from numeric_value and the
-- ancillary fields from the payload, exactly as fn_ohlcv_daily_project reads open/high/low from payload
-- and close from numeric_value.
--
-- DELAYED-DATA HONESTY: every level projected here is the venue's delayed/official index print. No
-- realtime claim is made or implied.

set search_path = '';

-- ---------------------------------------------------------------------------
-- Read index reads: latest level per index (the tape) and the daily OHLC series.
create index if not exists index_levels_code_asof_desc
  on public.index_levels (index_code, as_of desc);

-- ---------------------------------------------------------------------------
-- INDEX.LEVEL → public.index_levels (intraday tape, PK (index_code, as_of)) +
--               public.index_levels_daily (incremental OHLC, PK (index_code, trade_date)).

create or replace function lake.fn_index_level_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_code  text        := nullif(new.payload ->> 'indexCode','');
  v_level numeric      := new.numeric_value;                     -- level (authoritative scalar)
  v_asof  timestamptz  := nullif(new.payload ->> 'asOf','')::timestamptz;
  v_tz    text;
  v_trade_date date;
begin
  -- Only INDEX.LEVEL objects, only in a persistable state (mirror fn_ohlcv_daily_project).
  if new.object_type <> 'INDEX.LEVEL' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;

  -- Null guard (index_levels.level + index_levels_daily.close are NOT NULL; as_of + index_code are
  -- PK parts, also NOT NULL): never insert without a valid level, a valid as_of, and an index code.
  if v_level is null then return null; end if;
  if new.effective_date is null then return null; end if;
  if v_code is null or v_asof is null then return null; end if;

  -- (a) intraday tape row keyed by (index_code, as_of). A re-projected same-timestamp print
  --     refreshes in place (ON CONFLICT DO UPDATE); a genuinely later print time appends a new
  --     tick. The reader takes DISTINCT ON (index_code) ... ORDER BY as_of DESC for the live tape.
  insert into public.index_levels
    (index_code, as_of, level, change, change_pct, day_high, day_low, value_traded)
  values (
    v_code,
    v_asof,
    v_level,
    nullif(new.payload ->> 'change','')::numeric,
    nullif(new.payload ->> 'changePct','')::numeric,
    nullif(new.payload ->> 'dayHigh','')::numeric,
    nullif(new.payload ->> 'dayLow','')::numeric,
    nullif(new.payload ->> 'valueTraded','')::numeric
  )
  on conflict (index_code, as_of) do update set
    level        = excluded.level,
    change       = excluded.change,
    change_pct   = excluded.change_pct,
    day_high     = excluded.day_high,
    day_low      = excluded.day_low,
    value_traded = excluded.value_traded;

  -- (b) daily OHLC bar keyed by (index_code, trade_date) where trade_date is the as_of's
  --     VENUE-LOCAL date (mirror accrue_ohlcv_from_quotes: (ts at time zone v.timezone)::date), so a
  --     print at 23:30 UTC that is still the same local session lands on the right day. Fall back to
  --     the UTC session date the runtime stamped (new.effective_date) when the venue tz is unknown.
  select v.timezone into v_tz from public.venues v where v.code = new.venue_code;
  if v_tz is not null then
    v_trade_date := (v_asof at time zone v_tz)::date;
  else
    v_trade_date := new.effective_date;
  end if;

  -- Incremental OHLC, last-writer-wins on close (mirror fn_ohlcv_daily_project's idempotent upsert):
  --   open  = the first level seen this session (coalesce keeps it),
  --   high  = running max, low = running min (GREATEST/LEAST skip NULLs),
  --   close = the latest level (this print).
  insert into public.index_levels_daily
    (index_code, trade_date, open, high, low, close)
  values (v_code, v_trade_date, v_level, v_level, v_level, v_level)
  on conflict (index_code, trade_date) do update set
    open  = coalesce(public.index_levels_daily.open, excluded.open),
    high  = greatest(public.index_levels_daily.high, excluded.high),
    low   = least(public.index_levels_daily.low, excluded.low),
    close = excluded.close;

  return null;
end $$;

-- Two triggers (INSERT and UPDATE), mirroring the OHLCV/quote projections. The INSERT path catches
-- the day's first single-source print; the UPDATE path catches every subsequent LIVE_LATEST in-place
-- refresh (cross-check.refreshLiveValue) so the tape advances intraday. The WHEN clause pre-filters on
-- object_type + persistable state so the function body only runs for rows it will actually project.
drop trigger if exists objects_index_project_ins on lake.objects;
create trigger objects_index_project_ins after insert on lake.objects
  for each row when (new.object_type = 'INDEX.LEVEL' and new.state in ('PENDING','VERIFIED'))
  execute function lake.fn_index_level_project();

drop trigger if exists objects_index_project_upd on lake.objects;
create trigger objects_index_project_upd after update on lake.objects
  for each row when (new.object_type = 'INDEX.LEVEL' and new.state in ('PENDING','VERIFIED'))
  execute function lake.fn_index_level_project();

-- ---------------------------------------------------------------------------
-- RLS: public.index_levels and public.index_levels_daily ALREADY carry a `world_read` SELECT policy
-- for {anon, authenticated} (qual true) plus `worker_all` for marsad_worker (verified against live
-- 2026-07-20, pg_policies). The anon-read the reader needs is already in place, so this migration adds
-- NO policy. (Left as a comment rather than a redundant DO-block create so the intent is explicit.)

-- ---------------------------------------------------------------------------
-- DORMANT UNTIL A PRODUCER EMITS INDEX.LEVEL. This projection is the endpoint-INDEPENDENT backbone:
-- it is fully wired and provable now (see scratchpad/index_projection_proof.sql — a synthetic
-- INDEX.LEVEL object flows to both serving tables), but it stays inert until a per-venue index-level
-- producer lands actual INDEX.LEVEL objects. That producer needs the real per-venue index endpoint +
-- field paths, which are WAF/session-gated and captured at market open (tracked separately;
-- ingestion/src/adapters/adx/indices.ts is the documented scaffold, mounted on the ADX adapter's
-- `indices` slot but not runnable until the endpoint is pinned and a DB source seeded).

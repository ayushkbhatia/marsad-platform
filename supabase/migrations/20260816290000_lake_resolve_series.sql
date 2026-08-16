-- PD.6a — a SERIES, from a lake that only stores scalars.
--
-- ── THE PROBLEM THE CHART FAMILY IS ACTUALLY BLOCKED ON ───────────────────────
-- One lake.objects row is ONE scalar plus a small payload: OHLCV.CLOSE:TDWL:9558:2026-02-26
-- is a single day's bar. And ChartSeries (ingestion/src/blocks/d-charts.ts) names ONE object:
-- `{label, object_id, field}`. So a 12-quarter BLK-LINE has one point, and every one of the 15
-- D-family blocks is undrawable — not for want of a compiler, but for want of a series.
--
-- ── THE EXPANSION, AND WHY THIS SHAPE ─────────────────────────────────────────
-- The bound object is treated as a CURSOR INTO ITS OWN FAMILY: same object_type, same security,
-- ordered by date. The writer keeps binding one object — the payload contract does not change —
-- and the renderer asks for as many points back as the block needs.
--
-- Considered and rejected:
--   · the writer emits N bindings — puts chart geometry in the payload and blows the token
--     budget on a 12-point line;
--   · populate public.datapoint_series — the cleaner long-run answer, and both tables already
--     exist and are empty, but it needs a PRODUCER, and this must work with no producer
--     dependency because that is the whole point of the PD track being parallel to PE.
--
-- ── EVERY POINT KEEPS ITS OWN object_id ───────────────────────────────────────
-- Not a nicety. The binding contract's promise is that a printed figure traces to an object; a
-- series that returned bare numbers would break that promise twelve times per chart and leave
-- BLK-PROV under the exhibit stamping one row while eleven others went unattributed. It also
-- makes a correction work the same way for a chart as for a sentence.
--
-- CONFLICT and superseded objects are excluded here rather than downstream: a disputed point
-- silently plotted is worse than a gap, because a gap is visible.

create or replace function lake.fn_resolve_series(
  p_object_id uuid,
  p_field     text default null,
  p_limit     int  default 12
) returns table (
  x_label    text,
  x_date     date,
  y          numeric,
  unit       text,
  object_id  uuid,
  state      text
)
language plpgsql stable security definer set search_path to ''
as $$
declare
  v_type text;
  v_sec  bigint;
  v_kind text;
begin
  select o.object_type, o.security_id, o.payload ->> 'period_kind'
    into v_type, v_sec, v_kind
    from lake.objects o where o.id = p_object_id;
  if v_type is null or v_sec is null then return; end if;

  return query
  with fam as (
    select o.id,
           o.state::text                                as st,
           o.created_at                                 as created,
           o.unit                                       as un,
           lake.fn_object_event_date(o.*)               as dt,
           coalesce(
             -- A dotted field reads into the payload: 'line_items.revenue'.
             case when p_field is null then null
                  else (select (jsonb_extract_path_text(o.payload, variadic string_to_array(p_field, '.')))::numeric) end,
             o.numeric_value
           )                                            as val,
           coalesce(o.payload ->> 'fiscal_period',
                    o.payload ->> 'period_end',
                    lake.fn_object_event_date(o.*)::text) as lbl
      from lake.objects o
     where o.object_type = v_type
       and o.security_id = v_sec
       and o.superseded_by is null
       and o.state <> 'CONFLICT'
       -- ONE PERIOD KIND PER SERIES. Without this the walk returns annuals beside quarters —
       -- measured on QNB net income: 2024 at 16.9bn sitting between Q1 2025 and Q2 2025 at
       -- ~4.3bn. Plotted, that is a spike the company never had. A chart that mixes bases is a
       -- false chart, not an imprecise one.
       and (v_kind is null or o.payload ->> 'period_kind' is not distinct from v_kind)
  ),
  -- ONE POINT PER PERIOD. The same company-quarter is routinely represented by more than one
  -- object (a venue extraction and a researcher pass), and both would plot at the same x —
  -- measured: Q2 2026 appeared twice, identical value. Prefer the better-evidenced object, then
  -- the most recent, so the choice is deterministic rather than whichever row the planner met.
  ranked as (
    select fam.*,
           row_number() over (
             partition by fam.dt
             order by case fam.st when 'VERIFIED' then 0 when 'PENDING' then 1 else 2 end,
                      fam.created desc
           ) as rn
      from fam
     where fam.val is not null
  )
  select r.lbl, r.dt, r.val, r.un, r.id, r.st
    from (
      select * from ranked where ranked.rn = 1
       order by ranked.dt desc
       limit greatest(p_limit, 1)
    ) r
  -- Newest N chosen, then returned OLDEST FIRST: a chart reads left to right.
  order by r.dt asc;
exception
  -- A malformed field path or an unparseable payload value must yield an empty series, never
  -- abort the page. An empty series renders as the honest gap the block already draws.
  when others then return;
end $$;

comment on function lake.fn_resolve_series(uuid, text, int) is
  'Expand a bound lake object into a time series by walking its own family (same object_type, '
  'same security, ordered by event date). Every point carries its own object_id so provenance '
  'survives the aggregation — a series of bare numbers would break the binding contract once '
  'per point. CONFLICT and superseded objects are excluded: a disputed point silently plotted '
  'is worse than a visible gap.';

grant execute on function lake.fn_resolve_series(uuid, text, int) to anon, authenticated, service_role, marsad_worker;

do $$
declare v_anchor uuid; v_n int; v_distinct int;
begin
  -- A statement object with real history: the series must return more than the anchor.
  select o.id into v_anchor
    from lake.objects o
   where o.object_type = 'FILING.FINANCIALS' and o.security_id is not null
     and o.superseded_by is null
   order by o.created_at desc limit 1;
  if v_anchor is null then return; end if;

  select count(*), count(distinct s.object_id) into v_n, v_distinct
    from lake.fn_resolve_series(v_anchor, null, 12) s;

  raise notice 'resolve_series: % points, % distinct objects from one anchor', v_n, v_distinct;

  -- The promise this function exists to keep: every point is attributable.
  if v_n > 0 and v_distinct <> v_n then
    raise exception 'a series point has no distinct object_id — provenance would be lost';
  end if;

  -- One point per period, or the chart double-plots a quarter.
  if exists (
    select 1 from lake.fn_resolve_series(v_anchor, null, 24) s
     group by s.x_date having count(*) > 1
  ) then
    raise exception 'resolve_series returned more than one point for a period';
  end if;
end $$;

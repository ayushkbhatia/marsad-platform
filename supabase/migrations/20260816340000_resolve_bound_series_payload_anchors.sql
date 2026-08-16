-- ─────────────────────────────────────────────────────────────────────────────
-- resolve_bound_series: admit series anchors that live INSIDE a block's payload.
--
-- The original guard (20260816310000) accepted only `content_blocks.bound_object_id`. That is
-- the right shape for a scalar block, which binds exactly one figure. It is the wrong shape for
-- a chart: BLK-BARS binds one object PER CATEGORY and BLK-AREA up to three series, and a row has
-- only one `bound_object_id`. Every category past the first would have silently resolved to an
-- empty series — a bar chart missing most of its bars, with no error anywhere.
--
-- The guard therefore widens to "this object is bound by a live block", by either surface: the
-- column, or a `series[].object_id` in the payload. It does NOT widen to "any object in a
-- payload" — the scope that matters is still published content, which is what keeps this from
-- being a read primitive over the lake and what keeps the paywall (RLS on content_blocks) in
-- force.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create or replace function public.resolve_bound_series(
  p_object_id uuid,
  p_field     text default null,
  p_limit     int  default 12
) returns table (
  x_label   text,
  x_date    date,
  y         numeric,
  unit      text,
  object_id uuid,
  state     text
)
language plpgsql stable security definer set search_path to ''
as $$
begin
  if not exists (
    select 1
      from public.content_blocks b
      join public.content_items ci on ci.id = b.content_id
     where ci.status = 'live'
       and (
         b.bound_object_id = p_object_id
         or exists (
           select 1
             from jsonb_array_elements(
                    case when jsonb_typeof(b.body -> 'series') = 'array'
                         then b.body -> 'series' else '[]'::jsonb end) e
            where (e ->> 'object_id')::uuid = p_object_id
         )
       )
  ) then
    return;
  end if;

  -- Bounded by the caller, but capped here too: a chart is a dozen points, not a data export.
  return query
    select s.x_label, s.x_date, s.y, s.unit, s.object_id, s.state
      from lake.fn_resolve_series(p_object_id, p_field, least(greatest(p_limit, 1), 60)) s;
end $$;

comment on function public.resolve_bound_series(uuid, text, int) is
  'Series behind a chart on a PUBLISHED piece. An object qualifies if a live content_block binds '
  'it by column OR names it in payload series[] — a chart binds one object per series, and a row '
  'has one bound_object_id. Scoped to live content because an RPC takes its id from the caller: '
  'an unguarded wrapper would be a read primitive over all 790k lake objects, and resolving via '
  'a service-role client would run with RLS off and defeat the paywall on content_blocks.';

revoke all on function public.resolve_bound_series(uuid, text, int) from public;
grant execute on function public.resolve_bound_series(uuid, text, int) to anon, authenticated, service_role;

do $$
declare v_rows int;
begin
  -- The invariant the widening must not break: an object nothing publishes still yields nothing.
  select count(*) into v_rows
    from public.resolve_bound_series(
      (select o.id
         from lake.objects o
        where not exists (select 1 from public.content_blocks b where b.bound_object_id = o.id)
        limit 1), null, 5);
  if v_rows <> 0 then
    raise exception 'resolve_bound_series returned a series for an unbound object';
  end if;
end $$;

commit;

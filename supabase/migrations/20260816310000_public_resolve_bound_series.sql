-- The reader's window onto a series, scoped exactly like the bound-object view.
--
-- lake.fn_resolve_series is the series contract, but `lake` is not PostgREST-exposed and anon
-- holds no USAGE on it, so a chart renderer cannot call it. The naive fix is a service-role
-- call, and that is the paywall bypass this codebase has already refused once: RLS on
-- public.content_blocks is the ONLY thing withholding gated blocks, and a service-role reader
-- runs with RLS off.
--
-- ── AND A SECOND EXPOSURE THE VIEW ALREADY SOLVED ─────────────────────────────
-- An RPC is not a view: anon passes the object id, so an unguarded wrapper would let anyone
-- walk ANY family in the lake — 790,000 objects — by guessing a uuid. So the anchor must be an
-- object some LIVE piece actually binds. That is the same scope as
-- public.v_content_bound_objects, deliberately: a reader may resolve the series behind a chart
-- they can see, and nothing else.

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
  -- The anchor must be bound by a PUBLISHED block. Without this the RPC is a read primitive
  -- over the whole lake, addressable by uuid.
  if not exists (
    select 1
      from public.content_blocks b
      join public.content_items ci on ci.id = b.content_id
     where b.bound_object_id = p_object_id
       and ci.status = 'live'
  ) then
    return;
  end if;

  -- Bounded by the caller, but capped here too: a chart is a dozen points, not a data export.
  return query
    select s.x_label, s.x_date, s.y, s.unit, s.object_id, s.state
      from lake.fn_resolve_series(p_object_id, p_field, least(greatest(p_limit, 1), 60)) s;
end $$;

comment on function public.resolve_bound_series(uuid, text, int) is
  'Series behind a chart on a PUBLISHED piece. Scoped to objects bound by live content for the '
  'same reason public.v_content_bound_objects is: an RPC takes its id from the caller, so an '
  'unguarded wrapper would be a read primitive over all 790k lake objects. Resolving through a '
  'service-role client instead would run with RLS off and defeat the paywall on content_blocks.';

revoke all on function public.resolve_bound_series(uuid, text, int) from public;
grant execute on function public.resolve_bound_series(uuid, text, int) to anon, authenticated, service_role;

do $$
declare v_rows int;
begin
  -- An object nothing publishes must yield nothing, whoever asks.
  select count(*) into v_rows
    from public.resolve_bound_series(
      (select id from lake.objects where object_type = 'OHLCV.CLOSE' limit 1), null, 5);
  if v_rows <> 0 then
    raise exception 'resolve_bound_series returned a series for an unbound object';
  end if;
end $$;

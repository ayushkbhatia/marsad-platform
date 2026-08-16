-- The anon-safe window onto the lake values a published block binds.
--
-- ── WHY A VIEW AND NOT A DIRECT READ ──────────────────────────────────────────
-- The block contract is "the writer emits a BINDING, never a number" — so at render time the
-- reader has to resolve {object_id, field} against lake.objects. But lake is NOT
-- PostgREST-exposed and anon holds no USAGE on it, so a naive implementation reaches for the
-- service-role client.
--
-- That would be a paywall bypass, not a shortcut. RLS on public.content_blocks is the ONLY
-- thing withholding gated rows from an unentitled reader; a service-role resolver runs with
-- RLS off, so any code path that used it to "just fetch the values" would happily resolve the
-- premium blocks too. The gate has to stay the same gate.
--
-- This view is therefore scoped to objects bound by PUBLISHED content, exposes only what a
-- renderer needs, and is security_invoker so the caller's own RLS still applies to
-- content_blocks. An unentitled reader never reaches the resolver for a gated block, because
-- the block row itself never arrives.

create or replace view public.v_content_bound_objects
with (security_invoker = true) as
select distinct
       o.id                as object_id,
       o.object_type,
       o.state::text       as state,
       o.verification_basis,
       o.numeric_value,
       o.unit,
       o.effective_date,
       o.verified_at,
       o.payload
  from public.content_blocks b
  join public.content_items ci on ci.id = b.content_id
  join lake.objects o on o.id = b.bound_object_id
 where b.bound_object_id is not null
   and ci.status = 'live';

comment on view public.v_content_bound_objects is
  'Lake values a PUBLISHED block binds, for render-time resolution. Deliberately narrow: '
  'scoped to live content, only the fields a renderer reads, and security_invoker so the '
  'caller''s RLS on content_blocks still decides which blocks they can see. Resolving through '
  'a service-role client instead would run with RLS off and quietly resolve gated blocks too — '
  'the paywall is RLS on content_blocks, and this must not route around it.';

grant select on public.v_content_bound_objects to anon, authenticated, service_role;

do $$
begin
  -- The view must not become a way to read the lake at large.
  if (select count(*) from public.v_content_bound_objects) >
     (select count(*) from public.content_blocks where bound_object_id is not null) then
    raise exception 'v_content_bound_objects exposes more objects than are bound by content';
  end if;
end $$;

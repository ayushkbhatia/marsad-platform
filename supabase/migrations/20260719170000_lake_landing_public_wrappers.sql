-- PostgREST-reachable wrappers for the lake landing-visibility views.
-- The `lake` schema is not exposed to PostgREST (only `public` is), so the
-- Next admin route (supabase-js + service-role key) cannot read lake.v_landing_*
-- directly. These thin public wrappers are `security_invoker` — they run with
-- the CALLER's privileges, so:
--   - service_role (the admin route's server-side key) has lake USAGE + the
--     SELECT grants below, and bypasses RLS on the underlying lake tables;
--   - anon / authenticated have no USAGE on `lake`, so they cannot read these
--     even if they reach the public view name. No RLS-bypass leak is possible
--     (a plain, owner-privileged view would have leaked lake to anon — invoker
--     views deliberately do not).
-- Admin/ops surface only; never grant these to anon or authenticated.

-- service_role can bypass RLS but still needs table-level SELECT on the source views.
grant select on lake.v_landing_recent,
                lake.v_landing_storage,
                lake.v_landing_types,
                lake.v_landing_gaps
  to service_role;

create or replace view public.v_lake_landing_recent
  with (security_invoker = true) as
  select * from lake.v_landing_recent;

create or replace view public.v_lake_landing_storage
  with (security_invoker = true) as
  select * from lake.v_landing_storage;

create or replace view public.v_lake_landing_types
  with (security_invoker = true) as
  select * from lake.v_landing_types;

create or replace view public.v_lake_landing_gaps
  with (security_invoker = true) as
  select * from lake.v_landing_gaps;

-- Fail closed: strip any default grants, then hand SELECT to service_role only.
revoke all on public.v_lake_landing_recent,
               public.v_lake_landing_storage,
               public.v_lake_landing_types,
               public.v_lake_landing_gaps
  from public, anon, authenticated;

grant select on public.v_lake_landing_recent,
                public.v_lake_landing_storage,
                public.v_lake_landing_types,
                public.v_lake_landing_gaps
  to service_role;

comment on view public.v_lake_landing_recent is 'PostgREST wrapper (security_invoker) over lake.v_landing_recent. service_role only.';
comment on view public.v_lake_landing_storage is 'PostgREST wrapper (security_invoker) over lake.v_landing_storage. service_role only.';
comment on view public.v_lake_landing_types is 'PostgREST wrapper (security_invoker) over lake.v_landing_types. service_role only.';
comment on view public.v_lake_landing_gaps is 'PostgREST wrapper (security_invoker) over lake.v_landing_gaps. service_role only.';

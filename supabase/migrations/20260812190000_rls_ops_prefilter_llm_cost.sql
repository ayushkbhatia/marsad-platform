-- RLS on the two `ops` tables that were created after the schema-wide sweep.
--
-- `scripts/assert-rls.sql` enforces 02 §19: EVERY table in a private schema has RLS
-- enabled, whether or not anything can currently reach it. Both tables below were added
-- after 20260713000014_rls ran its `alter table ops.%I enable row level security` loop,
-- so they never got it:
--   ops.materiality_prefilter  (20260720110829_p3_pipeline_intake)
--   ops.llm_cost_daily         (20260719175458_ops_llm_runs_accounting)
--
-- Nothing was exposed. `ops` is not in the PostgREST schema list (supabase/config.toml
-- exposes public + graphql_public only) and neither `anon` nor `authenticated` holds
-- USAGE on it. The rule is belt-and-braces precisely so that a later accidental grant
-- cannot silently publish a table — which is the failure this closes.
--
-- The reason this is not a bare `enable row level security`:
-- `marsad_worker` does NOT have BYPASSRLS and DOES hold SELECT on materiality_prefilter.
-- Enabling RLS without a matching policy would return zero rows to the worker instead of
-- raising — a silent wrong answer in the newsroom prefilter, which is worse than an error.
-- The policy therefore mirrors the grant exactly (SELECT, `using (true)`), the same shape
-- `ops.article_templates` already uses for a read-only worker table.
--
-- llm_cost_daily gets no policy: `marsad_worker` has no grant on it, and its only other
-- grantee is service_role, which bypasses RLS.

alter table ops.materiality_prefilter enable row level security;
alter table ops.llm_cost_daily        enable row level security;

drop policy if exists worker_read on ops.materiality_prefilter;
create policy worker_read on ops.materiality_prefilter
  for select to marsad_worker using (true);

do $$
declare v_bad text;
begin
  select string_agg(c.relname, ', ')
    into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind in ('r','p') and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'ops tables still without RLS: %', v_bad;
  end if;
end $$;

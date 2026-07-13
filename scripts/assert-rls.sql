-- assert-rls.sql — CI/pre-deploy gate: RAISE EXCEPTION if any table in the
-- PostgREST-exposed schemas lacks row level security, and (belt-and-braces,
-- per 02 §19) if any table in the private app schemas lacks it either.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/assert-rls.sql
--   supabase db execute --file scripts/assert-rls.sql   (local)

do $$
declare
  v_exposed text[] := array['public', 'graphql_public'];
  v_private text[] := array['iam', 'lake', 'ops', 'billing', 'comms', 'analytics', 'ingest', 'vectors'];
  v_bad_exposed text[];
  v_bad_private text[];
begin
  -- relkind r = ordinary table, p = partitioned table; partitions included on
  -- purpose (direct partition access must be as locked-down as the parent).
  select coalesce(array_agg(n.nspname || '.' || c.relname order by 1), '{}')
    into v_bad_exposed
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname = any (v_exposed)
    and not c.relrowsecurity;

  select coalesce(array_agg(n.nspname || '.' || c.relname order by 1), '{}')
    into v_bad_private
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname = any (v_private)
    and not c.relrowsecurity;

  if array_length(v_bad_exposed, 1) is not null then
    raise exception 'RLS DISABLED on exposed-schema table(s): %', array_to_string(v_bad_exposed, ', ');
  end if;

  if array_length(v_bad_private, 1) is not null then
    raise exception 'RLS DISABLED on private-schema table(s) (belt-and-braces rule, 02 §19): %',
      array_to_string(v_bad_private, ', ');
  end if;

  raise notice 'assert-rls: OK — every table in % and % has RLS enabled',
    array_to_string(v_exposed, '/'), array_to_string(v_private, '/');
end $$;

-- ops.fit_reports needs a worker policy, not just RLS.
--
-- I enabled RLS on this table in 20260816150000 to satisfy 02 §19 (every private-schema table
-- carries RLS) and did not add a policy. marsad_worker does NOT have BYPASSRLS, so its INSERT
-- was denied, the fit handler threw, and the message went back to the queue — item 3 sat at
-- stage 'fit' with no report and read_ct stuck at 1.
--
-- This is the exact failure I wrote about in 20260812190000 when adding the worker_read policy
-- for ops.materiality_prefilter: "enabling RLS without a matching policy would return zero rows
-- to the worker instead of raising — a silent wrong answer." There the reader was a SECURITY
-- DEFINER function, so no policy was needed. Here the worker writes DIRECTLY, and I carried the
-- pattern across without checking which case it was.
--
-- worker_all rather than worker_insert: fit.ts also reads its own prior reports, and every other
-- ops table the worker owns (ad_campaigns, agent_runs, audit_log, classifier_verdicts…) uses
-- exactly this shape.

drop policy if exists worker_all on ops.fit_reports;
create policy worker_all on ops.fit_reports
  for all to marsad_worker using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'ops' and tablename = 'fit_reports' and policyname = 'worker_all'
  ) then
    raise exception 'ops.fit_reports has RLS and no worker policy — the fit stage cannot write';
  end if;

  -- Generalised: any ops table the worker was GRANTED write on must also have a policy, or the
  -- grant is a lie and the failure is a silent retry loop rather than an error anyone sees.
  if exists (
    select 1
      from information_schema.role_table_grants g
      join pg_class c on c.relname = g.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = g.table_schema
     where g.grantee = 'marsad_worker' and g.table_schema = 'ops'
       and g.privilege_type = 'INSERT' and c.relrowsecurity
       and not exists (select 1 from pg_policies p
                        where p.schemaname = g.table_schema and p.tablename = g.table_name)
  ) then
    raise exception 'an ops table grants marsad_worker INSERT, has RLS, and has no policy';
  end if;
end $$;

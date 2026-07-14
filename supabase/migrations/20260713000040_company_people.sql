-- 0040_company_people — board / management roster table (per-security people).
--
-- PROVENANCE: applied to prod live 2026-07-14 (ledger `company_people`) but its .sql was never committed;
-- recovered verbatim from supabase_migrations.schema_migrations.statements and committed here so
-- `supabase db reset` (CI from-scratch) reproduces prod. Depends only on public.securities (0003),
-- lake.objects (0004) and public.set_updated_at (0001); independent of 0030–0037, so appended.

create table public.company_people (
  id               bigint generated always as identity primary key,
  security_id      bigint not null references public.securities(id) on delete cascade,
  name             text not null,
  role             text not null check (role in ('board','management')),
  title            text,
  is_independent   boolean,
  seat_count       smallint,
  as_of            date,
  source_object_id uuid references lake.objects(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (security_id, name, role)
);
create index company_people_sec_idx on public.company_people (security_id, role);

alter table public.company_people enable row level security;
create policy world_read on public.company_people
  for select to anon, authenticated using (true);
create policy worker_all on public.company_people
  for all to marsad_worker using (true) with check (true);

grant select on public.company_people to anon, authenticated;
grant select, insert, update, delete on public.company_people to marsad_worker;

create trigger company_people_updated_at before update on public.company_people
  for each row execute function public.set_updated_at();

-- 0035_company_people — the "Missing entity" from 02-data-lake.md, required by the P2
-- stock page's Board & Management tab (07-lake-enrichment.md §1.1 I, screen 3d) and by
-- P1.7e. One row per (security, person, role): board members (with independence + seat
-- count) and management. Populated by the venue-profile / filings scrape (P1.7e-I); the
-- table is created now so the reader + scrapers share a fixed target.

create table public.company_people (
  id               bigint generated always as identity primary key,
  security_id      bigint not null references public.securities(id) on delete cascade,
  name             text not null,
  role             text not null check (role in ('board','management')),
  title            text,                     -- 'Chairman','CEO','CFO','Independent Director', …
  is_independent   boolean,                  -- board independence flag (null = unknown)
  seat_count       smallint,                 -- board seats held (interlocks), null = unknown
  as_of            date,
  source_object_id uuid references lake.objects(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (security_id, name, role)
);
create index company_people_sec_idx on public.company_people (security_id, role);

alter table public.company_people enable row level security;
-- Public reader surface (board & management is public per 02 §8); worker maintains it.
create policy world_read on public.company_people
  for select to anon, authenticated using (true);
create policy worker_all on public.company_people
  for all to marsad_worker using (true) with check (true);

-- 0014's blanket grants ran before this table existed; grant explicitly.
grant select on public.company_people to anon, authenticated;
grant select, insert, update, delete on public.company_people to marsad_worker;

create trigger company_people_updated_at before update on public.company_people
  for each row execute function public.set_updated_at();

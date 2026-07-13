-- 0004_lake — raw snapshot store, parse runs, typed objects, revisions,
-- conflicts, verified view; state-machine + immutability triggers; lake-raw
-- bucket. 02 §3–§4, §22 step 4. (lake.citations lands in 0008 with content.)

create type lake.object_state as enum ('PENDING','VERIFIED','CONFLICT','RETIRED');

create table lake.snapshots (
  id           bigint generated always as identity primary key,
  sha256       text not null unique,
  source_key   text not null,
  source_url   text not null,
  venue_code   text references public.venues(code),
  fetched_at   timestamptz not null default now(),
  fetched_by   uuid not null references iam.principals(id),
  http_status  int,
  content_type text not null,
  byte_size    int not null,
  storage_path text,
  body_inline  bytea,                 -- gzip bytes iff gzipped size <= 32768 (02 Revisions)
  purged_at    timestamptz,
  constraint blob_somewhere check (storage_path is not null or body_inline is not null or purged_at is not null)
);
create index snapshots_source_time_idx on lake.snapshots (source_key, fetched_at desc);
create index snapshots_venue_time_idx  on lake.snapshots (venue_code, fetched_at desc);

-- Immutable: DELETE never; UPDATE only from the retention purge path, which
-- sets a transaction-local GUC before nulling the blob pointers (02 §3).
create or replace function lake.fn_snapshots_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'lake.snapshots is immutable (metadata rows are kept forever)';
  end if;
  if coalesce(current_setting('marsad.allow_snapshot_purge', true), '') <> 'on' then
    raise exception 'lake.snapshots may only be updated by the retention purge';
  end if;
  if new.storage_path is not null or new.body_inline is not null or new.purged_at is null then
    raise exception 'snapshot purge must null blob pointers and stamp purged_at';
  end if;
  return new;
end $$;

create trigger snapshots_immutable before update or delete on lake.snapshots
  for each row execute function lake.fn_snapshots_immutable();

create table lake.parse_runs (
  id              bigint generated always as identity primary key,
  agent_id        uuid not null references iam.principals(id),
  parser_key      text not null,
  parser_version  text not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running','succeeded','failed','partial')),
  objects_created int not null default 0,
  objects_updated int not null default 0,
  error           text,
  retry_of        bigint references lake.parse_runs(id)
);
create index parse_runs_agent_idx on lake.parse_runs (agent_id, started_at desc);

create table lake.parse_run_snapshots (
  parse_run_id bigint not null references lake.parse_runs(id) on delete cascade,
  snapshot_id  bigint not null references lake.snapshots(id),
  primary key (parse_run_id, snapshot_id)
);

create table lake.objects (
  id              uuid primary key default gen_random_uuid(),
  object_type     text not null,
  natural_key     text not null,
  security_id     bigint references public.securities(id),
  venue_code      text references public.venues(code),
  payload         jsonb not null,
  numeric_value   numeric,
  unit            text,
  effective_date  date,
  state           lake.object_state not null default 'PENDING',
  confidence      numeric(4,3),
  revision        int not null default 1,
  parse_run_id    bigint not null references lake.parse_runs(id),
  source_rank     int not null default 100,
  verified_at     timestamptz,
  verified_by     uuid references iam.principals(id),
  price_sensitive boolean not null default false,
  cited_count     int not null default 0,
  -- DEFERRABLE so the documented supersede-then-insert revision flow (02 §4)
  -- works in one transaction: UPDATE old SET superseded_by = <new uuid> may
  -- run before the new revision row exists; the FK is checked at COMMIT.
  superseded_by   uuid references lake.objects(id) deferrable initially deferred,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint one_live_per_key unique (natural_key, revision)
);
create index objects_type_state_idx on lake.objects (object_type, state);
create index objects_security_idx   on lake.objects (security_id, object_type, effective_date desc);
-- Exactly one live (non-superseded) row per natural key (02 §4 post-review fix #4).
create unique index objects_natural_key_live_uni on lake.objects (natural_key) where superseded_by is null;
create index objects_pending_idx on lake.objects (created_at) where state = 'PENDING';
create index objects_payload_gin on lake.objects using gin (payload jsonb_path_ops);
create trigger objects_updated_at before update on lake.objects
  for each row execute function public.set_updated_at();

-- State machine (mirrors design §4): PENDING→VERIFIED, PENDING→CONFLICT,
-- CONFLICT→VERIFIED, VERIFIED→RETIRED. The 33b human-confirm gate for
-- price-sensitive objects is a database constraint, not a convention.
create or replace function lake.fn_object_state_guard() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state then
    if not ((old.state = 'PENDING'  and new.state in ('VERIFIED','CONFLICT')) or
            (old.state = 'CONFLICT' and new.state = 'VERIFIED') or
            (old.state = 'VERIFIED' and new.state = 'RETIRED')) then
      raise exception 'illegal lake object transition % -> %', old.state, new.state;
    end if;
    if new.state = 'VERIFIED' then
      if new.verified_by is null then
        raise exception 'VERIFIED requires verified_by';
      end if;
      if new.price_sensitive and not exists (
        select 1 from iam.principals p where p.id = new.verified_by and p.kind = 'human'
      ) then
        raise exception 'price-sensitive objects require a HUMAN verifier (33b)';
      end if;
      new.verified_at := coalesce(new.verified_at, now());
    end if;
  end if;

  -- Value changes never update in place: supersede-then-insert a new revision.
  if old.state = 'VERIFIED' and new.state = old.state and new.payload is distinct from old.payload then
    raise exception 'VERIFIED payloads are immutable — insert a new revision';
  end if;

  return new;
end $$;

create trigger objects_state_guard before update on lake.objects
  for each row execute function lake.fn_object_state_guard();

create table lake.object_revisions (
  id            bigint generated always as identity primary key,
  natural_key   text not null,
  old_object_id uuid not null references lake.objects(id),
  new_object_id uuid not null references lake.objects(id),
  old_value     jsonb not null,
  new_value     jsonb not null,
  reason        text not null check (reason in ('source_update','correction','human_override','conflict_resolution')),
  actor_id      uuid not null references iam.principals(id),
  created_at    timestamptz not null default now()
);
create index object_revisions_key_idx on lake.object_revisions (natural_key, created_at desc);

create table lake.object_conflicts (
  id              bigint generated always as identity primary key,
  natural_key     text not null,
  object_id       uuid not null references lake.objects(id),
  candidates      jsonb not null,
  policy          text not null default 'primary_wins',
  status          text not null default 'open' check (status in ('open','resolved_primary','resolved_override','escalated')),
  resolved_by     uuid references iam.principals(id),
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now()
);
create index object_conflicts_open_idx on lake.object_conflicts (created_at) where status = 'open';

-- The only lake surface WRITER agents' tokens can reach (02 §4).
create view lake.verified_objects as
  select * from lake.objects where state = 'VERIFIED' and superseded_by is null;

-- Private bucket for raw scraped bytes; Desk lineage viewer uses 60s signed URLs.
select ops.ensure_bucket('lake-raw', false);

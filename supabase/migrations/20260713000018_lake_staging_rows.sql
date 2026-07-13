-- 0018_lake_staging_rows — the ingestion→lake handoff store.
--
-- lake.snapshots / parse_runs / objects / object_revisions / object_conflicts (0004) do NOT
-- include a staging table, yet CONTRACT §6.5/§7 and 01-ingestion.md §10 both require one: the
-- partial-unique lake.objects.objects_natural_key_live_uni forbids two live rows per natural_key,
-- so multi-source PENDING candidates cannot be parked as lake.objects rows — they need their own
-- table. ingestion/src/lake/{staging.ts,cross-check.ts} write to and consume lake.staging_rows;
-- ingestion/src/runtime.ts (mapRowsToStaging) emits the rows. The CREATE TABLE + indexes below are
-- the frozen DDL from ingestion/src/lake/staging-schema.ts (STAGING_ROWS_DDL) VERBATIM.
--
-- Idempotent (create table / index if not exists) so it can be applied to the live prod DB. RLS is
-- enabled with the same worker-only, deny-all-by-default posture 0014 gives every lake.* table
-- (bulk-enabled there over the tables that existed then; this one is created later, so it repeats
-- the enable + worker_all policy + grants explicitly). marsad_worker gets INSERT/SELECT/UPDATE/
-- DELETE; service_role gets full reach for Next.js server code (mirrors 0014).

-- ---------------------------------------------------------------------------
-- 1. Table + indexes — STAGING_ROWS_DDL, verbatim from staging-schema.ts.
-- ---------------------------------------------------------------------------
create table if not exists lake.staging_rows (
  id             bigint generated always as identity primary key,
  object_type    text   not null,
  natural_key    text   not null,
  venue_code     text   not null references public.venues(code),
  source_id      bigint not null references ingest.sources(id),
  source_rank    int    not null default 100,
  snapshot_id    bigint not null references ingest.raw_snapshots(id),
  external_id    text,
  content_hash   text   not null,          -- sha256 of the canonicalized payload; idempotency key
  payload        jsonb  not null,
  numeric_value  numeric,
  unit           text,
  effective_date date,
  price_sensitive boolean not null default false,
  extracted_at   timestamptz not null,
  ingested_at    timestamptz not null default now(),
  consumed_at    timestamptz             -- stamped by cross-check when this row has been folded in
);

-- Idempotent at-least-once handoff: a retried job re-emitting the same parsed
-- row (same source, same external_id, same content) inserts nothing (CONTRACT
-- §6.5). NULLS NOT DISTINCT so NULL external_id sources (quote boards) dedupe.
create unique index if not exists staging_rows_dedupe_uni
  on lake.staging_rows (source_id, external_id, content_hash) nulls not distinct;

-- Cross-check gathers unconsumed candidates per natural_key (one indexed scan).
create index if not exists staging_rows_key_open_idx
  on lake.staging_rows (natural_key) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 2. RLS: enable + worker-only policy (deny-all for anon/authenticated), the
--    same belt-and-braces posture 0014 §1–§2 gives every private lake.* table.
--    Created after 0014's bulk loop ran, so the enable + policy are explicit.
-- ---------------------------------------------------------------------------
alter table lake.staging_rows enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'lake' and tablename = 'staging_rows' and policyname = 'worker_all'
  ) then
    create policy worker_all on lake.staging_rows
      for all to marsad_worker using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Grants — marsad_worker (INSERT/SELECT/UPDATE/DELETE + identity sequence),
--    service_role full reach (mirrors 0014 §2).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on lake.staging_rows to marsad_worker;
grant usage, select on all sequences in schema lake to marsad_worker;

grant all on lake.staging_rows to service_role;
grant usage, select on all sequences in schema lake to service_role;

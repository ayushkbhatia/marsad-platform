-- 0001_extensions — schemas, extensions, shared helpers, worker role, pgmq queues.
-- Source of truth: docs/architecture/02-data-lake.md §1, §22 step 1.

-- ---------------------------------------------------------------------------
-- Extensions. Supabase convention: relocatable extensions go in `extensions`.
create extension if not exists pgcrypto  with schema extensions;
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists unaccent  with schema extensions;
create extension if not exists vector    with schema extensions;  -- pgvector, adopted per 02 Revisions / 03 §5.3
create extension if not exists pg_cron;                           -- creates schema cron
create extension if not exists pg_net;                            -- creates schema net
create extension if not exists pgmq;                              -- creates schema pgmq

-- pg_partman is confirmed on the live project (02 §1) but not guaranteed in every
-- local image; ops.ensure_partitions() (0013) is the authoritative mechanism and
-- calls partman.run_maintenance() only when present, so this is best-effort.
do $$
begin
  create schema if not exists partman;
  create extension if not exists pg_partman with schema partman;
exception when others then
  raise notice 'pg_partman unavailable (%) — ops.ensure_partitions() fallback covers it', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Postgres schemas (02 §1). Only `public`/`graphql_public` are PostgREST-exposed.
create schema if not exists iam;
create schema if not exists lake;
create schema if not exists ops;
create schema if not exists billing;
create schema if not exists comms;
create schema if not exists analytics;
create schema if not exists ingest;    -- ingestion registry/queue (01-ingestion.md §3.4)
create schema if not exists vectors;   -- pgvector attach point (02 §14)

-- ---------------------------------------------------------------------------
-- Shared helpers (02 §22 step 1).

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '%.% is append-only', tg_table_schema, tg_table_name;
end $$;

-- Tier claim read from the JWT stamped by the custom access token hook (02 §19).
create or replace function public.jwt_tier() returns text
language sql stable
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'plan_tier', 'free') $$;

-- Storage bucket registration that tolerates storage-api schema drift (the
-- `public` column is added by storage-api migrations; bare CI images lack it).
create or replace function ops.ensure_bucket(p_id text, p_public boolean) returns void
language plpgsql as $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage.buckets not present — skipping bucket %', p_id;
    return;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public') then
    execute format('insert into storage.buckets (id, name, public) values (%L, %L, %L) on conflict (id) do nothing',
                   p_id, p_id, p_public);
  else
    execute format('insert into storage.buckets (id, name) values (%L, %L) on conflict (id) do nothing',
                   p_id, p_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- marsad_worker: dedicated role for the VPS worker (01 §3.1, 06 §3).
-- LOGIN with no password here; the owner sets the password out-of-band
-- (ALTER ROLE marsad_worker PASSWORD '...') — secrets never live in migrations.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'marsad_worker') then
    create role marsad_worker login noinherit;
  end if;
end $$;
-- Let the admin role impersonate the worker (SET ROLE) for smoke tests/ops.
grant marsad_worker to postgres;

-- ---------------------------------------------------------------------------
-- pgmq queues (06 §5). pg_cron only enqueues; the VPS worker consumes.
select pgmq.create('q_ingest');
select pgmq.create('q_pipeline');
select pgmq.create('q_dispatch');
select pgmq.create('q_email');
select pgmq.create('q_maintenance');

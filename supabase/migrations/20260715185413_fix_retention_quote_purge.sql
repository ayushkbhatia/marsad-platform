-- 20260715185413_fix_retention_quote_purge — the quote-blob purge in
-- ops.apply_retention (0013) was a no-op: it matched source_key LIKE
-- '%.quotes%' (dot-delimited) but the snapshot store writes colon-delimited
-- keys (`${venue}:${dataType}:${id}`, e.g. TDWL:quotes:1 — snapshot.ts), and
-- the 1-year fallback only matched content_type 'text/html%' while the
-- DFM/QE/BHB/MSX quote boards are JSON. Net: zero rows ever purged; every
-- quote-board blob (body_inline + lake-raw Storage objects) accrued forever
-- (~47 MB in the first two days live).
--
-- Fixes (02 §3, §12, §20):
--   1. Quote purge matches source_key '%:quotes:%' at 90 days, any content
--      type.
--   2. The generic 1-year branch covers JSON as well as HTML, so non-quote
--      boards (indices, calendar, ohlcv_backfill, …) also age out.
--      'financials' joins the keep-forever exclusions (filings, prospectuses,
--      transcripts): raw statement payloads must stay re-parseable.
--   3. The purge only nulled storage_path — it never deleted the lake-raw
--      Storage object, orphaning it unrecoverably (the path was the only
--      reference). Purged paths now land in ops.storage_purge_queue; a worker
--      consumes the queue via the Storage API (Postgres cannot delete the
--      backing files itself). No orphans exist yet: the purge never matched a
--      row before this fix.

-- ---------------------------------------------------------------------------
-- 1. Queue of freed lake-raw objects awaiting Storage-API deletion.
--    Paths are content-addressed (sha256 in the key) so text PK dedupes.

create table if not exists ops.storage_purge_queue (
  storage_path text primary key,
  bucket       text not null default 'lake-raw',
  enqueued_at  timestamptz not null default now(),
  deleted_at   timestamptz            -- stamped by the worker after Storage-API delete
);

-- Created after 0014's bulk RLS/policy loop ran, so enable + policy + grants
-- are explicit here (same pattern as 0018 lake.staging_rows).
alter table ops.storage_purge_queue enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'ops' and tablename = 'storage_purge_queue' and policyname = 'worker_all'
  ) then
    create policy worker_all on ops.storage_purge_queue
      for all to marsad_worker using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on ops.storage_purge_queue to marsad_worker;
grant all on ops.storage_purge_queue to service_role;

-- ---------------------------------------------------------------------------
-- 2. ops.apply_retention with the corrected snapshot-blob purge. Everything
--    above the purge block is unchanged from 0013.

create or replace function ops.apply_retention() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_month date;
begin
  -- quotes_intraday: 3 months, whole-partition drops only
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname ~ '^quotes_intraday_y\d{4}m\d{2}$'
  loop
    v_month := to_date(regexp_replace(r.relname, '^quotes_intraday_y(\d{4})m(\d{2})$', '\1\2'), 'YYYYMM');
    if v_month < date_trunc('month', now())::date - interval '3 months' then
      execute format('drop table public.%I', r.relname);
    end if;
  end loop;

  -- analytics.events: 13 months
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'analytics' and c.relname ~ '^events_y\d{4}m\d{2}$'
  loop
    v_month := to_date(regexp_replace(r.relname, '^events_y(\d{4})m(\d{2})$', '\1\2'), 'YYYYMM');
    if v_month < date_trunc('month', now())::date - interval '13 months' then
      execute format('drop table analytics.%I', r.relname);
    end if;
  end loop;

  -- audit_log: 7 years; DETACH only (archive-to-Storage is a worker task)
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_inherits i on i.inhrelid = c.oid
           where n.nspname = 'ops' and c.relname ~ '^audit_log_y\d{4}$'
  loop
    if (regexp_replace(r.relname, '^audit_log_y', ''))::int < extract(year from now())::int - 7 then
      execute format('alter table ops.audit_log detach partition ops.%I', r.relname);
    end if;
  end loop;

  -- small-table indexed deletes (02 §20)
  delete from public.index_levels where as_of < now() - interval '90 days';
  delete from public.screen_runs  where run_at < now() - interval '90 days';
  delete from comms.notifications where created_at < now() - interval '12 months';
  delete from ingest.fetch_log    where fetched_at < now() - interval '30 days';

  -- agent_runs: roll up into daily stats, then trim past 90 days
  insert into ops.agent_daily_stats (agent_id, day, runs, failures, objects_created)
  select ar.agent_id, ar.started_at::date, count(*),
         count(*) filter (where ar.status = 'failed'),
         coalesce(sum((ar.stats ->> 'objects_created')::int), 0)
  from ops.agent_runs ar
  where ar.started_at < now() - interval '90 days'
  group by ar.agent_id, ar.started_at::date
  on conflict (agent_id, day) do update
    set runs = ops.agent_daily_stats.runs + excluded.runs,
        failures = ops.agent_daily_stats.failures + excluded.failures,
        objects_created = ops.agent_daily_stats.objects_created + excluded.objects_created;
  delete from ops.agent_runs where started_at < now() - interval '90 days';

  -- snapshot blob purge: quote scrapes 90 days regardless of content type
  -- (source_key is `${venue}:${dataType}:${id}`; boards are JSON on
  -- DFM/QE/BHB/MSX, HTML elsewhere); generic HTML/JSON 1 year with
  -- filings/prospectuses/transcripts/financials kept forever. Metadata rows
  -- kept forever so lineage never dangles (02 §3). GUC unlocks the
  -- immutability trigger for exactly this transaction. Freed Storage paths go
  -- to ops.storage_purge_queue — the DB cannot delete lake-raw objects, a
  -- worker consumes the queue via the Storage API.
  perform set_config('marsad.allow_snapshot_purge', 'on', true);
  with purged as (
    update lake.snapshots
       set storage_path = null, body_inline = null, purged_at = now()
     where purged_at is null
       and ((source_key like '%:quotes:%' and fetched_at < now() - interval '90 days')
         or ((content_type like 'text/html%' or content_type like 'application/json%')
             and source_key not like '%filing%'
             and source_key not like '%prospectus%'
             and source_key not like '%transcript%'
             and source_key not like '%financials%'
             and fetched_at < now() - interval '1 year'))
     returning storage_path
  )
  insert into ops.storage_purge_queue (storage_path)
  select storage_path from purged where storage_path is not null
  on conflict (storage_path) do nothing;
end $$;

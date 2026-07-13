/**
 * Staging table DDL — the ingestion→lake handoff store (CONTRACT §6.5, §7;
 * 01-ingestion.md §10 "lake.staging_*").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DEPENDENCY (documented, not applied here): the applied P0 migrations (0004
 * lake.sql) create lake.snapshots / parse_runs / objects / object_revisions /
 * object_conflicts but do NOT create a staging table, even though 01 §10 and
 * CONTRACT §7 both require one ("gather candidate staging rows for a
 * natural_key"). The live `lake.objects.objects_natural_key_live_uni` partial
 * unique index forbids two live rows per natural_key, so multi-source PENDING
 * candidates CANNOT be parked as lake.objects rows — they need their own table.
 *
 * This module writes to and reads from `lake.staging_rows` below. Its CREATE
 * TABLE must be added by the builder who owns supabase/migrations/ (I am scoped
 * to ingestion/src/lake/** and must not add a migration). The DDL is frozen here
 * so that migration is mechanical. Grants: marsad_worker needs
 * INSERT/SELECT/UPDATE/DELETE on lake.staging_rows (it already holds lake.*).
 * ────────────────────────────────────────────────────────────────────────────
 */
export const STAGING_ROWS_DDL = /* sql */ `
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
`;

-- 20260716090000_filing_detail_chain — schema foundation for the filing_detail chain
-- (DEF-VENUE-FILINGS, 01-ingestion.md §"Filing detail + PDFs").
--
-- THE GAP THIS OPENS THE DOOR FOR: the "new quarterly PDF appears on a venue → PDF lands in
-- our bucket → extraction queue" trigger was verified DEAD (BUILD-STATUS §7). Three independent
-- gaps had to be fixed as one design; this migration is the DB half:
--   (a) ingest.seen_items is the list-diff + per-announcement detail-target ledger (enqueue.ts),
--       but the 0005 DDL carries only (source_id, external_id, detail_state) — it has NOWHERE to
--       record WHAT to fetch (the detail/pdf URL, title, filed_at captured at diff time). Without
--       that, the drain handler has no target. Add the columns.
--   (b) public.filings has pdf_storage_key (the 'filings' bucket key) but NO content hash, so the
--       extraction seam (keyed by content sha256, owner requirement) has no key to dedup on. Add
--       pdf_sha256.
--   (c) there is no extraction queue at all. The extraction SERVICE is a later phase (DEF-FILING-
--       FACTS / DEF-STMT-LLM-PDF), but the detail chain must leave a clean, idempotent seam keyed by
--       content sha256 so a downstream worker can pick up "this stored PDF needs full_text/facts".
--       Create ops.filing_extract_queue (mirrors the ops.storage_purge_queue pattern, 20260715185413).
--
-- Snapshot-first is preserved end-to-end: the PDF bytes are the immutable artifact; the queue row is
-- pure metadata keyed by the artifact's sha256, so a re-fetch of the same content is a no-op.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (a) seen_items detail-target columns. The filings_list poll records genuinely-new announcements
--     here (ON CONFLICT DO NOTHING; enqueue.ts), and now also the fields the filing_detail drain
--     needs to fetch the artifact without re-parsing the list. detail_state stays the state machine
--     ('pending' → 'fetched' | 'failed' | 'nopdf'); the new columns are the payload.
alter table ingest.seen_items add column if not exists detail_url text;
alter table ingest.seen_items add column if not exists pdf_url    text;
alter table ingest.seen_items add column if not exists title      text;
alter table ingest.seen_items add column if not exists filed_at   timestamptz;

-- Drain query support: pending targets for a venue, oldest-first. Partial index keeps it tiny
-- (only pending rows) — the dominant state is 'fetched'.
create index if not exists seen_items_pending_idx
  on ingest.seen_items (source_id, first_seen)
  where detail_state = 'pending';

-- ---------------------------------------------------------------------------
-- (b) content hash on the served filing row. pdf_storage_key already holds the 'filings' bucket key
--     (296 rows live); pdf_sha256 is the sha256 of the stored PDF bytes — the extraction seam key and
--     the idempotency anchor for a re-fetch (same content ⇒ same key ⇒ same sha ⇒ no new work).
alter table public.filings add column if not exists pdf_sha256 text;
create index if not exists filings_pdf_sha256_idx on public.filings (pdf_sha256)
  where pdf_sha256 is not null;

-- ---------------------------------------------------------------------------
-- (c) the extraction placeholder queue. One row per distinct stored PDF (content_sha256 UNIQUE ⇒
--     idempotent enqueue; a re-announced identical PDF enqueues once). The extraction SERVICE is a
--     later phase — this is only the clean seam it will drain. state machine:
--       pending → processing → done | failed. picked_at/done_at/attempts/error are the worker's.
create table if not exists ops.filing_extract_queue (
  id              bigint generated always as identity primary key,
  filing_id       bigint references public.filings(id) on delete cascade,
  venue_code      text not null references public.venues(code),
  source_ref      text not null,
  content_sha256  text not null unique,
  pdf_storage_key text not null,
  content_type    text,
  state           text not null default 'pending'
                  check (state in ('pending','processing','done','failed')),
  enqueued_at     timestamptz not null default now(),
  picked_at       timestamptz,
  done_at         timestamptz,
  attempts        int not null default 0,
  error           text
);
create index if not exists filing_extract_queue_pending_idx
  on ops.filing_extract_queue (enqueued_at)
  where state = 'pending';

-- RLS + grants: mirror ops.storage_purge_queue (20260715185413). Created after 0014's bulk RLS
-- loop, so enable + policy + grants are explicit. Worker reads/writes; service_role all; no anon.
alter table ops.filing_extract_queue enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'ops' and tablename = 'filing_extract_queue' and policyname = 'worker_all'
  ) then
    create policy worker_all on ops.filing_extract_queue
      for all to marsad_worker using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on ops.filing_extract_queue to marsad_worker;
grant all on ops.filing_extract_queue to service_role;

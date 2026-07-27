-- PE.0 — close the filing-extraction enqueue gap (DEF-FILING-EXTRACT-ENQUEUE-GAP).
--
-- THE GAP. ops.filing_extract_queue was not backed up — it was EMPTY: 374 rows, all 'done'.
-- Its only producer is worker/src/handlers/filings-detail-poll.ts:244 (the filing_detail chain),
-- which exists for MSX/ADX/DFM only. The five researchers that archived ~14,000 PDFs
-- (tadawul-researcher, qe-financials, bhb-financials, msx-financials, dfm-backfill, adx-gapfill)
-- write public.filings + the `filings` bucket DIRECTLY and never enqueue. Measured 2026-07-27:
--
--     venue   stored PDFs   ever queued
--     TDWL          7,133             0
--     QE            2,118             0
--     BHB             366             0
--     MSX           2,396           195
--     ADX           1,588           120
--     DFM             808            59
--
-- 14,409 filings carry a pdf_storage_key; 374 (2.6%) have any full_text. 25 GB of already-paid-for
-- storage was write-only, and the newsroom is blind to all of it.
--
-- WHY content_sha256 CANNOT STAY THE IDENTITY. The queue was designed around the detail chain,
-- which HASHES the bytes at download time, so `content_sha256 not null unique` held. The
-- researchers do not hash. Measured:
--
--     venue   pdf_sha256 set   sha embedded in storage key
--     TDWL                 0                             0    tdwl/1010/1_0_2022-05-11_09-22-21_En.pdf
--     QE                   0                             0    qe/AHCS/report/2020-09-30.pdf
--     BHB                  0                           366    (sha in key, not in column)
--
-- 9,251 rows (TDWL + QE) have NO content hash anywhere — not in the column, not in the key. There
-- is nothing to put in a NOT NULL content_sha256 short of downloading and hashing 9,251 PDFs,
-- which the extractor would immediately do again.
--
-- THE FIX. pdf_storage_key is the true identity of "a PDF in the bucket" — it is what the extractor
-- actually fetches, it is unique per stored object by construction, and it is populated for 100% of
-- the corpus. Make it the queue's natural key; keep content_sha256 as an optional attribute with
-- its dedup meaning intact wherever a hash does exist.
--
-- Safe on live data, verified before writing this migration:
--   * ops.filing_extract_queue: 0 duplicate pdf_storage_key, 0 null pdf_storage_key.
--   * public.filings: 44 duplicate storage keys across 123 rows, and NONE of them span two
--     securities — they are the same document announced twice for the same company. One stored PDF
--     ⇒ one extraction is therefore correct, not lossy.
--   * every already-extracted filing (374) already has a queue row, so the backfill re-charges
--     nothing.
--
-- TWO IDENTITIES, NOT ONE. A first cut of this migration deduped on pdf_storage_key alone and
-- aborted on the sha index: the same BYTES are sometimes stored under two different KEYS —
-- 9 shas map to 2 keys each (18 rows, e.g. msx/MFCI/13618/… and msx/MFCI/13617/…, one MSX company
-- report archived under two report ids), and 3 filings collide with a key already in the queue.
-- Content identity (sha) and object identity (key) are therefore BOTH real and neither subsumes
-- the other. The extractor cares about bytes, so content identity wins where a hash exists:
-- dedupe on coalesce(pdf_sha256, pdf_storage_key), and let an untargeted ON CONFLICT DO NOTHING
-- absorb whichever unique index a residual collision hits.

-- ---------------------------------------------------------------------------
-- (a) pdf_storage_key becomes the natural key; content_sha256 becomes optional.

alter table ops.filing_extract_queue
  alter column content_sha256 drop not null;

-- The original UNIQUE was a constraint (created inline), so drop the constraint, not an index.
alter table ops.filing_extract_queue
  drop constraint if exists filing_extract_queue_content_sha256_key;

-- Keep sha dedup where a sha exists — partial, so the 9,251 hash-less rows coexist.
create unique index if not exists filing_extract_queue_sha_uni
  on ops.filing_extract_queue (content_sha256)
  where content_sha256 is not null;

-- The real identity. This is the conflict target every producer now uses.
create unique index if not exists filing_extract_queue_key_uni
  on ops.filing_extract_queue (pdf_storage_key);

comment on column ops.filing_extract_queue.content_sha256 is
  'sha256 of the PDF bytes when the producer computed one (the filing_detail chain does; the '
  'researchers do not). Nullable since PE.0 — pdf_storage_key is the natural key.';

-- ---------------------------------------------------------------------------
-- (b) ongoing enqueue: a trigger on public.filings, not edits to six researcher scripts.
--
-- Deliberate: the researchers run from their OWN checkout on the VPS, so a code change there is
-- inert until someone pushes AND pulls — exactly the trap DEF-LAKE-OBJECTS-RACE is still open on
-- ("fixed in the repo" != "integrated"). A trigger is one place, applies to every existing and
-- future producer, and cannot be skipped by a stale deploy.

create or replace function ops.fn_enqueue_filing_extract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.pdf_storage_key is null then
    return null;
  end if;

  -- Never re-charge a filing whose text we already have (re-extraction is a deliberate,
  -- separate operation, not a side effect of touching the row).
  if length(coalesce(new.full_text, '')) > 200 then
    return null;
  end if;

  -- Untargeted: absorbs a hit on EITHER unique index (same key, or same bytes under a new key).
  insert into ops.filing_extract_queue
    (filing_id, venue_code, source_ref, content_sha256, pdf_storage_key, content_type)
  values
    (new.id, new.venue_code, new.source_ref, new.pdf_sha256, new.pdf_storage_key, 'application/pdf')
  on conflict do nothing;

  return null;
end;
$$;

comment on function ops.fn_enqueue_filing_extract() is
  'PE.0 — every stored filing PDF reaches ops.filing_extract_queue exactly once, whichever producer '
  'wrote it. AFTER trigger, returns null, ON CONFLICT DO NOTHING: it can never fail its caller.';

drop trigger if exists filings_enqueue_extract_ins on public.filings;
create trigger filings_enqueue_extract_ins
  after insert on public.filings
  for each row
  when (new.pdf_storage_key is not null)
  execute function ops.fn_enqueue_filing_extract();

-- Catches the researchers' pattern: insert the row first, attach the storage key on a later pass.
drop trigger if exists filings_enqueue_extract_upd on public.filings;
create trigger filings_enqueue_extract_upd
  after update of pdf_storage_key on public.filings
  for each row
  when (new.pdf_storage_key is not null
        and new.pdf_storage_key is distinct from old.pdf_storage_key)
  execute function ops.fn_enqueue_filing_extract();

-- ---------------------------------------------------------------------------
-- (c) one-time backfill of the standing corpus.
--
-- Ordered by VALUE, not by id (09-signal-to-article.md §2.5). The extractor claims
-- `order by enqueued_at` (filing-extractor.mjs:152), so priority is expressed by back-dating
-- enqueued_at: lower priority number => older stamp => drained first.
--
--   0  TDWL + QE RESULTS  — 9,251 PDFs, zero text today, and the venues with the deepest history
--   1  market-moving       — already flagged is_market_moving
--   2  any other RESULTS   — the fundamentals corpus
--   3  everything else
--
-- distinct on (coalesce(sha, key)) collapses BOTH duplicate classes to one extraction each — the 44
-- repeated storage keys and the 9 shas stored under two keys — keeping the lowest filing id so the
-- choice is deterministic across re-runs.

insert into ops.filing_extract_queue
  (filing_id, venue_code, source_ref, content_sha256, pdf_storage_key, content_type, enqueued_at)
select distinct on (coalesce(f.pdf_sha256, f.pdf_storage_key))
       f.id,
       f.venue_code,
       f.source_ref,
       f.pdf_sha256,
       f.pdf_storage_key,
       'application/pdf',
       now() - make_interval(secs =>
         (case
            when f.venue_code in ('TDWL','QE') and f.filing_type = 'RESULTS' then 3
            when f.is_market_moving                                          then 2
            when f.filing_type = 'RESULTS'                                   then 1
            else                                                                  0
          end) * 86400)
  from public.filings f
 where f.pdf_storage_key is not null
   and length(coalesce(f.full_text, '')) <= 200
   and not exists (
         select 1 from ops.filing_extract_queue q
          where q.pdf_storage_key = f.pdf_storage_key)
   and not exists (
         select 1 from ops.filing_extract_queue q
          where f.pdf_sha256 is not null and q.content_sha256 = f.pdf_sha256)
 order by coalesce(f.pdf_sha256, f.pdf_storage_key), f.id
on conflict do nothing;

-- PE.1 — the extract queue learns what it is holding, and stops handing XBRL HTML to a PDF parser.
--
-- WHAT PE.0 GOT WRONG. 20260727113000 enqueued every row of public.filings carrying a
-- `pdf_storage_key`. The column name is a lie for TDWL: `tadawul-researcher.mjs` archives the
-- exchange's **XBRL HTML** renders under it too. Measured on the resulting queue:
--
--     venue    .pdf    .html
--     TDWL    3,715    3,418      <- 24.5% of the whole pending queue
--     others  6,814        0
--
-- `filing-extractor.mjs` verifies a `%PDF-` magic header (`fetchStoredPdf`, :136) and calls
-- `fail(..., permanent=true)` when it is absent — so all 3,418 would have been claimed, downloaded,
-- rejected and marked permanently 'failed'. Wasted egress, and a queue whose failure count means
-- nothing.
--
-- They are not junk: XBRL HTML is *better* input than a PDF (structured, machine-readable) and it
-- already has a dedicated consumer — `scripts/researchers/tadawul-xbrl-replay.mjs` re-reads exactly
-- these objects from the bucket to refresh statement objects. They belong to that lane, not this one.
--
-- WHY A DB-SIDE GUARD RATHER THAN A FILTER IN THE EXTRACTOR. Same reasoning as PE.0's trigger: the
-- researchers run from the VPS's own checkout, so a claim-query change is inert until someone
-- pushes AND pulls. Moving the HTML rows out of `state='pending'` protects the extractor
-- immediately and regardless of deploy lag — it claims `state='pending'` and simply never sees them.

-- ---------------------------------------------------------------------------
-- (a) record what each row actually points at.

alter table ops.filing_extract_queue
  add column if not exists content_kind text;

comment on column ops.filing_extract_queue.content_kind is
  'What pdf_storage_key actually points at: pdf | html | other. Derived from the key suffix — '
  'public.filings.pdf_storage_key is NOT always a PDF (TDWL archives XBRL HTML under it).';

update ops.filing_extract_queue
   set content_kind = case
         when pdf_storage_key ilike '%.pdf'  then 'pdf'
         when pdf_storage_key ilike '%.html' then 'html'
         when pdf_storage_key ilike '%.htm'  then 'html'
         else 'other'
       end
 where content_kind is null;

-- ---------------------------------------------------------------------------
-- (b) a terminal state that is honest about WHY, distinct from 'failed'.
--     'failed' means "we tried and it broke" and feeds the 3-strike logic; these were never tried.

alter table ops.filing_extract_queue
  drop constraint if exists filing_extract_queue_state_check;

alter table ops.filing_extract_queue
  add constraint filing_extract_queue_state_check
  check (state in ('pending','processing','done','failed','skipped'));

update ops.filing_extract_queue
   set state   = 'skipped',
       done_at = now(),
       error   = 'not a pdf (' || content_kind || ') — XBRL HTML belongs to the tadawul-xbrl-replay lane, not the PDF extractor'
 where state = 'pending'
   and content_kind <> 'pdf';

-- ---------------------------------------------------------------------------
-- (c) keep it true for everything enqueued from now on.

create or replace function ops.fn_enqueue_filing_extract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  if new.pdf_storage_key is null then
    return null;
  end if;

  if length(coalesce(new.full_text, '')) > 200 then
    return null;
  end if;

  v_kind := case
              when new.pdf_storage_key ilike '%.pdf'  then 'pdf'
              when new.pdf_storage_key ilike '%.html' then 'html'
              when new.pdf_storage_key ilike '%.htm'  then 'html'
              else 'other'
            end;

  -- Untargeted: absorbs a hit on EITHER unique index (same key, or same bytes under a new key).
  insert into ops.filing_extract_queue
    (filing_id, venue_code, source_ref, content_sha256, pdf_storage_key, content_type,
     content_kind, state, done_at, error)
  values
    (new.id, new.venue_code, new.source_ref, new.pdf_sha256, new.pdf_storage_key, 'application/pdf',
     v_kind,
     case when v_kind = 'pdf' then 'pending' else 'skipped' end,
     case when v_kind = 'pdf' then null else now() end,
     case when v_kind = 'pdf' then null
          else 'not a pdf (' || v_kind || ') — belongs to a non-PDF extraction lane' end)
  on conflict do nothing;

  return null;
end;
$$;

comment on function ops.fn_enqueue_filing_extract() is
  'PE.0/PE.1 — every stored filing artifact reaches ops.filing_extract_queue exactly once, whichever '
  'producer wrote it, tagged with what it actually is. Non-PDF artifacts land terminal ''skipped'' so '
  'the PDF extractor never claims them. AFTER trigger, returns null, ON CONFLICT DO NOTHING: it can '
  'never fail its caller.';

-- Partial index the extractor's claim actually uses (state='pending' is now pdf-only by construction).
create index if not exists filing_extract_queue_pending_pdf_idx
  on ops.filing_extract_queue (enqueued_at)
  where state = 'pending' and content_kind = 'pdf';

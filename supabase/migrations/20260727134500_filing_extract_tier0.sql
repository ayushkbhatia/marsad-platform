-- PE.1 — the extract queue becomes a two-stage pipeline: Tier 0 (deterministic) then Tier 2 (semantic).
--
-- WHY THE STATE MODEL HAS TO CHANGE. `filing-extractor.mjs` claims `state='pending'` and does
-- everything in one pass: pdftotext → OCR fallback → one `claude -p` call. Tier 0 (`tier0-triage.mjs`)
-- claims the same rows and does only the deterministic half. Two drainers on one predicate race each
-- other and double-charge the LLM seat.
--
-- Splitting the states makes the handoff explicit, and each row records which stage it is waiting on:
--
--     pending     awaiting Tier 0 (deterministic parse)
--     text_ready  Tier 0 recovered a text layer; awaiting Tier 2 (semantic: ai_summary + facts)
--     needs_ocr   Tier 0 found no usable text layer; awaiting Tier 1 (the model tier)
--     done        fully processed — text AND semantic
--     failed      genuinely broken (download failed, not a PDF, corrupt)   [3-strike logic]
--     skipped     not this lane at all (XBRL HTML — see 20260727124500)
--
-- SAFE ROLLOUT PROPERTY, deliberately chosen. The deployed `filing-extractor.mjs` on the VPS still
-- claims `state='pending'`. Once Tier 0 runs, born-digital rows move to `text_ready`, which the OLD
-- extractor does not match — so it finds nothing and idles instead of racing. The expensive
-- `claude -p` lane therefore PAUSES ITSELF until the updated extractor is deployed, rather than
-- doing duplicate work at cost. The researchers run from the VPS's own checkout and lag the repo
-- (the standing `DEF-LAKE-OBJECTS-RACE` lesson), so "degrades to idle" is the only safe default.
--
-- Measured 2026-07-27 (PE.1 probe, 26 docs / 1,120 pages): 86% of pages already carry a text layer,
-- so most of the 10,528 pending rows should reach `text_ready` from Tier 0 alone at zero LLM cost.

-- ---------------------------------------------------------------------------
-- (a) the two new waypoints.

alter table ops.filing_extract_queue
  drop constraint if exists filing_extract_queue_state_check;

alter table ops.filing_extract_queue
  add constraint filing_extract_queue_state_check
  check (state in ('pending','processing','text_ready','needs_ocr','done','failed','skipped'));

-- ---------------------------------------------------------------------------
-- (b) Tier-0 triage telemetry. This is the corpus measurement PE.1 exists to produce — how many
--     pages there actually are, and what share carry text. Kept on the queue row (the extraction
--     ledger) rather than on public.filings, which is the reader-facing projection.

alter table ops.filing_extract_queue
  add column if not exists tier0_at        timestamptz,
  add column if not exists tier0_ms        int,
  add column if not exists pages           int,
  add column if not exists digital_pages   int,
  add column if not exists text_chars      int;

comment on column ops.filing_extract_queue.tier0_at is
  'When the deterministic Tier-0 parse ran. NULL = never triaged (the Tier-0 claim predicate).';
comment on column ops.filing_extract_queue.digital_pages is
  'Pages carrying >= 200 non-whitespace chars of native text. digital_pages = 0 means image-only '
  '=> needs_ocr. 0 < digital_pages < pages is a mixed document (cover/signature pages are normal).';

-- Tier 0's claim: never-triaged PDFs, oldest-priority first (enqueued_at carries the value ordering
-- set by 20260727113000).
create index if not exists filing_extract_queue_tier0_todo_idx
  on ops.filing_extract_queue (enqueued_at)
  where state = 'pending' and content_kind = 'pdf' and tier0_at is null;

-- Tier 2's claim: text recovered, semantic pass outstanding.
create index if not exists filing_extract_queue_text_ready_idx
  on ops.filing_extract_queue (enqueued_at)
  where state = 'text_ready';

-- Tier 1's backlog: no text layer, model tier required.
create index if not exists filing_extract_queue_needs_ocr_idx
  on ops.filing_extract_queue (enqueued_at)
  where state = 'needs_ocr';

-- ---------------------------------------------------------------------------
-- (c) the corpus-shape view PE.1 is accountable for. Cheap, and it is what tells us whether the
--     86%-carry-text sample figure holds across all 10,528 documents.

create or replace view ops.v_tier0_coverage as
select
  venue_code,
  count(*)                                                     as docs,
  count(*) filter (where tier0_at is not null)                 as triaged,
  sum(pages)                                                   as pages,
  sum(digital_pages)                                           as digital_pages,
  round(100.0 * nullif(sum(digital_pages), 0) / nullif(sum(pages), 0), 1) as pct_pages_with_text,
  count(*) filter (where state = 'text_ready')                 as text_ready,
  count(*) filter (where state = 'needs_ocr')                  as needs_ocr,
  count(*) filter (where state = 'done')                       as done,
  count(*) filter (where state = 'failed')                     as failed,
  count(*) filter (where state = 'pending')                    as pending,
  round(avg(pages) filter (where pages is not null), 1)        as avg_pages_per_doc
from ops.filing_extract_queue
where content_kind = 'pdf'
group by venue_code;

comment on view ops.v_tier0_coverage is
  'PE.1 corpus shape: per-venue page counts and the share of pages carrying a native text layer. '
  'The 26-doc probe measured 86% overall and 43.1 pages/doc — this is the whole-corpus check.';

grant select on ops.v_tier0_coverage to service_role;

-- 20260721120000_dividend_declared_feed — arm the DIVIDEND.DECLARED dated-declaration feed
-- (DEF-DIVIDEND-DECLARED, BUILD-STATUS §7; 03-agent-newsroom §6 classify/materiality + §7 templates).
--
-- The producer is scripts/researchers/dividend-declared.mjs + the pure, unit-tested normalization
-- core ingestion/src/lake/dividend-declared.ts. It turns DIVIDEND-typed filings whose facts the
-- filing-extractor already parsed (public.filings.extracted_facts.ai.dividend) into
-- `DIVIDEND.EXDATE` lake.objects (PENDING, price_sensitive) + public.dividends rows (pending_confirm).
-- A Desk human confirm promotes object→VERIFIED (33b, lake.fn_object_state_guard) + dividend→live
-- (fn_dividend_confirm_guard), which fires lake.fn_verified_enqueue → pipeline_classify → the
-- DIVIDEND.EXDATE prefilter verdict below → pipeline_draft/edit → autoSelectTemplate → TPL-04.
--
-- WHY THIS MIGRATION IS THIN (the two DB pieces the feed needs were already in place — verify, don't
-- re-lay):
--   • object_type registration: NONE needed. lake.objects.object_type is free `text` with NO CHECK
--     constraint (confirmed against live). `DIVIDEND.EXDATE` is a first-class value the moment the
--     producer writes it — no enum/domain to widen.
--   • the classify route: the DIVIDEND.EXDATE materiality_prefilter row ALREADY EXISTS
--     (20260720110829_p3_pipeline_intake seeded material/wire/TPL-04). This migration RE-ASSERTS it
--     idempotently (a no-op on a correctly-seeded DB) so the feed's routing is self-documenting and
--     resilient if that row is ever hand-edited.
--   • the producer writes lake.objects DIRECTLY (its own lake.parse_runs), like the live second-source
--     researcher stockanalysis-financials.mjs — NOT via lake.staging_rows — so NO ingest.sources /
--     ingest.schedules seed row is required.
--
-- ALSO: ingestion/src/runtime.ts mapDividend was aligned from the divergent 'DIVIDEND.DPS' to the
-- frozen 'DIVIDEND.EXDATE' object_type (CONTRACT §6.5, docs 01/02, seed.sql, worker pipeline.test.ts).
-- No data migration is needed for that — zero DIVIDEND.DPS objects exist live.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Re-assert the DIVIDEND.EXDATE classify route (idempotent; already seeded).
--    material → wire → TPL-04 (03 §6.1 deterministic prefilter tier, resolves at $0, no LLM).
-- ---------------------------------------------------------------------------
insert into ops.materiality_prefilter (object_type, verdict, priority, template_hint, note) values
  ('DIVIDEND.EXDATE', 'material', 'wire', 'TPL-04', 'dividend declared / ex-date → wire + dividend ex-date card (DIVIDEND.DECLARED feed)')
on conflict (object_type) do update
  set verdict       = excluded.verdict,
      priority      = excluded.priority,
      template_hint = excluded.template_hint,
      note          = excluded.note;

-- ---------------------------------------------------------------------------
-- 2. Coverage / Desk-visibility stamp — when a filing has been turned into a DIVIDEND.EXDATE
--    declaration. OPTIONAL for the producer (its primary coverage guard is the existence of a
--    DIVIDEND.EXDATE object carrying the filing id; the researcher stamps this best-effort and never
--    depends on it), but it gives the Desk a fast "which dividend filings are still un-produced" filter.
-- ---------------------------------------------------------------------------
alter table public.filings add column if not exists dividend_declared_at timestamptz;

comment on column public.filings.dividend_declared_at is
  'Set by scripts/researchers/dividend-declared.mjs when this DIVIDEND filing was turned into a '
  'DIVIDEND.EXDATE lake object + public.dividends row. NULL = not yet produced (Desk backlog filter).';

create index if not exists filings_dividend_unproduced_idx
  on public.filings (filed_at desc)
  where filing_type = 'DIVIDEND' and dividend_declared_at is null;

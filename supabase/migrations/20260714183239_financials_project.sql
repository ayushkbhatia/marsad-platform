-- 20260714183239_financials_project — RECONSTRUCTED FROM LIVE (ledger reconciliation 2026-07-16).
--
-- Provenance: this migration was applied to the live DB out-of-band on 2026-07-14 (via MCP, from
-- the off-main producer branch) and recorded in supabase_migrations.schema_migrations as
-- version 20260714183239 / name 'financials_project', but its .sql was never committed to
-- supabase/migrations/. A from-scratch replay of the repo therefore did NOT create
-- public.filings.pdf_storage_key (added here) — a silent repo⇄live schema drift. This file is the
-- verbatim reconstruction of statements[1] as stored on live, so from-scratch now creates the same
-- objects the live DB has. Every statement is idempotent (add column if not exists / create or
-- replace / drop trigger if exists), so re-running against the live DB (which already has this
-- applied) is a safe no-op.
--
-- LINEAGE (do not "fix" the clobber body below): the fn here is the ORIGINAL natural-key-upsert
-- (clobber) projection. On a from-scratch replay it is later superseded IN PLACE by
-- 20260716120000 (restatement versioning); 20260716095100 sits between them creating a parallel
-- camelCase projection that 20260716120000 then drops — so the from-scratch chain
-- 183239 → 095100 → 120000 converges to the exact live end-state (single snake_case
-- lake.fn_financials_project with versioning). Live itself ran 183239 → 120000 (095100 was
-- stamped, never executed — see supabase/reconcile/). See docs/BUILD-STATUS.md §7 DEF-STMT-INGEST.

set search_path = '';

alter table public.filings add column if not exists pdf_storage_key text;
comment on column public.filings.pdf_storage_key is
  'Key of our stored copy of the filing PDF in the public `filings` Storage bucket (CDN-served at /storage/v1/object/public/filings/{key}). pdf_en_path holds the remote source URL.';

create or replace function lake.fn_financials_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_stmt   text := new.payload ->> 'statement_type';
  v_kind   text := new.payload ->> 'period_kind';
  v_fp     text := new.payload ->> 'fiscal_period';
  v_pe     date := nullif(new.payload ->> 'period_end','')::date;
  v_ccy    char(3) := upper(left(coalesce(new.payload ->> 'currency','SAR'), 3));
  v_basis  text := coalesce(new.payload ->> 'basis', 'consolidated');
  v_items  jsonb := new.payload -> 'line_items';
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.security_id is null then return null; end if;
  if v_stmt not in ('income','balance','cashflow') then return null; end if;
  if v_kind not in ('quarter','annual','ttm') then return null; end if;
  if v_fp is null or v_pe is null then return null; end if;
  if v_basis not in ('consolidated','standalone') then v_basis := 'consolidated'; end if;
  if v_items is null or jsonb_typeof(v_items) <> 'object' then return null; end if;

  insert into public.financial_statements
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
     currency, is_estimate, line_items, source_object_id)
  values
    (new.security_id, v_stmt, v_basis, v_kind, v_fp, v_pe,
     v_ccy, false, v_items, new.id)
  on conflict (security_id, statement_type, basis, fiscal_period, is_estimate) do update set
    period_kind      = excluded.period_kind,
    period_end       = excluded.period_end,
    currency         = excluded.currency,
    line_items       = excluded.line_items,
    source_object_id = excluded.source_object_id,
    updated_at       = now();

  return null;
end $$;

drop trigger if exists objects_financials_project_ins on lake.objects;
create trigger objects_financials_project_ins after insert on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();

drop trigger if exists objects_financials_project_upd on lake.objects;
create trigger objects_financials_project_upd after update on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();

-- 0042_financials_project — project FILING.FINANCIALS lake.objects → public.financial_statements,
-- and add public.filings.pdf_storage_key (our stored copy of the statement PDF in the public
-- `filings` bucket, distinct from pdf_en_path which the 0037 list-projection fills with the remote
-- venue/Argaam URL). Part of the PDF-first financials pipeline
-- (docs/plans/p17-financials-pdf-architecture.md §3.2/§3.4).
--
-- A FILING.FINANCIALS object carries ONE validated statement (one statement_type × fiscal_period),
-- payload = the NormalizedPeriod: { statement_type, basis, period_kind, fiscal_period, period_end,
-- currency, line_items(§3.1 primitives, actual units) }. security_id is resolved at staging.
-- Only data that PASSED the extraction validation gate (statement-extraction.ts) is ever staged as
-- FILING.FINANCIALS, so a projected row is trustworthy by construction.
--
-- Single-source publish rule (D-src-1, like quotes/OHLCV/filings): project PENDING + VERIFIED.

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
  -- Required NOT-NULL columns / valid enums; skip a malformed object rather than fail the tx.
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

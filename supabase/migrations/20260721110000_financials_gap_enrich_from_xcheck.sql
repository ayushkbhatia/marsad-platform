set search_path = '';
alter table public.financial_statements add column if not exists source text;
comment on column public.financial_statements.source is
  'Provenance of a non-filing-sourced row. NULL = filing/XBRL golden (default, set by fn_financials_project). "stockanalysis-spg" = gap-enriched from the FINANCIALS.XCHECK tier where no filing existed; a real filing supersedes it on arrival. Reversible (delete where source=...).';
create or replace function lake.fn_enrich_financials_from_xcheck() returns integer
  language plpgsql security definer set search_path = ''
as $fn$
declare v_n integer;
begin
  insert into public.financial_statements
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end, currency,
     line_items, is_estimate, source, source_object_id)
  select x.security_id, x.statement_type, x.basis, x.period_kind, x.fiscal_period, x.period_end,
         x.currency, x.line_items, false, 'stockanalysis-spg', x.source_object_id
  from public.financial_statement_xcheck x
  where x.status = 'gap_golden_missing'
    and x.period_kind in ('annual', 'quarter')
    and x.statement_type in ('income', 'balance', 'cashflow')
    and not exists (
      select 1 from public.financial_statements fs
      where fs.security_id = x.security_id and fs.statement_type = x.statement_type
        and fs.basis = x.basis and fs.fiscal_period = x.fiscal_period and fs.is_estimate is not true)
  on conflict (security_id, statement_type, basis, fiscal_period, is_estimate) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

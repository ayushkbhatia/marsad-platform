-- 20260720162000_earnings_eps_relative_guard — upgrade the earnings-actuals projection's
-- EPS sanity guard from an ABSOLUTE bound (abs(eps) > 100000) to the correct RELATIVE bound
-- (abs(eps) > abs(net_income)/1e6), matching the DEF-TDWL-EPS-MAPPING fix in the extractor
-- (scaleLineItems / ratios-compute). The absolute bound under-scoped: it missed the
-- net_income/1000 scale variants (a smaller filer's mis-tagged eps can be < 100000 yet still be
-- a net-income magnitude), which then leaked into public.earnings_events.eps_actual — a PUBLIC
-- surface (world_read qual = true). The relative bound is currency-unit-invariant (eps and
-- net_income are the same currency within a statement) and spares fils-denominated EPS.
--
-- Hot-function replace: this body is the 20260720160500 body with ONLY the eps_actual CASE
-- changed. Verified against the live body before replacing (md5 of the applied function).
-- Re-runs the projection at the end so the ~4,055 existing rows are re-guarded immediately.

set search_path = '';

create or replace function lake.fn_project_earnings_from_income() returns integer
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_n integer;
begin
  with base as (
    select distinct on (fs.security_id, fs.fiscal_period)
      fs.security_id,
      fs.fiscal_period,
      coalesce(f.filed_at::date, fs.period_end)                          as report_date,
      case when f.filed_at is not null then 'confirmed' else 'estimated' end as date_state,
      -- RELATIVE per-share guard (DEF-TDWL-EPS-MAPPING): null a per-share eps that exceeds
      -- net_income/1e6 (implied shares < 1M — impossible for a listed equity), so a mis-tagged
      -- net-income magnitude never lands as eps_actual. Currency-invariant. When net_income is
      -- absent/zero the guard can't apply, so the raw eps passes (rare; downstream is unaffected).
      case
        when (fs.line_items->>'net_income') is not null
         and (fs.line_items->>'net_income')::numeric <> 0
         and abs(coalesce((fs.line_items->>'eps_diluted')::numeric,
                          (fs.line_items->>'eps_basic')::numeric))
             > abs((fs.line_items->>'net_income')::numeric) / 1e6
          then null
        else coalesce((fs.line_items->>'eps_diluted')::numeric,
                      (fs.line_items->>'eps_basic')::numeric)
      end                                                                as eps_actual,
      (fs.line_items->>'revenue')::numeric                               as revenue_actual,
      fs.source_filing_id                                               as results_filing_id,
      fs.source_object_id
    from public.financial_statements fs
    left join public.filings f on f.id = fs.source_filing_id
    where fs.statement_type = 'income'
      and fs.period_kind    = 'quarter'
      and fs.is_restated is not true
    order by fs.security_id, fs.fiscal_period,
             (fs.basis = 'consolidated') desc, fs.version desc, fs.id desc
  )
  insert into public.earnings_events
    (security_id, fiscal_period, report_date, date_state, eps_actual, revenue_actual,
     results_filing_id, source_object_id)
  select
    security_id, fiscal_period, report_date, date_state, eps_actual, revenue_actual,
    results_filing_id, source_object_id
  from base
  on conflict (security_id, fiscal_period) do update set
    report_date       = excluded.report_date,
    date_state        = excluded.date_state,
    eps_actual        = excluded.eps_actual,
    revenue_actual    = excluded.revenue_actual,
    results_filing_id = excluded.results_filing_id,
    source_object_id  = excluded.source_object_id,
    updated_at        = now();

  get diagnostics v_n = row_count;

  update public.earnings_events e
     set eps_prior  = p.eps_actual,
         updated_at = now()
    from public.earnings_events p
   where substring(e.fiscal_period from '(\d{4})$') is not null
     and p.security_id   = e.security_id
     and p.fiscal_period = left(e.fiscal_period, length(e.fiscal_period) - 4)
                           || ((substring(e.fiscal_period from '(\d{4})$'))::int - 1)::text
     and p.eps_actual is not null
     and e.eps_prior is distinct from p.eps_actual;

  return v_n;
end $fn$;

-- Re-guard the existing rows now (idempotent).
select lake.fn_project_earnings_from_income();

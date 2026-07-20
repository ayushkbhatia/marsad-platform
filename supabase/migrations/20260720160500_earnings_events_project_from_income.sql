-- 20260720160500_earnings_events_project_from_income — project quarterly income
-- statements from the lake into public.earnings_events (reader Earnings tab).
--
-- Source: public.financial_statements where statement_type='income' and
-- period_kind='quarter'. One event per (security_id, fiscal_period); when both a
-- consolidated and a standalone statement exist for the same period we prefer
-- consolidated (DISTINCT ON). Only ACTUALS are projected — eps_actual, revenue_actual,
-- report_date, the results filing link and the source object. Consensus / estimates /
-- verdict / surprise stay NULL on purpose: there is no consensus source yet, and writing
-- verdict would wake the Score Revisions recompute — this projection must stay dormant on
-- that surface.
--
-- report_date is coalesce(filed_at, period_end): 'confirmed' when we have the filing's
-- filed_at, else 'estimated' from the statement period_end (period_end is NOT NULL on
-- financial_statements, so report_date — a NOT NULL column — always resolves).
--
-- is_restated filter is load-bearing (restatement versioning contract).
-- Fully schema-qualified throughout (function runs with search_path = '').

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
      -- DEFENSIVE GUARD (TDWL-EPS landmine): live data has income rows where
      -- line_items->>'eps_diluted' == 'eps_basic' == a raw net_income value (millions/
      -- billions) — a mis-map in the TDWL XBRL extractor. A real per-share EPS is never
      -- that large in any GCC currency, so null it out above a generous bound. This is a
      -- projection-side shield only; the ROOT FIX is the TDWL XBRL extractor (tracked
      -- separately — see the XBRL enrichment backlog).
      case
        when abs(coalesce((fs.line_items->>'eps_diluted')::numeric,
                          (fs.line_items->>'eps_basic')::numeric)) > 100000
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

  -- eps_prior second pass: fill from the prior-year same-quarter event's already-projected
  -- (and landmine-guarded) eps_actual. Prior label = decrement the trailing 4-digit year
  -- ("Q3 2025" -> "Q3 2024", "9M 2025" -> "9M 2024"). Only fires where a trailing year
  -- exists and the sibling has an eps_actual; the "is distinct from" guard keeps re-runs no-op.
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

-- Schedule: 21:35 UTC = 01:35 GST (after dividends_project at 21:30, before the 02:00 GST
-- nightly omnibus). Idempotent (unschedule-if-exists then schedule).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'earnings_events_project') then
    perform cron.unschedule('earnings_events_project');
  end if;
end $$;
select cron.schedule('earnings_events_project', '35 21 * * *',
  $$select lake.fn_project_earnings_from_income()$$);

-- One-shot backfill of the ~4,050 existing quarterly income events (idempotent).
select lake.fn_project_earnings_from_income();

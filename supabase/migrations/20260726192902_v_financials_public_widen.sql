-- Widen the free financials window: 4Q/2Y -> 8Q/10Y.
--
-- WHY: design 3b renders an 8-quarter and a 10-year table. The first cut of
-- `v_financials_public` (20260726192153) served 4 quarters + 2 annuals, which
-- left the pixel-perfect grids half empty. The data is there (typically 18
-- periods per covered security), and 8Q/10Y is exactly what the design shows.
--
-- The premium boundary changes in DEPTH only, not in KIND: pre-window history,
-- the full `line_items` bag, segment breakdowns and statement presentation all
-- remain worker/premium-only. TDWL EPS suppression is preserved verbatim
-- (DEF-TDWL-EPS-MAPPING).

drop view if exists public.v_financials_public;

create view public.v_financials_public with (security_invoker = false) as
with windowed as (
  select
    fs.security_id,
    s.venue_code,
    fs.statement_type,
    fs.period_kind,
    fs.fiscal_period,
    fs.period_end,
    fs.currency,
    fs.is_estimate,
    fs.is_restated,
    fs.audited,
    fs.updated_at,
    fs.line_items,
    dense_rank() over (
      partition by fs.security_id, fs.period_kind
      order by fs.period_end desc
    ) as period_rank
  from public.financial_statements fs
  join public.securities s on s.id = fs.security_id
  where fs.statement_type in ('income', 'balance', 'cashflow')
    and fs.basis = 'consolidated'
)
select
  w.security_id,
  w.statement_type,
  w.period_kind,
  w.fiscal_period,
  w.period_end,
  w.currency,
  w.is_estimate,
  w.is_restated,
  w.audited,
  w.updated_at,
  w.period_rank,

  -- income statement
  coalesce(
    (w.line_items ->> 'revenue')::numeric,
    (w.line_items ->> 'total_operating_income')::numeric
  )                                                        as revenue,
  (w.line_items ->> 'cost_of_sales')::numeric              as cost_of_sales,
  (w.line_items ->> 'gross_profit')::numeric               as gross_profit,
  coalesce(
    (w.line_items ->> 'ebit')::numeric,
    (w.line_items ->> 'operating_income')::numeric
  )                                                        as ebit,
  (w.line_items ->> 'finance_costs')::numeric              as finance_costs,
  (w.line_items ->> 'profit_before_tax')::numeric          as profit_before_tax,
  (w.line_items ->> 'income_tax_expense')::numeric         as income_tax_expense,
  (w.line_items ->> 'net_income')::numeric                 as net_income,
  -- DEF-TDWL-EPS-MAPPING: withheld on TDWL, never guessed.
  case when w.venue_code <> 'TDWL'
       then (w.line_items ->> 'eps_basic')::numeric   end  as eps_basic,
  case when w.venue_code <> 'TDWL'
       then (w.line_items ->> 'eps_diluted')::numeric end  as eps_diluted,
  (w.venue_code = 'TDWL' and w.statement_type = 'income')  as eps_suppressed,

  -- balance sheet
  (w.line_items ->> 'total_assets')::numeric               as total_assets,
  (w.line_items ->> 'total_liabilities')::numeric          as total_liabilities,
  coalesce(
    (w.line_items ->> 'equity')::numeric,
    (w.line_items ->> 'total_equity')::numeric
  )                                                        as equity,
  (w.line_items ->> 'cash')::numeric                       as cash,
  (w.line_items ->> 'total_debt')::numeric                 as total_debt,

  -- cash flow  (NOTE: `capex` and `dividends_paid` sign conventions are NOT normalized
  --  upstream — both signs occur — so the reader renders them as stored and never derives
  --  free cash flow from them.)
  (w.line_items ->> 'cfo')::numeric                        as cfo,
  (w.line_items ->> 'cfi')::numeric                        as cfi,
  (w.line_items ->> 'cff')::numeric                        as cff,
  (w.line_items ->> 'capex')::numeric                      as capex,
  (w.line_items ->> 'dep_amort')::numeric                  as dep_amort,
  (w.line_items ->> 'dividends_paid')::numeric             as dividends_paid
from windowed w
where (w.period_kind = 'quarter' and w.period_rank <= 8)
   or (w.period_kind = 'annual'  and w.period_rank <= 10);

comment on view public.v_financials_public is
  'Anon-safe FREE cut of financial_statements: the 8 most recent quarterly + 10 most recent annual '
  'consolidated periods per security, headline income/balance/cashflow lines only. Deep history, '
  'the full line_items bag, segments and presentation stay premium. EPS is NULL with '
  'eps_suppressed=true on TDWL until DEF-TDWL-EPS-MAPPING closes. Mirrors v_scores_public / '
  'v_key_ratios_public.';

grant select on public.v_financials_public to anon, authenticated;

-- 20260726192153 — anon-readable FREE cut of public.financial_statements (BRIDGE-BUILD-PLAN P1.6).
--
-- WHY: `public.financial_statements` (52,277 rows, 626 of 762 securities) carries a single
-- `worker_all` RLS policy, so anon sees ZERO rows and the stock Financials tab (design 3b) has
-- no reader path at all. This mirrors `public.v_scores_public` / `public.v_key_ratios_public`
-- exactly: an owner-privileged (`security_invoker = false`) view exposing only the free subset.
-- Chosen over a service-role read deliberately — a service-role read inside `use cache` can leak
-- premium rows into a shared CDN entry (BRIDGE-BUILD-PLAN §6, "Service-role in a cached reader").
--
-- ── FREE TIER: which PERIODS ────────────────────────────────────────────────────────────────
-- The 4 most recent quarterly period-ends and the 2 most recent annual period-ends per security.
-- `dense_rank()` is partitioned by (security_id, period_kind) and ordered by period_end desc, so
-- the three statement types that share a period-end all carry the SAME rank and the free window
-- stays period-aligned (income/balance/cashflow never drift apart by a quarter).
-- Deep history (2013→) stays premium and is rendered behind `PremiumLock` in the reader.
--
-- ── FREE TIER: which LINE ITEMS ─────────────────────────────────────────────────────────────
-- Headline P&L / balance / cash-flow lines only, as explicit numeric columns. `line_items` is a
-- wide jsonb bag (thousands of distinct XBRL-derived keys); the full bag, `segments`, and
-- `presentation` are NOT exposed. Synonym coalesces (documented, no invention):
--   revenue := revenue → total_operating_income   (banks file the latter)
--   ebit    := ebit    → operating_income
--   equity  := equity  → total_equity
-- Every jsonb value in this table is a JSON `number` (verified: 1 distinct jsonb_typeof), so the
-- `::numeric` casts below cannot raise.
--
-- ── DEF-TDWL-EPS-MAPPING (open) ─────────────────────────────────────────────────────────────
-- The TDWL XBRL extractor writes `net_income` into `eps_diluted`, silently corrupting EPS and
-- therefore P/E (BUILD-STATUS §7). Until that is closed, `eps_basic` / `eps_diluted` are forced
-- to NULL for every TDWL security and `eps_suppressed` is set true, so the reader can render a
-- visible "withheld" note rather than a wrong number. Suppression lives HERE, in the view, so no
-- consumer of the free cut can accidentally surface a corrupt per-share figure.
-- Scope note (measured 2026-07-26): 0 TDWL income rows currently satisfy the ledger's detector
-- (`eps_diluted = net_income`, non-zero) and 1 TDWL row carries `abs(eps) > 1000` — consistent
-- with the 2026-07-20 root fix having landed while the §7 row is still open. Suppression is
-- deliberately kept until that row is formally retired.
--
-- Rows: one per (security_id, statement_type, period_kind, period_end). The base table has a
-- unique period group (verified: 0 duplicate groups), so no restatement-version dedup is needed.

set search_path = '';

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
where (w.period_kind = 'quarter' and w.period_rank <= 4)
   or (w.period_kind = 'annual'  and w.period_rank <= 2);

comment on view public.v_financials_public is
  'Anon-safe FREE cut of financial_statements: the 4 most recent quarterly + 2 most recent annual '
  'consolidated periods per security, headline income/balance/cashflow lines only. Deep history, '
  'the full line_items bag, segments and presentation stay premium. EPS is NULL with '
  'eps_suppressed=true on TDWL until DEF-TDWL-EPS-MAPPING closes. Mirrors v_scores_public / '
  'v_key_ratios_public.';

grant select on public.v_financials_public to anon, authenticated;

-- 20260720160000_dividends_project_from_equity — project the statement lake's
-- equity_change dividend cash TOTALS into public.dividends (reader Dividends tab).
--
-- Source: public.financial_statements where statement_type='equity_change' (TDWL-only
-- today). The equity_change line_items carry per-period dividend CASH TOTALS, not a
-- per-share declaration and with no ex/record/pay dates — so this projection populates
-- amount_total (new column) as the source of truth and derives dps only when
-- securities.shares_outstanding is known (NULL for ~94% today — accepted; dps relaxed
-- to nullable below). Registrar-grade DPS + dates + go-live remain a human step
-- (dividends_confirm_guard trigger): every row lands in state='pending_confirm'.
--
-- NCI FILTER IS LOAD-BEARING: dividends paid to non-controlling interests are NOT
-- shareholder dividends. We match ONLY the bare per-line-item total keys (exact IN
-- list); the extractor also emits per-equity-column breakdown keys like
-- final_dividend_paid__non_controlling_interests / __total_equity / __retained_earnings
-- which must never be summed here. The exact IN list already excludes those composites;
-- the "not like %non_controlling%" is a redundant belt-and-suspenders guard kept per spec.
--
-- is_restated filter is load-bearing (restatement versioning contract — the superseded
-- version lives in financial_statement_history, never project it).
--
-- Fully schema-qualified throughout (function runs with search_path = '').

set search_path = '';

-- 1. Schema relax: equity_change carries a cash TOTAL, not a DPS, and no dates.
alter table public.dividends add column if not exists amount_total numeric;
alter table public.dividends add column if not exists period_end date;
alter table public.dividends alter column dps drop not null;

comment on column public.dividends.amount_total is
  'Retrospective TOTAL cash distribution for the period, in the row currency (from the '
  'equity_change statement''s dividend line-item total) — NOT a per-share declaration. '
  'dps is derived from this only when securities.shares_outstanding is known.';
comment on column public.dividends.period_end is
  'period_end of the source financial_statements row this dividend total was projected from.';

-- 2. Projection function. Set-based, idempotent, never clobbers a human-confirmed row.
create or replace function lake.fn_project_dividends_from_equity() returns integer
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_n integer;
begin
  with matched as (
    select
      fs.security_id,
      case when kv.key like 'interim%' then 'INTERIM' else 'FINAL' end as div_type,
      fs.fiscal_period                              as fiscal_ref,
      upper(left(fs.currency, 3))                   as currency,
      abs(kv.value::numeric)                        as amount_total,
      fs.period_end,
      fs.source_object_id,
      s.shares_outstanding,
      fs.basis,
      fs.id                                         as fs_id
    from public.financial_statements fs
    join public.securities s on s.id = fs.security_id
    cross join lateral jsonb_each_text(fs.line_items) kv
    where fs.statement_type   = 'equity_change'
      and fs.is_restated is not true
      and fs.source_object_id is not null
      and kv.key in ('final_dividend_paid', 'interim_dividend_paid', 'cash_dividend',
                     'cash_dividends_paid', 'dividends_recognised_as_distributions_to_owners')
      and kv.key not like '%non_controlling%'   -- LOAD-BEARING: NCI is not a shareholder dividend
      and kv.value ~ '^-?[0-9]'                  -- guard: parseable numeric only (never abort the cron)
      and kv.value::numeric <> 0
  ),
  -- Dedup to one row per dividends natural key. ex_date is always NULL in this projection,
  -- so the natural key collapses to (security_id, div_type, fiscal_ref). No collisions in
  -- today's data (equity_change is consolidated-only), but preferring consolidated protects
  -- idempotency against the ON CONFLICT "cannot affect row a second time" trap if a
  -- standalone-basis equity_change ever appears.
  dedup as (
    select distinct on (security_id, div_type, fiscal_ref)
      security_id, div_type, fiscal_ref, currency, amount_total, period_end,
      source_object_id, shares_outstanding
    from matched
    order by security_id, div_type, fiscal_ref,
             (basis = 'consolidated') desc, period_end desc nulls last, fs_id desc
  )
  insert into public.dividends
    (security_id, div_type, fiscal_ref, dps, amount_total, currency, period_end,
     payout_ratio, verification, state, source_object_id)
  select
    d.security_id,
    d.div_type,
    d.fiscal_ref,
    d.amount_total / nullif(d.shares_outstanding, 0)      as dps,          -- NULL when shares unknown
    d.amount_total,
    d.currency,
    d.period_end,
    d.amount_total / nullif(abs(inc.net_income), 0)       as payout_ratio, -- NULL when no matching income NI
    'disclosure',
    'pending_confirm',
    d.source_object_id
  from dedup d
  left join lateral (
    -- net_income for the SAME (security_id, fiscal_period), preferring consolidated.
    select (i.line_items->>'net_income')::numeric as net_income
    from public.financial_statements i
    where i.statement_type = 'income'
      and i.security_id    = d.security_id
      and i.fiscal_period  = d.fiscal_ref
      and i.is_restated is not true
      and i.line_items ? 'net_income'
    order by (i.basis = 'consolidated') desc, i.version desc, i.id desc
    limit 1
  ) inc on true
  on conflict (security_id, div_type, coalesce(fiscal_ref, ''), coalesce(ex_date, '9999-12-31'::date))
  do update set
    dps              = excluded.dps,
    amount_total     = excluded.amount_total,
    currency         = excluded.currency,
    period_end       = excluded.period_end,
    payout_ratio     = excluded.payout_ratio,   -- kept in sync with amount_total (guarded below)
    source_object_id = excluded.source_object_id,
    updated_at       = now()
  where public.dividends.state = 'pending_confirm';   -- NEVER clobber a human-confirmed live/cancelled row

  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

-- 3. Schedule: 21:30 UTC = 01:30 GST, BEFORE the 02:00 GST nightly key_ratios recompute
--    (nightly_omnibus) which reads dividends. Idempotent (unschedule-if-exists then schedule).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dividends_project') then
    perform cron.unschedule('dividends_project');
  end if;
end $$;
select cron.schedule('dividends_project', '30 21 * * *',
  $$select lake.fn_project_dividends_from_equity()$$);

-- 4. One-shot backfill of the ~1,147 existing dividend totals (idempotent — safe to re-run).
select lake.fn_project_dividends_from_equity();

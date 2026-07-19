-- 20260719175050_writer_context_pack — Phase D: the FIRST CONSUMER layer of the lake
-- (03-agent-newsroom.md §5.2 — "90% a SQL problem"). Two objects:
--
--   • lake.v_citable_objects — everything a writer may cite, typed, newest-first-able.
--     DIVERGENCE from the spec's VERIFIED-only: this lake is deliberately single-source
--     for statements/filings (they land + serve at PENDING per the P1.7b design), so the
--     view exposes BOTH states with `state` as a column — the P3 rules engine gates on it
--     per fact class; excluding PENDING here would blind writers to the entire
--     financials tier.
--
--   • lake.fn_writer_context(security_id, quarters, filings) → jsonb — ONE call, one
--     security's full context pack for an agent prompt: identity, price block, ratios,
--     score, statements (latest period full line_items; older periods trimmed to the
--     canonical §3.1 overlay — token budget), equity events (the Phase B equity_change
--     tier: dividends/buybacks/NCI), recent filings with the Phase C ai_summary/facts,
--     and per-section freshness stamps. Every fact block carries the lake object id /
--     serving row id it must be cited by ([cN] contract).
--
-- Access: worker + service_role ONLY (agent-facing, not reader-facing). No RLS bypass
-- for anon/authenticated — the view carries lake internals.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. v_citable_objects
-- ---------------------------------------------------------------------------
create or replace view lake.v_citable_objects as
select
  o.id,
  o.object_type,
  o.natural_key,
  o.venue_code,
  s.ticker,
  o.security_id,
  o.state,               -- 'VERIFIED' | 'PENDING' — rules gate on this per fact class
  o.source_rank,
  o.effective_date,
  o.verified_at,
  o.updated_at,
  o.payload,
  o.numeric_value,
  o.unit
from lake.objects o
left join public.securities s on s.id = o.security_id
where o.superseded_by is null
  and o.state in ('VERIFIED', 'PENDING');

comment on view lake.v_citable_objects is
  'Phase D (03 §5.2): the citable-facts surface for writer agents. state exposed — VERIFIED vs single-source PENDING is a rules decision, not a visibility one.';

-- ---------------------------------------------------------------------------
-- 2. fn_writer_context
-- ---------------------------------------------------------------------------
create or replace function lake.fn_writer_context(
  p_security_id bigint,
  p_quarters    int default 5,
  p_filings     int default 8
) returns jsonb
language sql stable security definer set search_path = ''
as $$
with sec as (
  select s.*, v.name as venue_name, v.currency as venue_currency, v.delay_minutes
  from public.securities s
  join public.venues v on v.code = s.venue_code
  where s.id = p_security_id
),
-- Canonical §3.1 overlay + the Phase B additions — older periods are trimmed to these
-- keys so the pack holds its token budget; the LATEST period of each type ships full.
canon as (
  select array[
    'revenue','gross_profit','ebit','dep_amort','net_income','eps_diluted','eps_basic',
    'equity','total_assets','total_liabilities','total_debt','cash','capital_employed',
    'current_liabilities','nii','avg_earning_assets','dividends_paid','cfo','cfi','cff',
    'total_comprehensive_income_loss_for_period','total_other_comprehensive_income_loss',
    'dividends_and_others','equity_balance_at_end_of_period'
  ] as keys
),
px as (
  select jsonb_build_object(
    'quote', (select jsonb_build_object(
                'last', q.last, 'change_pct', q.change_pct, 'as_of', q.as_of,
                'week52_high', q.week52_high, 'week52_low', q.week52_low,
                'delay_minutes', q.delay_minutes)
              from public.quotes_latest q where q.security_id = p_security_id),
    'latest_close', (select jsonb_build_object('trade_date', o.trade_date, 'close', o.close)
                     from public.ohlcv_daily o where o.security_id = p_security_id
                     order by o.trade_date desc limit 1),
    'return_3m',  (select round((a.close / nullif(b.close, 0) - 1) * 100, 2)
                   from (select close from public.ohlcv_daily where security_id = p_security_id order by trade_date desc limit 1) a,
                        (select close from public.ohlcv_daily where security_id = p_security_id and trade_date <= current_date - 91 order by trade_date desc limit 1) b),
    'return_12m', (select round((a.close / nullif(b.close, 0) - 1) * 100, 2)
                   from (select close from public.ohlcv_daily where security_id = p_security_id order by trade_date desc limit 1) a,
                        (select close from public.ohlcv_daily where security_id = p_security_id and trade_date <= current_date - 365 order by trade_date desc limit 1) b),
    'bar_count', (select count(*) from public.ohlcv_daily where security_id = p_security_id)
  ) as block
),
stmts as (
  -- Latest annual + last p_quarters quarters per core type, + latest oci + latest equity_change.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'statement_type', t.statement_type,
             'fiscal_period',  t.fiscal_period,
             'period_kind',    t.period_kind,
             'period_end',     t.period_end,
             'currency',       t.currency,
             'version',        t.version,
             'is_restated',    t.is_restated,
             'row_id',         t.id,
             'source_object_id', t.source_object_id,
             'source_filing_id', t.source_filing_id,
             'line_items',     case when t.rn = 1 then t.line_items
                                    else (select jsonb_object_agg(k.key, t.line_items -> k.key)
                                          from unnest((select keys from canon)) as k(key)
                                          where t.line_items ? k.key) end
           ) order by t.statement_type, t.period_end desc), '[]'::jsonb) as arr
  from (
    select fs.*,
           row_number() over (partition by fs.statement_type order by fs.period_end desc) as rn
    from public.financial_statements fs
    where fs.security_id = p_security_id and fs.is_estimate = false
  ) t
  where (t.statement_type in ('income','balance','cashflow') and
         (t.period_kind = 'annual' and t.rn <= 2 or t.period_kind = 'quarter' and t.rn <= p_quarters))
     or (t.statement_type in ('oci','equity_change') and t.rn <= 2)
),
fil as (
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'filing_id', f.id, 'filed_at', f.filed_at, 'filing_type', f.filing_type,
             'title', left(f.title, 160), 'is_market_moving', f.is_market_moving,
             'ai_summary', f.ai_summary,
             'facts', f.extracted_facts -> 'ai') order by f.filed_at desc), '[]'::jsonb) as arr
  from (
    select * from public.filings
    where security_id = p_security_id
    order by filed_at desc limit p_filings
  ) f
)
select jsonb_build_object(
  'generated_for', 'writer_context/v1',
  'identity', (select jsonb_build_object(
      'security_id', id, 'ticker', ticker, 'name', name_en, 'venue', venue_code,
      'venue_name', venue_name, 'sector', sector, 'industry', industry, 'isin', isin,
      'shares_outstanding', shares_outstanding, 'currency', currency,
      'listing_date', listing_date, 'status', status) from sec),
  'price', (select block from px),
  'ratios', (select to_jsonb(kr) - 'security_id' from public.key_ratios kr where kr.security_id = p_security_id),
  'score', (select to_jsonb(sc) - 'security_id' from public.scores sc where sc.security_id = p_security_id),
  'statements', (select arr from stmts),
  'filings', (select arr from fil),
  'freshness', jsonb_build_object(
      'statements_latest_ingest', (select max(updated_at) from public.financial_statements where security_id = p_security_id),
      'quote_as_of',   (select as_of from public.quotes_latest where security_id = p_security_id),
      'ratios_computed_at', (select computed_at from public.key_ratios where security_id = p_security_id),
      'filings_latest', (select max(filed_at) from public.filings where security_id = p_security_id),
      'pack_generated_at', now())
)
from sec;
$$;

comment on function lake.fn_writer_context(bigint, int, int) is
  'Phase D: one security''s full agent context pack. Latest period per statement type ships full line_items; older periods trim to the canonical overlay (token budget). NULL when the security id does not exist.';

-- ---------------------------------------------------------------------------
-- 3. Grants — agent/worker surfaces only.
-- ---------------------------------------------------------------------------
grant select on lake.v_citable_objects to marsad_worker, service_role;
grant execute on function lake.fn_writer_context(bigint, int, int) to marsad_worker, service_role;

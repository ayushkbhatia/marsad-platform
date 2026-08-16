-- Do not offer the writer a figure it is forbidden to cite.
--
-- ── FOUND BY RUNNING THE CONVEYOR ─────────────────────────────────────────────
-- With the R-03 provenance floor live, pipeline item 3 redrafted and got materially
-- further than it ever had — but still blocked, on exactly one violation:
--
--   {"kind":"cited_object_in_conflict","key":"c14","object_type":"FILING.FINANCIALS"}
--
-- R-03 was right: 20260816120000 marked 2,586 objects CONFLICT because two independent
-- extraction lanes disagree about them, and a disputed number has no business in a
-- published sentence.
--
-- The bug is upstream of the rule. `fn_writer_context` sources `statements` from
-- public.financial_statements, whose projection ran while the object was PENDING and is
-- NOT withdrawn when the object later goes to CONFLICT (fn_financials_project returns early
-- for any state outside PENDING/VERIFIED, so it simply stops refreshing the row). The pack
-- therefore handed the writer a statement complete with a source_object_id, the writer
-- reasonably cited it, and the ruleset then rejected the draft for doing so.
--
-- That is the same shape as the truncated-pack bug: give the model something, then punish it
-- for using it. The rule is not the thing to relax — the pack is the thing to fix.
--
-- Disputed statements are dropped from the pack entirely rather than passed with a null id.
-- Passing them id-less would leave the number visible, and a writer that used it would fail
-- R-03 for `number_without_citation` instead — a different error message for the same trap.

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
canon as (
  select array[
    'revenue','gross_profit','ebit','dep_amort','net_income','eps_diluted','eps_basic',
    'equity','total_assets','total_liabilities','total_debt','cash','capital_employed',
    'current_liabilities','nii','avg_earning_assets','dividends_paid','cfo','cfi','cff',
    'total_comprehensive_income_loss_for_period','total_other_comprehensive_income_loss',
    'dividends_and_others','equity_balance_at_end_of_period'
  ] as keys
),
quote_obj as (
  select o.id, o.state from lake.objects o
  where o.object_type = 'QUOTE.LAST' and o.security_id = p_security_id and o.superseded_by is null
  order by o.effective_date desc nulls last, o.updated_at desc limit 1
),
profile_obj as (
  select o.id from lake.objects o
  where o.object_type = 'PROFILE.SECURITY' and o.security_id = p_security_id and o.superseded_by is null
  order by o.updated_at desc limit 1
),
px as (
  select jsonb_build_object(
    'quote', (select jsonb_build_object(
                'last', q.last, 'change_pct', q.change_pct, 'as_of', q.as_of,
                'week52_high', q.week52_high, 'week52_low', q.week52_low,
                'delay_minutes', q.delay_minutes)
              from public.quotes_latest q where q.security_id = p_security_id),
    'source_object_id', (select qo.id from quote_obj qo
                          where qo.state <> 'CONFLICT'
                            and exists (select 1 from public.quotes_latest q
                                         where q.security_id = p_security_id
                                           and q.as_of > now() - interval '26 hours')),
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
      -- Withhold anything whose lake object is DISPUTED or RETIRED. The projected row
      -- survives a CONFLICT (fn_financials_project just stops refreshing it), so without
      -- this the pack advertises a figure R-03 will reject on sight.
      and not exists (
        select 1 from lake.objects o
         where o.id = fs.source_object_id
           and (o.state = 'CONFLICT' or o.superseded_by is not null)
      )
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
             'source_object_id', f.lake_object_id,
             'facts', f.extracted_facts -> 'ai') order by f.filed_at desc), '[]'::jsonb) as arr
  from (
    select f.*,
           (select o.id from lake.objects o
             where o.natural_key = 'FILING.REF:' || f.venue_code || ':' || f.source_ref
               and o.superseded_by is null
               and o.state <> 'CONFLICT'
             limit 1) as lake_object_id
    from public.filings f
    where f.security_id = p_security_id
    order by f.filed_at desc limit p_filings
  ) f
)
select jsonb_build_object(
  'generated_for', 'writer_context/v3',
  'identity', (select jsonb_build_object(
      'security_id', id, 'ticker', ticker, 'name', name_en, 'venue', venue_code,
      'venue_name', venue_name, 'sector', sector, 'industry', industry, 'isin', isin,
      'shares_outstanding', shares_outstanding, 'currency', currency,
      'listing_date', listing_date, 'status', status,
      'source_object_id', (select id from profile_obj)) from sec),
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
  'v3: one security''s agent context pack. Every citable section carries source_object_id, and '
  'anything the ruleset would refuse is withheld rather than advertised — statements backed by a '
  'CONFLICT or superseded lake object are dropped, and the quote id is emitted only while the '
  'quote is inside 26h. Latest period per statement type ships full line_items; older periods '
  'trim to the canonical overlay. NULL when the security id does not exist.';

grant execute on function lake.fn_writer_context(bigint, int, int) to marsad_worker, service_role;

do $$
declare v_sid bigint; v_bad int;
begin
  select id into v_sid from public.securities where ticker = 'QNBK' and venue_code = 'QE';
  if v_sid is null then return; end if;

  -- No statement the pack offers may be backed by a disputed object.
  select count(*) into v_bad
    from jsonb_array_elements(lake.fn_writer_context(v_sid) -> 'statements') s
    join lake.objects o on o.id = (s ->> 'source_object_id')::uuid
   where o.state = 'CONFLICT' or o.superseded_by is not null;
  if v_bad > 0 then
    raise exception '% disputed statements are still offered to the writer', v_bad;
  end if;
end $$;

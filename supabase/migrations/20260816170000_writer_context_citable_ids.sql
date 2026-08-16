-- Give the writer a citable id for the sections that had none.
--
-- ── THE BUG ───────────────────────────────────────────────────────────────────
-- R-03 requires every number in the prose to carry a [cN] resolving to a lake object, and
-- draft.ts terminally reassigns any draft citing an id it was not given. But of the pack's
-- seven sections, only `statements` (source_object_id), `ratios` and `score` carried one.
--
-- `price`, `identity` and `filings` carried NO citable id at all — `filings` exposes
-- `filing_id`, a bigint row id in public.filings, which is not a lake object and can never
-- satisfy a citation.
--
-- So a writer that mentioned the share price, the 12-month return, the company's shares
-- outstanding, or anything it read in a filing summary had exactly two options: cite an id
-- it was never shown (→ reassigned as an inventor) or omit the fact. That is the shape of
-- every wire-length story — "X's shares did Y after filing Z" — so the wire path was the
-- one most completely blocked.
--
-- ── HOW MUCH OF THIS ACTUALLY RESOLVES TODAY (measured 2026-08-16) ────────────
-- identity, price, ratios and score now resolve for essentially every security. FILINGS DO
-- NOT, and the reason is upstream: only 1,878 FILING.REF objects exist for 16,043 filings,
-- and none carry a security_id.
--
--   venue   filings   with a FILING.REF object
--   TDWL      7,152   0     (filings_list source inactive — nothing ever created one)
--   MSX       2,909   638   (21.9%)
--   QE        2,178   0     (filings_list source inactive)
--   ADX       2,105   646   (30.7%)
--   DFM       1,111   361   (32.5%)
--   BHB         599   233   (38.9%)
--
-- The join is right; the objects are missing. Filings that arrived through a researcher lane
-- (BHB-FS-*, MSX-FS-*) were written straight to public.filings and never objectified, so
-- there is nothing to cite. This is exactly the hole PE's FILING.EVENT canonicaliser fills —
-- one object per comprehended filing, ~9,270 of them — and this column starts resolving the
-- day that lands, with no further change here. Recorded rather than hidden: a writer that
-- cannot cite a filing summary today will still omit the fact, and that is the honest
-- behaviour until the objects exist.
--
-- ── WHY THE PRICE ID IS FRESHNESS-GATED ───────────────────────────────────────
-- Making a quote citable makes a STALE quote publishable. GCC venues close ~12:15 UTC and
-- the pack is built whenever the conveyor runs, so without a bound the writer could cite
-- yesterday's close as "the last price". The id is emitted only when the quote is inside 26
-- hours (one session plus a weekend margin); otherwise the section is present and unciteable,
-- which is the honest state — the number is still context, it is just no longer a fact
-- anyone may print.

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
-- The live QUOTE.LAST object behind public.quotes_latest, and the PROFILE.SECURITY object
-- behind the identity block. Both are what the projections were built from, so citing them
-- points at the same fact the reader sees.
quote_obj as (
  select o.id, o.state
  from lake.objects o
  where o.object_type = 'QUOTE.LAST' and o.security_id = p_security_id
    and o.superseded_by is null
  order by o.effective_date desc nulls last, o.updated_at desc
  limit 1
),
profile_obj as (
  select o.id
  from lake.objects o
  where o.object_type = 'PROFILE.SECURITY' and o.security_id = p_security_id
    and o.superseded_by is null
  order by o.updated_at desc
  limit 1
),
px as (
  select jsonb_build_object(
    'quote', (select jsonb_build_object(
                'last', q.last, 'change_pct', q.change_pct, 'as_of', q.as_of,
                'week52_high', q.week52_high, 'week52_low', q.week52_low,
                'delay_minutes', q.delay_minutes)
              from public.quotes_latest q where q.security_id = p_security_id),
    -- Citable only while fresh: a quote older than one session + a weekend margin is context,
    -- not a printable fact.
    'source_object_id', (select qo.id from quote_obj qo
                          where exists (select 1 from public.quotes_latest q
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
             -- The lake object behind this filing. Without it a writer could read a filing
             -- summary and had no legal way to cite what it had just read.
             'source_object_id', f.lake_object_id,
             'facts', f.extracted_facts -> 'ai') order by f.filed_at desc), '[]'::jsonb) as arr
  from (
    select f.*,
           -- Matched on natural_key, which is exactly 'FILING.REF:{venue}:{source_ref}' and is
           -- covered by the one-live-per-key unique index. The payload spells the same value
           -- `sourceRef` (camelCase, producer-side convention) — joining on that instead would
           -- be both wrong-cased and a full scan.
           (select o.id from lake.objects o
             where o.natural_key = 'FILING.REF:' || f.venue_code || ':' || f.source_ref
               and o.superseded_by is null
             limit 1) as lake_object_id
    from public.filings f
    where f.security_id = p_security_id
    order by f.filed_at desc limit p_filings
  ) f
)
select jsonb_build_object(
  'generated_for', 'writer_context/v2',
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
  'v2: one security''s full agent context pack. Latest period per statement type ships full '
  'line_items; older periods trim to the canonical overlay (token budget). Every section that '
  'can be cited now carries source_object_id — price (freshness-gated to 26h), identity and '
  'filings previously carried none, so a writer mentioning a share price or a filing summary '
  'had to either invent an id or omit the fact. NULL when the security id does not exist.';

grant execute on function lake.fn_writer_context(bigint, int, int) to marsad_worker, service_role;

do $$
declare v_pack jsonb; v_sid bigint;
begin
  -- QNBK, the security every recorded draft was written about.
  select id into v_sid from public.securities where ticker = 'QNBK' and venue_code = 'QE';
  if v_sid is null then return; end if;
  v_pack := lake.fn_writer_context(v_sid);

  if v_pack -> 'identity' ->> 'source_object_id' is null then
    raise warning 'writer_context: identity has no PROFILE.SECURITY object for QNBK';
  end if;
  if jsonb_array_length(coalesce(v_pack -> 'statements', '[]'::jsonb)) = 0 then
    raise exception 'writer_context: statements empty for QNBK — the pack lost its citable section';
  end if;
  raise notice 'writer_context v2 ok: % statements, % filings, % of them citable',
    jsonb_array_length(v_pack -> 'statements'), jsonb_array_length(v_pack -> 'filings'),
    (select count(*) from jsonb_array_elements(v_pack -> 'filings') f
      where f ->> 'source_object_id' is not null);
end $$;

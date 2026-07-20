-- 20260721100000_financials_xcheck_reconcile_v2 — tighten the FINANCIALS.XCHECK reconcile so a
-- "conflict" reflects a REAL disagreement, not cross-source definitional variance.
--
-- The v1 bounded run showed the raw 23% conflict rate was dominated by DEFINITIONAL keys
-- (total_debt = debt composition; ebit = computed-vs-filed operating income; cash = cash vs
-- cash+equivalents; and the whole cashflow subtotal set cfo/cff/cfi/dep_amort = sign/scope
-- conventions) blowing up max_rel_diff even when the CORE (revenue/net_income/assets/liab/equity)
-- agreed to within a few %. v2:
--   • CORE keys (tight FIN_TOL=1%, DRIVE the conflict verdict): income{revenue,net_income};
--     balance{total_assets,total_liabilities,equity}; cashflow{} (no definition-stable subtotal).
--   • DEFINITIONAL keys (RECORDED in mismatched with note='definitional', a wider FIN_DEF_TOL band
--     for the audit, but NEVER set the conflict): income{gross_profit,ebit}; balance{cash,total_debt};
--     cashflow{cfo,cff,cfi,dep_amort}.
-- Verdict: conflict iff a CORE key exceeds FIN_TOL; agree iff ≥1 core key compared and all within tol;
-- gap_source_only iff no core key shared (oci/equity_change/cashflow-only). max_rel_diff is over CORE
-- keys only (so the Desk queue orders by real disagreement). Golden + fn_financials_project untouched.

set search_path = '';

create or replace function lake.fn_financials_xcheck_reconcile()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $function$
declare
  v_fin_tol   constant numeric := 0.01;   -- core pass/fail band
  v_stmt   text    := new.payload ->> 'statement_type';
  v_kind   text    := new.payload ->> 'period_kind';
  v_fp     text    := new.payload ->> 'fiscal_period';
  v_pe     date    := nullif(new.payload ->> 'period_end', '')::date;
  v_ccy    char(3) := upper(left(coalesce(new.payload ->> 'currency', 'SAR'), 3));
  v_basis  text    := coalesce(nullif(new.payload ->> 'basis', ''), 'consolidated');
  v_items  jsonb   := new.payload -> 'line_items';
  v_venue  text    := coalesce(nullif(new.payload ->> 'venue', ''), new.venue_code);
  v_source text    := coalesce(nullif(new.payload ->> 'source', ''), 'stockanalysis');
  v_sid    bigint;
  v_golden       public.financial_statements%rowtype;
  v_gitems       jsonb;
  v_sitems       jsonb := new.payload -> 'line_items';
  v_core_keys    text[];
  v_def_keys     text[];
  v_ps_keys      text[] := array['eps_basic', 'eps_diluted', 'dps', 'book_value_ps'];
  v_key          text;
  v_g            numeric;
  v_s            numeric;
  v_rel          numeric;
  v_max_rel      numeric := 0;      -- over CORE keys only
  v_n            integer := 0;      -- count of comparable CORE keys
  v_conflict     boolean := false;
  v_mismatched   jsonb   := '[]'::jsonb;
  v_golden_prims jsonb   := '{}'::jsonb;
  v_source_prims jsonb   := '{}'::jsonb;
  v_status       text;
begin
  if new.object_type <> 'FINANCIALS.XCHECK' then return null; end if;
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;

  if v_stmt not in ('income', 'balance', 'cashflow', 'oci', 'equity_change') then
    raise warning 'fn_financials_xcheck_reconcile skip %: bad statement_type "%"', new.natural_key, coalesce(v_stmt, '<null>');
    return null;
  end if;
  if v_kind not in ('quarter', 'annual', 'ttm') then
    raise warning 'fn_financials_xcheck_reconcile skip %: bad period_kind "%"', new.natural_key, coalesce(v_kind, '<null>');
    return null;
  end if;
  if v_fp is null or v_pe is null then
    raise warning 'fn_financials_xcheck_reconcile skip %: missing fiscal_period/period_end', new.natural_key;
    return null;
  end if;
  if v_basis not in ('consolidated', 'standalone') then v_basis := 'consolidated'; end if;
  if v_items is null or jsonb_typeof(v_items) <> 'object' then
    raise warning 'fn_financials_xcheck_reconcile skip %: line_items not a jsonb object', new.natural_key;
    return null;
  end if;

  v_sid := new.security_id;
  if v_sid is null then
    select id into v_sid from public.securities
     where venue_code = v_venue and ticker = new.payload ->> 'ticker';
  end if;
  if v_sid is null then
    raise warning 'fn_financials_xcheck_reconcile skip %: unresolvable security (venue=%, ticker=%)',
      new.natural_key, v_venue, new.payload ->> 'ticker';
    return null;
  end if;

  select * into v_golden from public.financial_statements
   where security_id = v_sid and statement_type = v_stmt and basis = v_basis
     and fiscal_period = v_fp and is_estimate is not true;

  if not found then
    insert into public.financial_statement_xcheck
      (security_id, statement_type, basis, period_kind, fiscal_period, period_end, currency,
       source, status, line_items, golden_object_id, max_rel_diff, mismatched, source_object_id, checked_at)
    values
      (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe, v_ccy,
       v_source, 'gap_golden_missing', v_items, null, null, null, new.id, now())
    on conflict (security_id, statement_type, basis, fiscal_period, source) do update
      set period_kind      = excluded.period_kind, period_end = excluded.period_end,
          currency         = excluded.currency, status = excluded.status,
          line_items       = excluded.line_items, golden_object_id = excluded.golden_object_id,
          max_rel_diff     = excluded.max_rel_diff, mismatched = excluded.mismatched,
          source_object_id = excluded.source_object_id, checked_at = now();
    return null;
  end if;

  v_gitems := v_golden.line_items;

  -- CORE (pass/fail) vs DEFINITIONAL (record-only) key sets by statement_type.
  v_core_keys := case v_stmt
    when 'income'   then array['revenue', 'net_income']
    when 'balance'  then array['total_assets', 'total_liabilities', 'equity']
    else array[]::text[]                       -- cashflow/oci/equity_change: no definition-stable core
  end;
  v_def_keys := case v_stmt
    when 'income'   then array['gross_profit', 'ebit']
    when 'balance'  then array['cash', 'total_debt']
    when 'cashflow' then array['cfo', 'cff', 'cfi', 'dep_amort']
    else array[]::text[]
  end;

  -- CORE loop — drives the verdict (sign flips / scope diffs on the stable primitives).
  foreach v_key in array v_core_keys loop
    if jsonb_typeof(v_gitems -> v_key) = 'number' and jsonb_typeof(v_sitems -> v_key) = 'number' then
      v_g := (v_gitems ->> v_key)::numeric;
      v_s := (v_sitems ->> v_key)::numeric;
      v_golden_prims := v_golden_prims || jsonb_build_object(v_key, v_g);
      v_source_prims := v_source_prims || jsonb_build_object(v_key, v_s);
      if abs(v_g) > 0 then
        v_n   := v_n + 1;
        v_rel := abs(v_g - v_s) / greatest(abs(v_g), abs(v_s));
        if v_rel > v_max_rel then v_max_rel := v_rel; end if;
        if v_rel > v_fin_tol then
          v_conflict   := true;
          v_mismatched := v_mismatched || jsonb_build_object('key', v_key, 'golden', v_g, 'source', v_s, 'rel_diff', round(v_rel, 6), 'note', 'core');
        end if;
      end if;
    end if;
  end loop;

  -- DEFINITIONAL loop — RECORD only (note='definitional'); NEVER sets v_conflict or v_max_rel.
  foreach v_key in array v_def_keys loop
    if jsonb_typeof(v_gitems -> v_key) = 'number' and jsonb_typeof(v_sitems -> v_key) = 'number' then
      v_g := (v_gitems ->> v_key)::numeric;
      v_s := (v_sitems ->> v_key)::numeric;
      if abs(v_g) > 0 then
        v_rel := abs(v_g - v_s) / greatest(abs(v_g), abs(v_s));
        if v_rel > v_fin_tol then
          v_mismatched := v_mismatched || jsonb_build_object('key', v_key, 'golden', v_g, 'source', v_s, 'rel_diff', round(v_rel, 6), 'note', 'definitional');
        end if;
      end if;
    end if;
  end loop;

  -- Per-share: audit only.
  foreach v_key in array v_ps_keys loop
    if jsonb_typeof(v_gitems -> v_key) = 'number' and jsonb_typeof(v_sitems -> v_key) = 'number' then
      v_g := (v_gitems ->> v_key)::numeric;
      v_s := (v_sitems ->> v_key)::numeric;
      v_mismatched := v_mismatched || jsonb_build_object('key', v_key, 'golden', v_g, 'source', v_s,
        'rel_diff', case when abs(v_g) > 0 then round(abs(v_g - v_s) / greatest(abs(v_g), abs(v_s)), 6) else null end, 'note', 'per_share');
    end if;
  end loop;

  if v_n = 0 then
    v_status := 'gap_source_only';   -- no comparable core key (cashflow-only, oci, equity_change)
  elsif v_conflict then
    v_status := 'conflict';
  else
    v_status := 'agree';
  end if;

  insert into public.financial_statement_xcheck
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end, currency,
     source, status, line_items, golden_object_id, max_rel_diff, mismatched, source_object_id, checked_at)
  values
    (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe, v_ccy,
     v_source, v_status, v_items, v_golden.source_object_id,
     case when v_n > 0 then v_max_rel else null end, v_mismatched, new.id, now())
  on conflict (security_id, statement_type, basis, fiscal_period, source) do update
    set period_kind      = excluded.period_kind, period_end = excluded.period_end,
        currency         = excluded.currency, status = excluded.status,
        line_items       = excluded.line_items, golden_object_id = excluded.golden_object_id,
        max_rel_diff     = excluded.max_rel_diff, mismatched = excluded.mismatched,
        source_object_id = excluded.source_object_id, checked_at = now();

  if v_status = 'conflict' then
    if not exists (select 1 from lake.object_conflicts where object_id = new.id and status = 'open') then
      insert into lake.object_conflicts (natural_key, object_id, candidates, policy)
      values (new.natural_key, new.id,
        jsonb_build_array(
          jsonb_build_object('source', 'filing',   'object_id', v_golden.source_object_id, 'values', v_golden_prims),
          jsonb_build_object('source', v_source,    'object_id', new.id,                    'values', v_source_prims, 'max_rel_diff', v_max_rel)),
        'primary_wins');
    end if;
  end if;

  return null;
end $function$;

-- Re-fire the reconcile over every existing FINANCIALS.XCHECK object so the verdicts re-classify
-- under v2 (touch updated_at → fires objects_financials_xcheck_reconcile_upd only; other object
-- types' triggers are WHEN-gated and don't run). Also resolve now-stale conflicts whose objects
-- re-classify to agree: the reconcile itself doesn't close object_conflicts, so drop the open
-- financials-xcheck conflicts first and let the re-fire re-raise only the v2 conflicts.
update lake.object_conflicts set status='resolved_primary', resolved_at=now(),
       resolution_note='reconcile v2 reclassification (definitional keys no longer conflict)'
 where status='open' and object_id in (select id from lake.objects where object_type='FINANCIALS.XCHECK');

update lake.objects set updated_at = now() where object_type = 'FINANCIALS.XCHECK';

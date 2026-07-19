-- 20260719091206_fn_financials_project_filing_ref_venue_fallback — v3.1: the v3
-- filing_source_ref lookup read `new.payload ->> 'venue'`, but the LIVE producer payload
-- shape (tadawul-researcher / tadawul-xbrl-replay) carries NO venue key — it relies on
-- the object's own columns — so v_fid never resolved and source_filing_id stayed NULL
-- (observed on the Phase B smoke replay: pres/keys landed, filing_linked=false).
-- Fix: coalesce onto new.venue_code for BOTH the security fallback and the filings
-- lookup. Function body otherwise identical to 20260718193005.

set search_path = '';

create or replace function lake.fn_financials_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_stmt   text    := new.payload ->> 'statement_type';
  v_kind   text    := new.payload ->> 'period_kind';
  v_fp     text    := new.payload ->> 'fiscal_period';
  v_pe     date    := nullif(new.payload ->> 'period_end', '')::date;
  v_ccy    char(3) := upper(left(coalesce(new.payload ->> 'currency', 'SAR'), 3));
  v_basis  text    := coalesce(nullif(new.payload ->> 'basis', ''), 'consolidated');
  v_items  jsonb   := new.payload -> 'line_items';
  v_seg    jsonb   := new.payload -> 'segments';
  v_pres   jsonb   := new.payload -> 'presentation';
  v_fid    bigint  := nullif(new.payload ->> 'source_filing_id', '')::bigint;
  v_venue  text    := coalesce(nullif(new.payload ->> 'venue', ''), new.venue_code);
  v_sid    bigint;
  v_cur    public.financial_statements%rowtype;
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;

  if v_stmt not in ('income', 'balance', 'cashflow', 'oci', 'equity_change') then
    raise warning 'fn_financials_project skip %: bad statement_type "%"', new.natural_key, coalesce(v_stmt, '<null>');
    return null;
  end if;
  if v_kind not in ('quarter', 'annual', 'ttm') then
    raise warning 'fn_financials_project skip %: bad period_kind "%"', new.natural_key, coalesce(v_kind, '<null>');
    return null;
  end if;
  if v_fp is null or v_pe is null then
    raise warning 'fn_financials_project skip %: missing fiscal_period/period_end', new.natural_key;
    return null;
  end if;
  if v_basis not in ('consolidated', 'standalone') then v_basis := 'consolidated'; end if;
  if v_items is null or jsonb_typeof(v_items) <> 'object' then
    raise warning 'fn_financials_project skip %: line_items not a jsonb object', new.natural_key;
    return null;
  end if;
  if v_pres is not null and jsonb_typeof(v_pres) <> 'array' then v_pres := null; end if;

  v_sid := new.security_id;
  if v_sid is null then
    select id into v_sid from public.securities
     where venue_code = v_venue and ticker = new.payload ->> 'ticker';
  end if;
  if v_sid is null then
    raise warning 'fn_financials_project skip %: unresolvable security (venue=%, ticker=%)',
      new.natural_key, v_venue, new.payload ->> 'ticker';
    return null;
  end if;

  if v_fid is null and (new.payload ? 'filing_source_ref') then
    select id into v_fid from public.filings
     where venue_code = v_venue
       and source_ref = new.payload ->> 'filing_source_ref';
  end if;

  select * into v_cur from public.financial_statements
   where security_id = v_sid and statement_type = v_stmt and basis = v_basis
     and fiscal_period = v_fp and is_estimate = false;

  if not found then
    insert into public.financial_statements
      (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
       currency, is_estimate, line_items, segments, presentation, source_filing_id,
       source_object_id, version, is_restated)
    values
      (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe,
       v_ccy, false, v_items, v_seg, v_pres, v_fid, new.id, 1, false);
    return null;
  end if;

  if v_cur.line_items is not distinct from v_items
     and v_cur.period_end is not distinct from v_pe
     and v_cur.currency  is not distinct from v_ccy then
    update public.financial_statements
       set period_kind      = v_kind,
           segments         = case when new.payload ? 'segments'      then v_seg  else segments     end,
           presentation     = case when new.payload ? 'presentation'  then v_pres else presentation end,
           source_filing_id = coalesce(v_fid, source_filing_id),
           source_object_id = new.id,
           updated_at       = now()
     where id = v_cur.id;
    return null;
  end if;

  insert into public.financial_statement_history
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
     currency, is_estimate, version, line_items, segments, presentation, source_filing_id,
     source_object_id, superseded_by_object_id)
  values
    (v_cur.security_id, v_cur.statement_type, v_cur.basis, v_cur.period_kind,
     v_cur.fiscal_period, v_cur.period_end, v_cur.currency, v_cur.is_estimate,
     v_cur.version, v_cur.line_items, v_cur.segments, v_cur.presentation, v_cur.source_filing_id,
     v_cur.source_object_id, new.id);

  update public.financial_statements
     set period_kind      = v_kind,
         period_end       = v_pe,
         currency         = v_ccy,
         line_items       = v_items,
         segments         = case when new.payload ? 'segments'      then v_seg  else segments     end,
         presentation     = case when new.payload ? 'presentation'  then v_pres else presentation end,
         source_filing_id = coalesce(v_fid, source_filing_id),
         source_object_id = new.id,
         version          = v_cur.version + 1,
         is_restated      = true,
         restated_at      = now(),
         updated_at       = now()
   where id = v_cur.id;

  return null;
end $$;

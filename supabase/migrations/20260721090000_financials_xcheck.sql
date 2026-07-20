-- 20260721090000_financials_xcheck — land a SECOND financials source (stockanalysis.com /
-- S&P Global Market Intelligence) as an ISOLATED cross-check tier that validates + flags
-- gaps against the golden public.financial_statements WITHOUT ever clobbering a
-- filing-sourced value.
--
-- ── WHY A SEPARATE OBJECT_TYPE + TABLE (the non-negotiable design constraint) ──────────
-- lake.fn_financials_project resolves its target financial_statements row PURELY from the
-- payload-derived accounting key (security_id, statement_type, basis, fiscal_period,
-- is_estimate=false) and IGNORES source_rank / natural_key / venue entirely. So a SECOND
-- FILING.FINANCIALS object on the same accounting key is treated as a RESTATEMENT: golden
-- is archived to public.financial_statement_history and OVERWRITTEN in place, version++.
-- Source-tagging the natural_key does NOT help — the projection never reads natural_key.
-- Golden already carries ~37% is_restated rows; a same-key second producer would ping-pong
-- golden<->aggregator forever. Therefore stockanalysis is landed under a DISTINCT
-- object_type 'FINANCIALS.XCHECK'. The golden projection trigger WHEN clause is an EXACT
-- match on 'FILING.FINANCIALS' and can never fire for 'FINANCIALS.XCHECK', so golden and
-- lake.fn_financials_project are left byte-for-byte untouched.
--
-- ── WHAT THIS MIGRATION LANDS (strictly additive) ─────────────────────────────────────
--   • public.financial_statement_xcheck — one reconciliation verdict per
--     (security, statement_type, basis, fiscal_period, source): agree / conflict /
--     gap_golden_missing / gap_source_only, with max_rel_diff + a mismatched[] audit array.
--   • lake.fn_financials_xcheck_reconcile() — AFTER INSERT/UPDATE trigger on lake.objects
--     for object_type='FINANCIALS.XCHECK'. Compares the aggregator numbers against golden
--     (canonical primitive keys only, FIN_TOL = 1%), upserts the verdict, and on a CONFLICT
--     raises the EXISTING Desk queue (lake.object_conflicts, policy='primary_wins' so the
--     filing wins by construction). NEVER writes public.financial_statements.
--   • public.v_financials_xcheck_conflicts — Desk read surface (conflict verdicts + ticker).
--   • public.securities.sa_symbol / sa_has_financials — symbol-alias columns for the
--     researcher that maps our ticker -> the stockanalysis path.
--
-- ── DELIBERATELY OUT OF SCOPE ─────────────────────────────────────────────────────────
-- Gap-enrichment INTO financial_statements is NOT implemented here. gap_golden_missing rows
-- are recorded candidates only; promoting them into golden is a post-assessment step the
-- lead runs after reviewing the agree/conflict/gap numbers.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. The isolated cross-check verdict table.
--    One current verdict per (security, statement_type, basis, fiscal_period, source).
--    Internal provenance/QA — RLS enabled explicitly (mirrors financial_statement_history);
--    the 0014 blanket enable-RLS loop only covered tables existing at that migration.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_statement_xcheck (
  id               bigint generated always as identity primary key,
  security_id      bigint not null references public.securities(id),
  statement_type   text,
  basis            text not null default 'consolidated',
  period_kind      text,
  fiscal_period    text,
  period_end       date,
  currency         char(3),
  source           text not null default 'stockanalysis',
  status           text not null
                     check (status in ('agree','conflict','gap_golden_missing','gap_source_only')),
  line_items       jsonb not null,                      -- the aggregator numbers, as landed
  golden_object_id uuid references lake.objects(id),     -- golden.source_object_id at check time
  max_rel_diff     numeric,                              -- max relative diff over compared primitives
  mismatched       jsonb,                                -- [{key,golden,source,rel_diff[,note]}]
  source_object_id uuid references lake.objects(id),     -- the FINANCIALS.XCHECK object
  checked_at       timestamptz not null default now(),
  unique (security_id, statement_type, basis, fiscal_period, source)
);

comment on table public.financial_statement_xcheck is
  'Isolated second-source (stockanalysis/S&P Global) reconciliation verdicts against golden public.financial_statements. Never mutates golden; conflicts surface via lake.object_conflicts. gap_golden_missing rows are enrichment candidates only.';
comment on column public.financial_statement_xcheck.status is
  'agree = all compared primitives within FIN_TOL (1%); conflict = a primitive exceeds FIN_TOL; gap_golden_missing = no golden row for this accounting key; gap_source_only = no comparable primitives shared with golden.';
comment on column public.financial_statement_xcheck.max_rel_diff is
  'Max abs(g-s)/greatest(abs(g),abs(s)) over the compared canonical primitives (per-share keys excluded).';
comment on column public.financial_statement_xcheck.mismatched is
  'Audit array: primitive keys exceeding FIN_TOL plus per-share keys (recorded with note=per_share, excluded from the pass/fail decision).';

create index if not exists fin_stmt_xcheck_status_idx   on public.financial_statement_xcheck (status);
create index if not exists fin_stmt_xcheck_security_idx on public.financial_statement_xcheck (security_id);

alter table public.financial_statement_xcheck enable row level security;
create policy worker_all on public.financial_statement_xcheck
  for all to marsad_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. The reconcile function. AFTER INSERT/UPDATE on lake.objects for
--    object_type='FINANCIALS.XCHECK'. Compares aggregator numbers vs golden, upserts a
--    verdict, and raises the existing Desk conflict queue on a material disagreement.
--    SECURITY DEFINER + search_path='' mirror lake.fn_financials_project exactly.
-- ---------------------------------------------------------------------------
create or replace function lake.fn_financials_xcheck_reconcile()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $function$
declare
  -- FIN_TOL: financials cross-source tolerance. 1% absorbs rounding / thousand-scale /
  -- definition drift between a filing and an aggregator; anything larger is a real conflict.
  v_fin_tol   constant numeric := 0.01;

  -- payload parse — snake_case, identical to lake.fn_financials_project.
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

  v_prim_keys    text[];
  v_ps_keys      text[] := array['eps_basic', 'eps_diluted', 'dps', 'book_value_ps'];
  v_key          text;
  v_g            numeric;
  v_s            numeric;
  v_rel          numeric;

  v_max_rel      numeric := 0;      -- max rel_diff over compared primitives
  v_n            integer := 0;      -- count of comparable primitives (shared, abs(golden)>0)
  v_conflict     boolean := false;
  v_mismatched   jsonb   := '[]'::jsonb;
  v_golden_prims jsonb   := '{}'::jsonb;
  v_source_prims jsonb   := '{}'::jsonb;
  v_status       text;
begin
  -- ── Guards (double-locked against ever touching the golden path) ────────────────────
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

  -- ── Resolve security (mirror golden: new.security_id else venue+ticker) ──────────────
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

  -- ── Fetch golden for this accounting key ────────────────────────────────────────────
  select * into v_golden from public.financial_statements
   where security_id = v_sid and statement_type = v_stmt and basis = v_basis
     and fiscal_period = v_fp and is_estimate is not true;

  if not found then
    -- No golden row: record an enrichment candidate. NEVER auto-insert into golden.
    insert into public.financial_statement_xcheck
      (security_id, statement_type, basis, period_kind, fiscal_period, period_end, currency,
       source, status, line_items, golden_object_id, max_rel_diff, mismatched, source_object_id, checked_at)
    values
      (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe, v_ccy,
       v_source, 'gap_golden_missing', v_items, null, null, null, new.id, now())
    on conflict (security_id, statement_type, basis, fiscal_period, source) do update
      set period_kind      = excluded.period_kind,
          period_end       = excluded.period_end,
          currency         = excluded.currency,
          status           = excluded.status,
          line_items       = excluded.line_items,
          golden_object_id = excluded.golden_object_id,
          max_rel_diff     = excluded.max_rel_diff,
          mismatched       = excluded.mismatched,
          source_object_id = excluded.source_object_id,
          checked_at       = now();
    return null;
  end if;

  v_gitems := v_golden.line_items;

  -- ── Canonical primitive keys to compare, by statement_type. oci/equity_change have no
  --    defined primitive set -> zero comparable -> gap_source_only. ─────────────────────
  v_prim_keys := case v_stmt
    when 'income'   then array['revenue', 'net_income', 'gross_profit', 'ebit']
    when 'balance'  then array['total_assets', 'total_liabilities', 'equity', 'cash', 'total_debt']
    when 'cashflow' then array['cfo', 'cff', 'cfi', 'dep_amort']
    else array[]::text[]
  end;

  -- ── Compare each shared primitive present as a JSON number in BOTH sides ─────────────
  foreach v_key in array v_prim_keys loop
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
          v_mismatched := v_mismatched || jsonb_build_object(
            'key', v_key, 'golden', v_g, 'source', v_s, 'rel_diff', round(v_rel, 6));
        end if;
      end if;
    end if;
  end loop;

  -- ── Per-share keys: recorded for the audit, EXCLUDED from the pass/fail decision ─────
  foreach v_key in array v_ps_keys loop
    if jsonb_typeof(v_gitems -> v_key) = 'number' and jsonb_typeof(v_sitems -> v_key) = 'number' then
      v_g := (v_gitems ->> v_key)::numeric;
      v_s := (v_sitems ->> v_key)::numeric;
      v_mismatched := v_mismatched || jsonb_build_object(
        'key', v_key, 'golden', v_g, 'source', v_s,
        'rel_diff', case when abs(v_g) > 0 then round(abs(v_g - v_s) / greatest(abs(v_g), abs(v_s)), 6) else null end,
        'note', 'per_share');
    end if;
  end loop;

  -- ── Verdict ─────────────────────────────────────────────────────────────────────────
  if v_n = 0 then
    v_status := 'gap_source_only';
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
    set period_kind      = excluded.period_kind,
        period_end       = excluded.period_end,
        currency         = excluded.currency,
        status           = excluded.status,
        line_items       = excluded.line_items,
        golden_object_id = excluded.golden_object_id,
        max_rel_diff     = excluded.max_rel_diff,
        mismatched       = excluded.mismatched,
        source_object_id = excluded.source_object_id,
        checked_at       = now();

  -- ── Surface material disagreements on the EXISTING Desk queue. policy='primary_wins'
  --    means the filing wins by construction — golden is NEVER mutated here. Idempotent:
  --    skip if an open conflict already exists for this object (mirrors raiseConflictRow).
  -- ---------------------------------------------------------------------------
  if v_status = 'conflict' then
    if not exists (
      select 1 from lake.object_conflicts where object_id = new.id and status = 'open'
    ) then
      insert into lake.object_conflicts (natural_key, object_id, candidates, policy)
      values (
        new.natural_key,
        new.id,
        jsonb_build_array(
          jsonb_build_object('source', 'filing',   'object_id', v_golden.source_object_id, 'values', v_golden_prims),
          jsonb_build_object('source', v_source,    'object_id', new.id,                    'values', v_source_prims, 'max_rel_diff', v_max_rel)
        ),
        'primary_wins'
      );
    end if;
  end if;

  return null;
end $function$;

comment on function lake.fn_financials_xcheck_reconcile() is
  'Reconciles a FINANCIALS.XCHECK lake.object (stockanalysis/S&P Global) against golden public.financial_statements: upserts a verdict into public.financial_statement_xcheck and raises lake.object_conflicts on a >FIN_TOL(1%) primitive disagreement. Strictly read-only against golden.';

-- ---------------------------------------------------------------------------
-- 3. Triggers — additive siblings of the golden objects_financials_project_ins/upd.
--    The WHEN clause exact-matches 'FINANCIALS.XCHECK' and can never match
--    'FILING.FINANCIALS', so the golden projection is untouched.
-- ---------------------------------------------------------------------------
drop trigger if exists objects_financials_xcheck_reconcile_ins on lake.objects;
create trigger objects_financials_xcheck_reconcile_ins
  after insert on lake.objects
  for each row when (new.object_type = 'FINANCIALS.XCHECK')
  execute function lake.fn_financials_xcheck_reconcile();

drop trigger if exists objects_financials_xcheck_reconcile_upd on lake.objects;
create trigger objects_financials_xcheck_reconcile_upd
  after update on lake.objects
  for each row when (new.object_type = 'FINANCIALS.XCHECK')
  execute function lake.fn_financials_xcheck_reconcile();

-- ---------------------------------------------------------------------------
-- 4. Desk read surface — conflict verdicts joined to the security, for the Desk queue.
--    lake.* / ops.* are not PostgREST-exposed, so the Desk reaches this via a public
--    view; grant matches the existing public.v_desk_* wrapper pattern (service_role only).
-- ---------------------------------------------------------------------------
create or replace view public.v_financials_xcheck_conflicts as
select
  x.id            as xcheck_id,
  x.security_id,
  s.ticker,
  s.name_en       as security_name,
  s.venue_code,
  x.statement_type,
  x.basis,
  x.period_kind,
  x.fiscal_period,
  x.period_end,
  x.currency,
  x.source,
  x.max_rel_diff,
  x.mismatched,
  x.golden_object_id,
  x.source_object_id,
  x.checked_at
from public.financial_statement_xcheck x
join public.securities s on s.id = x.security_id
where x.status = 'conflict'
order by x.max_rel_diff desc nulls last, x.checked_at desc;

-- Lock to service_role only: this view carries S&P-Global-sourced numbers (licensing-sensitive)
-- and internal conflict data — never expose to anon/authenticated (Desk reads via service role).
revoke all on public.v_financials_xcheck_conflicts from anon, authenticated;
grant select on public.v_financials_xcheck_conflicts to service_role;

-- ---------------------------------------------------------------------------
-- 5. Symbol-alias columns for the stockanalysis researcher (ticker -> SA path resolver).
-- ---------------------------------------------------------------------------
alter table public.securities
  add column if not exists sa_symbol        text,
  add column if not exists sa_has_financials boolean;

comment on column public.securities.sa_symbol is
  'stockanalysis.com path for this security (e.g. tadawul/1120, dfm/EMAAR, qse/QNBK). Seeded by the SA researcher from the venue->path map, with /api/search fallback for cross-listed drift.';
comment on column public.securities.sa_has_financials is
  'True once the SA financials tab for sa_symbol was confirmed to carry a financialData payload; false/null = 404 or secondary cross-listing (financials attach to the primary listing only).';

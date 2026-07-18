-- 20260718193005_statement_type_widen_presentation_projection_v3 — Phase A of the XBRL
-- datalake-enrichment plan: unblock the statement pipeline's silent-failure chokepoints
-- BEFORE the Phase B capture producers (oci / equity_change) arrive.
--
-- ── WHAT (4 changes, one contract) ─────────────────────────────────────────────────────
-- 1. WIDEN public.financial_statements.statement_type CHECK: + 'oci' (statement of other
--    comprehensive income) + 'equity_change' (statement of changes in equity). Purely
--    additive; matches the now-UNIFIED TS union (core/types.ts StatementType — previously
--    declared 3× and drift-prone).
-- 2. NEW COLUMN presentation (jsonb, both serving + history tables): the printed labels
--    in document order — `[{key, label, depth, is_subtotal}]` — captured at parse time
--    (free there, expensive to reconstruct later). A renderer/agent iterating
--    line_items key order produces structurally different tables per adapter; this
--    column is the faithful statement layout.
-- 3. PROJECTION v3 (lake.fn_financials_project):
--    a. Malformed FILING.FINANCIALS payloads now RAISE WARNING before skipping — the
--       prior silent `return null` left the object PENDING and healthy-looking with no
--       serving row and no signal (the "silent drop" chokepoint).
--    b. Change-detection SPLIT: content vs metadata. CONTENT (line_items/period_end/
--       currency) change ⇒ restatement: archive to history + version bump, as before.
--       METADATA (segments/presentation/period_kind/source_filing_id) change ⇒ quiet
--       in-place refresh, NO bump — re-staging identical statements with newly captured
--       presentation must not archive ~12k rows as fake restatements. This also fixes
--       the pre-v3 bugs where a segments-only or period_kind-only change was silently
--       DISCARDED (compared keys didn't include them).
--    c. segments/presentation are payload-key-gated writes (`payload ? 'segments'`):
--       a producer that omits the key preserves the stored value; a producer that
--       sends it (even null) writes it — fixes the write-once-sticky coalesce.
--    d. source_filing_id finally populated: payload `source_filing_id` (direct id) or
--       `filing_source_ref` (venue-scoped public.filings.source_ref lookup), both
--       optional — the financial_statements → filings link was permanently NULL.
-- 4. History table gains presentation for faithful archives.
--
-- Verified before authoring: live lake.fn_financials_project body == the 20260716120000
-- repo body (md5 83242d2aeeb1f8a4ea510dfdc0419fab) — no live drift; v3 diffs against the
-- latest applied body (the stamp-regression lesson).

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Widen the statement_type CHECK (additive).
-- ---------------------------------------------------------------------------
alter table public.financial_statements
  drop constraint financial_statements_statement_type_check;
alter table public.financial_statements
  add constraint financial_statements_statement_type_check
  check (statement_type in ('income', 'balance', 'cashflow', 'oci', 'equity_change'));

-- ---------------------------------------------------------------------------
-- 2. presentation column (serving + history). Ordered jsonb array:
--    [{"key": "...", "label": "...", "depth": 0, "is_subtotal": false}, ...]
-- ---------------------------------------------------------------------------
alter table public.financial_statements
  add column if not exists presentation jsonb;
alter table public.financial_statement_history
  add column if not exists presentation jsonb;

-- ---------------------------------------------------------------------------
-- 3. Projection v3.
-- ---------------------------------------------------------------------------
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
  v_sid    bigint;
  v_cur    public.financial_statements%rowtype;
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;

  -- Malformed-payload guards: WARN then skip (never a silent drop — a skipped object
  -- must be findable in the DB logs by its natural_key).
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
  -- presentation must be an array when present; a malformed one is dropped (not fatal).
  if v_pres is not null and jsonb_typeof(v_pres) <> 'array' then v_pres := null; end if;

  -- security_id: the live producer sets it on the object; a main-side producer carries
  -- venue+ticker in the payload. Prefer the object's, else resolve. Unknown ⇒ warn + skip
  -- (never mis-attribute).
  v_sid := new.security_id;
  if v_sid is null then
    select id into v_sid from public.securities
     where venue_code = new.payload ->> 'venue' and ticker = new.payload ->> 'ticker';
  end if;
  if v_sid is null then
    raise warning 'fn_financials_project skip %: unresolvable security (venue=%, ticker=%)',
      new.natural_key, new.payload ->> 'venue', new.payload ->> 'ticker';
    return null;
  end if;

  -- source_filing_id (both forms optional): direct id, else venue-scoped source_ref lookup.
  if v_fid is null and (new.payload ? 'filing_source_ref') then
    select id into v_fid from public.filings
     where venue_code = new.payload ->> 'venue'
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

  -- CONTENT unchanged (replay / PENDING→VERIFIED second fire / metadata-only re-stage)
  -- ⇒ quiet in-place refresh of the metadata, NO version bump, NO history archive.
  -- Restatement semantics belong to the NUMBERS, not the presentation layer.
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

  -- RESTATEMENT: archive the outgoing version (incl. its presentation), then overwrite
  -- the current row in place + bump.
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

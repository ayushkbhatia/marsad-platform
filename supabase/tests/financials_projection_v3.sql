-- Regression: lake.fn_financials_project v3 (migration 20260718193005).
--
-- Pins the Phase A contract:
--   1. 'oci' / 'equity_change' statement_types LAND (widened CHECK + guard).
--   2. A garbage statement_type is SKIPPED (no row) — and warns, not silently.
--   3. presentation jsonb is stored on insert.
--   4. METADATA-only re-stage (same line_items; new presentation/period_kind) ⇒
--      quiet in-place update: NO version bump, NO history archive.
--   5. CONTENT change (line_items differ) ⇒ restatement: version bump + history row
--      carrying the OUTGOING presentation.
--   6. source_filing_id resolves from payload filing_source_ref (venue-scoped).
--
-- Runs entirely inside a transaction against a synthetic TDWL ticker 'ZZT1' and
-- ROLLBACKs — zero trace, safe against the live DB. Assertions RAISE EXCEPTION on
-- failure; a clean run (only NOTICEs/WARNINGs) is a pass.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/financials_projection_v3.sql
--   or  Supabase MCP execute_sql with this whole file as one call.

begin;

do $$
declare
  v_sid   bigint;
  v_fid   bigint;
  v_agent uuid;
  v_pr    bigint;
  v_row   public.financial_statements%rowtype;
  v_n     int;
begin
  insert into public.securities (venue_code, ticker, name_en, currency, status, sector)
  values ('TDWL', 'ZZT1', 'Phase A Projection Test', 'SAR', 'listed', 'unknown')
  returning id into v_sid;

  insert into public.filings (venue_code, source_ref, filing_type, title, filed_at)
  values ('TDWL', 'ZZT1-FIL-1', 'RESULTS', 'Phase A test filing', now())
  returning id into v_fid;

  -- lake.objects requires a parse_run lineage row; synthesize one under any agent principal.
  select principal_id into v_agent from iam.agent_accounts limit 1;
  insert into lake.parse_runs (agent_id, parser_key, parser_version)
  values (v_agent, 'test:financials_projection_v3', 1)
  returning id into v_pr;

  -- ── 1+3+6: an 'oci' object with presentation + filing_source_ref lands fully. ──
  insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, state, parse_run_id)
  values ('FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:ZZT1:oci:consolidated:Q1 2026', v_sid, 'TDWL',
          jsonb_build_object(
            'venue', 'TDWL', 'ticker', 'ZZT1',
            'statement_type', 'oci', 'basis', 'consolidated',
            'period_kind', 'quarter', 'fiscal_period', 'Q1 2026', 'period_end', '2026-03-31',
            'currency', 'SAR',
            'line_items', jsonb_build_object('total_comprehensive_income', 6250067),
            'presentation', jsonb_build_array(
              jsonb_build_object('key', 'profit_loss', 'label', 'Profit (loss)', 'depth', 0, 'is_subtotal', false),
              jsonb_build_object('key', 'total_comprehensive_income', 'label', 'Total comprehensive income', 'depth', 0, 'is_subtotal', true)),
            'filing_source_ref', 'ZZT1-FIL-1'),
          'PENDING', v_pr);

  select * into v_row from public.financial_statements
   where security_id = v_sid and statement_type = 'oci' and fiscal_period = 'Q1 2026';
  if not found then raise exception 'FAIL(1): oci statement did not land'; end if;
  if v_row.version <> 1 then raise exception 'FAIL(1): oci landed at version %', v_row.version; end if;
  if v_row.presentation is null or jsonb_array_length(v_row.presentation) <> 2 then
    raise exception 'FAIL(3): presentation not stored (got %)', v_row.presentation;
  end if;
  if v_row.source_filing_id is distinct from v_fid then
    raise exception 'FAIL(6): source_filing_id % <> filing %', v_row.source_filing_id, v_fid;
  end if;

  -- ── 1b: equity_change lands too. ──
  insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, state, parse_run_id)
  values ('FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:ZZT1:equity_change:consolidated:Q1 2026', v_sid, 'TDWL',
          jsonb_build_object(
            'venue', 'TDWL', 'ticker', 'ZZT1',
            'statement_type', 'equity_change', 'basis', 'consolidated',
            'period_kind', 'quarter', 'fiscal_period', 'Q1 2026', 'period_end', '2026-03-31',
            'currency', 'SAR',
            'line_items', jsonb_build_object('dividends_and_others', -540138)),
          'PENDING', v_pr);
  select count(*) into v_n from public.financial_statements
   where security_id = v_sid and statement_type = 'equity_change';
  if v_n <> 1 then raise exception 'FAIL(1b): equity_change did not land'; end if;

  -- ── 2: a garbage statement_type is skipped (warns; no row; no exception). ──
  insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, state, parse_run_id)
  values ('FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:ZZT1:garbage:consolidated:Q1 2026', v_sid, 'TDWL',
          jsonb_build_object(
            'venue', 'TDWL', 'ticker', 'ZZT1',
            'statement_type', 'garbage', 'basis', 'consolidated',
            'period_kind', 'quarter', 'fiscal_period', 'Q1 2026', 'period_end', '2026-03-31',
            'currency', 'SAR', 'line_items', jsonb_build_object('x', 1)),
          'PENDING', v_pr);
  select count(*) into v_n from public.financial_statements
   where security_id = v_sid and statement_type = 'garbage';
  if v_n <> 0 then raise exception 'FAIL(2): garbage statement_type landed'; end if;

  -- ── 4: metadata-only re-stage (same line_items, NEW presentation) ⇒
  --       in-place update, version still 1, history empty. ──
  insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, state, parse_run_id)
  values ('FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:ZZT1:oci:consolidated:Q1 2026:v2meta', v_sid, 'TDWL',
          jsonb_build_object(
            'venue', 'TDWL', 'ticker', 'ZZT1',
            'statement_type', 'oci', 'basis', 'consolidated',
            'period_kind', 'quarter', 'fiscal_period', 'Q1 2026', 'period_end', '2026-03-31',
            'currency', 'SAR',
            'line_items', jsonb_build_object('total_comprehensive_income', 6250067),
            'presentation', jsonb_build_array(
              jsonb_build_object('key', 'total_comprehensive_income', 'label', 'Total comprehensive income', 'depth', 0, 'is_subtotal', true))),
          'PENDING', v_pr);
  select * into v_row from public.financial_statements
   where security_id = v_sid and statement_type = 'oci' and fiscal_period = 'Q1 2026';
  if v_row.version <> 1 then
    raise exception 'FAIL(4): metadata-only re-stage bumped version to %', v_row.version;
  end if;
  if jsonb_array_length(v_row.presentation) <> 1 then
    raise exception 'FAIL(4): presentation not refreshed in place (len %)', jsonb_array_length(v_row.presentation);
  end if;
  select count(*) into v_n from public.financial_statement_history where security_id = v_sid;
  if v_n <> 0 then raise exception 'FAIL(4): metadata-only re-stage wrote % history rows', v_n; end if;

  -- ── 5: content change ⇒ restatement: version 2 + history row w/ outgoing presentation. ──
  insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, state, parse_run_id)
  values ('FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:ZZT1:oci:consolidated:Q1 2026:v3content', v_sid, 'TDWL',
          jsonb_build_object(
            'venue', 'TDWL', 'ticker', 'ZZT1',
            'statement_type', 'oci', 'basis', 'consolidated',
            'period_kind', 'quarter', 'fiscal_period', 'Q1 2026', 'period_end', '2026-03-31',
            'currency', 'SAR',
            'line_items', jsonb_build_object('total_comprehensive_income', 9999999)),
          'PENDING', v_pr);
  select * into v_row from public.financial_statements
   where security_id = v_sid and statement_type = 'oci' and fiscal_period = 'Q1 2026';
  if v_row.version <> 2 or v_row.is_restated is not true then
    raise exception 'FAIL(5): content change did not restate (version %, is_restated %)', v_row.version, v_row.is_restated;
  end if;
  select count(*) into v_n from public.financial_statement_history
   where security_id = v_sid and statement_type = 'oci' and version = 1
     and jsonb_array_length(presentation) = 1;
  if v_n <> 1 then raise exception 'FAIL(5): history row missing or lost outgoing presentation'; end if;

  raise notice 'financials_projection_v3: ALL 6 CASES PASS';
end $$;

rollback;

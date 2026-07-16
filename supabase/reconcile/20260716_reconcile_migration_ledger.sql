-- 20260716_reconcile_migration_ledger — ONE-TIME LIVE-ONLY LEDGER RECONCILIATION.
--
-- ⚠️ THIS IS NOT A SCHEMA MIGRATION. It does not live in supabase/migrations/ and MUST NOT be
--    replayed by `supabase db reset`. It operates on the migration LEDGER itself
--    (supabase_migrations.schema_migrations) and was applied to live via the Supabase MCP
--    `execute_sql` tool (NOT `apply_migration`, which would insert a fresh ledger row and create
--    MORE drift). Kept in-repo purely as the committed audit record of the metadata fix.
--
-- ── WHAT DRIFTED ───────────────────────────────────────────────────────────────────────────────
-- 2026-07-15/16 work was applied to live over MCP `apply_migration`, which auto-generates the
-- ledger `version` from the wall-clock at apply time and stores the committed FILENAME as `name`.
-- So 13 committed migrations ran on live under a DIFFERENT version string than their filename
-- (the classic MCP-apply-vs-committed-.sql trap; PR #22 fixed it once, this reconciles the recurrence).
-- The features are live and correct — this is bookkeeping drift, not missing DDL.
--
-- Equivalence was PROVEN before re-stamping: schema_migrations.statements[1] stores the exact SQL
-- that ran on live; a comment-stripped + whitespace-collapsed md5 of each committed file matched
-- its live row. 11/13 matched byte-for-byte; 2 (bhb_securities_seed, bhb_quotes_webapi_board)
-- differ ONLY by a trailing read-only `select` echo the live apply carried; the reconcile fn/DDL
-- is identical. (The financials pair is handled separately — see below.)
--
-- ── ACTION (metadata only; no DDL against app schema/data) ──────────────────────────────────────
--  (A) Re-stamp 13 live rows: version → committed filename version, name → filename suffix.
--  (B) Stamp 20260716095100 as applied (superseded): it was folded into 20260716120000 BEFORE it
--      ever ran on live, so live reached its end-state without executing it. Marking it applied
--      (no DDL) makes live's version set == the repo's filename set. Its .sql stays committed.
--  The out-of-band live-only 20260714183239 (financials_project) had NO committed .sql; it is
--  reconstructed from live as supabase/migrations/20260714183239_financials_project.sql (it also
--  owns public.filings.pdf_storage_key, which no other repo migration created — a real from-scratch
--  gap this closes). No ledger op needed for it: its version already matches its (new) filename.
--
-- OUT OF SCOPE: live version 20260716121312 (fix_heartbeat_sentinel_session_source_aware) was being
-- applied out-of-band by a CONCURRENT session while this ran. It is fresh drift owned by that effort;
-- its owning session must commit `20260716121312_*.sql` + add the ledger row. Untouched here.
--
-- Atomic + self-verifying: one DO block; the guard RAISEs (aborting the whole block) unless the
-- end state is exactly the 14 target versions present and the 13 source versions gone.

do $reconcile$
begin
  -- (A) 13 re-stamps: live auto-version  →  committed filename version (+ normalized name)
  update supabase_migrations.schema_migrations set version='20260715093000', name='retire_yahoo_quote_twins'             where version='20260715094058';
  update supabase_migrations.schema_migrations set version='20260715101000', name='bhb_securities_seed'                  where version='20260715105439';
  update supabase_migrations.schema_migrations set version='20260715100000', name='bhb_quotes_webapi_board'              where version='20260715112439';
  update supabase_migrations.schema_migrations set version='20260715190000', name='storage_purge_cron'                  where version='20260715155908';
  update supabase_migrations.schema_migrations set version='20260716090000', name='filing_detail_chain'                 where version='20260715213741';
  update supabase_migrations.schema_migrations set version='20260716090500', name='filing_detail_sources'               where version='20260715213759';
  update supabase_migrations.schema_migrations set version='20260716091000', name='bhb_filings_drop_action_discovery'   where version='20260715213809';
  update supabase_migrations.schema_migrations set version='20260716093000', name='reactivate_bhb_filings'              where version='20260715221246';
  update supabase_migrations.schema_migrations set version='20260716094000', name='seen_items_nopdf_state'              where version='20260715222320';
  update supabase_migrations.schema_migrations set version='20260716094500', name='bhb_filing_detail_list_only'         where version='20260715222551';
  update supabase_migrations.schema_migrations set version='20260716095000', name='deactivate_dfm_filing_detail'        where version='20260715223612';
  update supabase_migrations.schema_migrations set version='20260716100000', name='fleet_productivity_guard'            where version='20260716060948';
  update supabase_migrations.schema_migrations set version='20260716120000', name='reconcile_financials_projection_versioning' where version='20260716114433';

  -- (B) stamp 20260716095100 as applied-superseded (metadata only, no DDL)
  insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
  values (
    '20260716095100',
    'financial_statements_persist_versioning',
    array['-- STAMPED AS APPLIED (superseded), not executed on live. The camelCase versioning '
       || 'projection in this migration was folded into 20260716120000, which drops its objects and '
       || 'creates the converged snake_case lake.fn_financials_project. Live ran 20260714183239 then '
       || '20260716120000 and reached the 095100 end-state without executing it. Stamped 2026-07-16 '
       || 'during the migration-ledger reconciliation so repo filenames match live schema_migrations '
       || 'versions. See supabase/reconcile/20260716_reconcile_migration_ledger.sql.'],
    'ayushkbhatia@gmail.com'
  );

  -- guard: end state must be exactly the 14 targets present, 0 sources remaining
  if (select count(*) from (values
        ('20260715093000'),('20260715101000'),('20260715100000'),('20260715190000'),
        ('20260716090000'),('20260716090500'),('20260716091000'),('20260716093000'),
        ('20260716094000'),('20260716094500'),('20260716095000'),('20260716100000'),
        ('20260716120000'),('20260716095100')) t(v)
      join supabase_migrations.schema_migrations m on m.version = t.v) <> 14
   or (select count(*) from (values
        ('20260715094058'),('20260715105439'),('20260715112439'),('20260715155908'),
        ('20260715213741'),('20260715213759'),('20260715213809'),('20260715221246'),
        ('20260715222320'),('20260715222551'),('20260715223612'),('20260716060948'),
        ('20260716114433')) s(v)
      join supabase_migrations.schema_migrations m on m.version = s.v) <> 0
  then
    raise exception 'migration-ledger reconcile guard failed — aborting (no rows changed)';
  end if;
end
$reconcile$;

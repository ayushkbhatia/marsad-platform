-- 20260720_reconcile_migration_ledger — ONE-TIME LIVE-ONLY LEDGER RECONCILIATION.
--
-- ⚠️ THIS IS NOT A SCHEMA MIGRATION. It does not live in supabase/migrations/ and MUST NOT be
--    replayed by `supabase db reset`. It operates on the migration LEDGER itself
--    (supabase_migrations.schema_migrations) and was applied to live via the Supabase MCP
--    `execute_sql` tool (NOT `apply_migration`). Kept in-repo purely as the committed audit record.
--
-- ── WHAT DRIFTED ───────────────────────────────────────────────────────────────────────────────
-- Three 2026-07-19/20 migrations were applied to live over MCP `apply_migration`, which auto-stamps
-- the ledger `version` from wall-clock at apply time — so the live `version` differed from the
-- committed FILENAME version (the recurring MCP-apply-vs-committed-.sql trap). The repo-only ledger
-- guard (scripts/check-migration-ledger.mjs, migrations/*.sql vs migrations.ledger) cannot see this
-- (it is repo-only, 99==99), so a from-scratch replay / restore / PITR would diverge. Features are
-- live and correct — bookkeeping drift, not missing DDL.
--
--   live version      -> committed filename version   (name)
--   20260719105921    -> 20260719160000               lake_landing_visibility_views
--   20260719115932    -> 20260719170000               lake_landing_public_wrappers
--   20260720134005    -> 20260720140000               adx_eod_deactivate_unpinned_route
--                          (name also corrected: the live row carried the full stem incl. version)
--
-- ── ACTION (metadata only; no DDL against app schema/data) ──────────────────────────────────────
update supabase_migrations.schema_migrations set version='20260719160000'
  where version='20260719105921' and name='lake_landing_visibility_views';
update supabase_migrations.schema_migrations set version='20260719170000'
  where version='20260719115932' and name='lake_landing_public_wrappers';
update supabase_migrations.schema_migrations set version='20260720140000', name='adx_eod_deactivate_unpinned_route'
  where version='20260720134005';
-- Applied to live 2026-07-20; verified: live version set == repo filename set for all three.

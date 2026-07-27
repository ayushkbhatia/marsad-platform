-- 20260727_reconcile_migration_ledger — ONE-TIME LIVE-ONLY LEDGER RECONCILIATION.
--
-- ⚠️ THIS IS NOT A SCHEMA MIGRATION. It does not live in supabase/migrations/ and MUST NOT be
--    replayed by `supabase db reset`. It operates on the migration LEDGER itself
--    (supabase_migrations.schema_migrations) and was applied to live via the Supabase MCP
--    `execute_sql` tool (NOT `apply_migration`, which would insert a fresh ledger row and create
--    MORE drift). Kept in-repo purely as the committed audit record of the metadata fix.
--
-- ── WHAT DRIFTED ───────────────────────────────────────────────────────────────────────────────
-- The two PE.0 migrations were applied to live over MCP `apply_migration`, which auto-generates the
-- ledger `version` from the wall-clock at apply time and stores the committed FILENAME as `name`.
-- Same trap as 2026-07-16 and 2026-07-20; caught immediately this time by running
-- `node scripts/check-migration-ledger.mjs` before committing.
--
--   committed filename version   →   live version as applied
--   20260727113000_filing_extract_enqueue_gap          ←  20260727082624
--   20260727114500_filing_extract_sha_index_nonpartial ←  20260727082814
--
-- The DDL is live and correct — this is bookkeeping drift, not missing DDL. Equivalence needs no
-- proof here beyond identity: these rows were created BY the apply of these exact files minutes
-- before this reconcile ran, in the same session, with no intervening edit.
--
-- Replay-order note: the re-stamped versions (113000/114500) sort AFTER 20260727090000
-- (marsad_desk_principal), whereas the auto-generated ones (082624/082814) sorted before it. A
-- from-scratch replay is unaffected either way — these migrations touch only
-- ops.filing_extract_queue and public.filings, both of which long predate marsad_desk_principal,
-- and neither references it.
--
-- ── ACTION (metadata only; no DDL against app schema/data) ─────────────────────────────────────
update supabase_migrations.schema_migrations
   set version = '20260727113000'
 where version = '20260727082624'
   and name    = 'filing_extract_enqueue_gap';

update supabase_migrations.schema_migrations
   set version = '20260727114500'
 where version = '20260727082814'
   and name    = 'filing_extract_sha_index_nonpartial';

-- ── VERIFY ─────────────────────────────────────────────────────────────────────────────────────
-- select version, name from supabase_migrations.schema_migrations
--  where name like 'filing_extract%' order by version;
-- expect exactly: 20260727113000 | filing_extract_enqueue_gap
--                 20260727114500 | filing_extract_sha_index_nonpartial

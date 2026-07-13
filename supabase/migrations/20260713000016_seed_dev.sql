-- 0016_seed_dev — placeholder for 02 §22 step 16.
--
-- The SUN 12 JUL 2026 09:41 GST design fixture (stc DPS 0.50→0.55 revision
-- chain, MSX incident, sample venues/securities/quotes/filings/objects) lives
-- in supabase/seed.sql, NOT in this migration. Rationale: 02 §22 requires the
-- fixture to be "dev/staging only — never applied to prod", and the Supabase
-- CLI's seed mechanism is exactly that boundary — seed.sql runs on
-- `supabase db reset` (local/branch databases) and is never executed by
-- `supabase db push` against production. Keeping the fixture out of the
-- migration chain makes the prod/dev split structural instead of procedural.
--
-- This file is retained so the migration sequence stays 0001–0016 as numbered
-- in docs/architecture/02-data-lake.md §22.
do $$
begin
  raise notice 'dev fixture is applied from supabase/seed.sql (supabase db reset), never on prod';
end $$;

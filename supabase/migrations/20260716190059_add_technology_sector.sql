-- 20260716190059_add_technology_sector — add the 12th real sector cohort 'technology' (07 §3.3/§3.5)
-- and re-project the Tadawul IT filers that were force-fit to 'unknown' before the key existed.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
-- The §3.3 taxonomy mapper (ingestion/src/lake/sector-taxonomy.ts) had no 'technology' key, so IT
-- venue strings that matched no other rule fell to the LOGGED 'unknown' fallback. On TDWL that is 6
-- filers: 7200/7201/7202/7203/7211 ("Information Technology | IT Services / Software") and 9524
-- ("Information Technology | Electronic Equipment, Instruments and Components"). Owner call (§3.5
-- cohort set, 2026-07-16): a DISTINCT 'technology' cohort — NOT folded into 'industrials'. Cohort
-- starts thin (<8 GCC names) so the Score engine flags `thin_cohort=true` until more IT names land;
-- that is the accepted trade for a clean tech peer set.
--
-- securities.sector is a FOREIGN KEY to public.sectors(key); adding the row here is the prerequisite
-- for the taxonomy mapper (and the projection FK guard) to accept the new key.
--
-- ── SAFE/IDEMPOTENT ─────────────────────────────────────────────────────────────────────────────
-- (1) sector insert is on-conflict-do-nothing. (2) The re-map patches the LIVE PROFILE.SECURITY object
-- payloads currently sector='unknown' whose preserved rawSector the NEW rule now classifies as
-- technology; the jsonb_set UPDATE re-fires lake.fn_security_profile_project (objects_..._upd trigger),
-- which — because the new sector is DISTINCT from the stored 'unknown' — writes securities.sector=
-- 'technology' (the projection's idempotency guard only short-circuits an unchanged re-fire). A re-run
-- matches 0 rows (payload sector is no longer 'unknown'). If the profile producer has not run on this
-- DB yet, the UPDATE simply matches 0 rows and future parses map correctly at the source.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. The new cohort key. sort_order 115 sits it just after industrials (110).
-- ---------------------------------------------------------------------------
insert into public.sectors (key, name, sort_order) values
  ('technology', 'Technology', 115)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Re-project the mis-classified IT filers: re-map any live PROFILE.SECURITY object still stamped
--    sector='unknown' whose rawSector the new §3.3 rule recognizes as technology. Patching the payload
--    re-fires the projection trigger, which lands securities.sector='technology'. Scoped to the
--    'unknown' bucket so a correctly-mapped row is never disturbed; \y guards 'it services' against
--    substring hits like "credit services".
-- ---------------------------------------------------------------------------
do $$
declare
  v_n integer;
begin
  update lake.objects
     set payload = jsonb_set(payload, '{sector}', '"technology"'::jsonb)
   where object_type = 'PROFILE.SECURITY'
     and superseded_by is null
     and state in ('PENDING', 'VERIFIED')
     and payload ->> 'sector' = 'unknown'
     and payload ->> 'rawSector' ~* '(technolog|software|semiconductor|electronic equipment|hardware|\yit services)';
  get diagnostics v_n = row_count;
  raise notice 'add_technology_sector: re-mapped % PROFILE.SECURITY object(s) unknown -> technology', v_n;
end $$;

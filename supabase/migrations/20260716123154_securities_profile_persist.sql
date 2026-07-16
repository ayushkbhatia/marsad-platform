-- 20260716123154_securities_profile_persist — the SOURCE-AGNOSTIC persist half of DEF-SECTOR-DATA
-- (07 §3.3/§3.5, §P1.7e-I): project PROFILE.SECURITY lake.objects into public.securities' identity
-- columns (sector / isin / shares_outstanding) + stamp a per-security coverage flag.
--
-- ── THE GAP THIS CLOSES (the current bottleneck) ───────────────────────────────────────────────
-- 7,210 FILING.FINANCIALS statements have landed, but public.key_ratios.pe is non-null for only
-- 24/553 rows and public.scores has only 20 rows. Root cause: securities.sector = 'unknown' for all
-- 693 rows, securities.shares_outstanding is NULL for all 693, and securities.isin is empty. The
-- ratio engine computes pe = last / eps_ttm where eps_ttm = explicit eps_diluted (trailing-4Q) ??
-- net_income_ttm / shares_outstanding (ingestion/src/lake/ratios-compute.ts:175,191); pb / market_cap
-- / ps ALL need shares_outstanding; and the §3.3 sector→valid-ratio map + the §3.5 GCC-wide Score
-- cohorts have no real sector to key on (every name collapses to one 'unknown' cohort). So a profile
-- scrape that fills these three columns is the binding constraint on live PE/PB + the Marsad Score.
--
-- ── SOURCE-AGNOSTIC BY DESIGN (mirrors lake.fn_financial_statement_project, 20260716095100) ─────
-- Whatever produces the PROFILE.SECURITY staging rows — the Mubasher /profile page, the ADX native
-- overview.json (cookie-seated browser context), MSX companies.aspx, or the free deterministic
-- Tadawul XBRL feed's own entity metadata (dei:EntityCommonStockSharesOutstanding / sector / ISIN —
-- the owner-preferred, Mubasher-free path) — flows the SAME camelCase object payload contract:
--   { venue, ticker, sector, rawSector, isin, sharesOutstanding, industry? }
-- where `sector` is ALREADY mapped onto the internal taxonomy (ingestion/src/lake/sector-taxonomy.ts,
-- the §3.3 map's vocabulary) and `rawSector` preserves the venue's original string for audit (an
-- unmappable venue string lands as sector='Unclassified' — a LOGGED fallback, never silently
-- 'unknown'; the raw string is queryable on the object payload). This migration owns NONE of those
-- producers; it owns the persist contract they target. On main today there is NO active
-- `securities_profile` source, so the trigger simply never fires until a producer is seeded active —
-- this migration is INERT against the live pipeline (no behaviour change), exactly the clean seam a
-- producer plugs into. The runtime staging mapper (runtime.mapProfile → PROFILE.SECURITY) +
-- data_type routing ship in the same change so staging → cross_check → objects → projection is
-- complete end to end.
--
-- ── SINGLE-SOURCE BY NATURE (no 2-source cross-check gate) ──────────────────────────────────────
-- A security's identity (sector/isin/shares) has ONE authoritative source per venue (Mubasher for
-- TDWL, ADX-native for ADX, …) — there is no independent second exchange to corroborate it, so like
-- FILING.FINANCIALS / FILING.REF the object lands PENDING (single-source) and STILL projects. It is
-- NOT price-sensitive (identity data, no 33b human-confirm gate). The minutely ops.enqueue_crosscheck
-- _sweep picks up the single-source PROFILE.SECURITY key, cross_check inserts the PENDING object, and
-- the trigger below lands it into public.securities.
--
-- ── COVERAGE FLAG (graceful one-shot stop) ─────────────────────────────────────────────────────
-- securities.profile_scraped_at is stamped the moment a security's profile lands (this projection),
-- mirroring ohlcv_backfilled_at (migration 0041). The runtime coverage guard (withProfileSymbols)
-- injects only securities WHERE profile_scraped_at IS NULL, chunked, so re-runs fetch only the
-- missing names and the task goes DORMANT (coverage-complete skip) once every listed security is
-- stamped — the daily schedule keeps heart-beating but does no work.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Coverage stamp on the securities master (additive, forward-only). NULL = not yet profiled.
-- ---------------------------------------------------------------------------
alter table public.securities
  add column if not exists profile_scraped_at timestamptz;

comment on column public.securities.profile_scraped_at is
  'Set by lake.fn_security_profile_project when a PROFILE.SECURITY object lands this security''s '
  'sector/isin/shares_outstanding. NULL = not yet profiled; the runtime coverage guard '
  '(withProfileSymbols) injects only NULL rows, chunked, so the one-shot profile scrape idles when '
  'every listed security is stamped. Mirrors ohlcv_backfilled_at (0041).';

-- ---------------------------------------------------------------------------
-- 2. The projection: PROFILE.SECURITY lake.object → public.securities identity columns.
--    Mirrors lake.fn_filing_project (0037) / lake.fn_financial_statement_project (20260716095100):
--    a trigger on lake.objects that lands the VERIFIED/PENDING object into the reader's serving row.
--    SECURITY DEFINER (bypasses RLS to write public.securities) with an empty search_path.
--
--    NEVER wipes an existing value with a NULL (coalesce(payload, existing)) — a profile source that
--    omits, say, ISIN must not clear a previously-scraped one. sector is NOT NULL: the taxonomy mapper
--    always yields a non-empty value ('Unclassified' at worst), so a non-empty payload sector is
--    written; a blank/absent sector keeps the existing value. profile_scraped_at is always stamped so
--    the coverage guard idles the security (the whole point of the one-shot flag).
-- ---------------------------------------------------------------------------
create or replace function lake.fn_security_profile_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_venue    text    := coalesce(new.venue_code, new.payload ->> 'venue');
  v_ticker   text    := new.payload ->> 'ticker';
  v_sector   text    := nullif(new.payload ->> 'sector', '');
  v_industry text    := nullif(new.payload ->> 'industry', '');
  v_isin     text    := nullif(new.payload ->> 'isin', '');
  v_shares   numeric := nullif(new.payload ->> 'sharesOutstanding', '')::numeric;
  v_sid      bigint;
  v_cur      public.securities%rowtype;
  v_new_sector text;
  v_new_isin   text;
  v_new_shares numeric;
  v_new_ind    text;
begin
  if new.object_type <> 'PROFILE.SECURITY' then return null; end if;
  -- Only a live object projects; a superseded/retired revision must not re-write the row.
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;

  if v_venue is null or v_ticker is null then return null; end if;

  -- Resolve security_id from venue+ticker in the payload (venue_code+ticker is unique). Unknown
  -- security ⇒ skip (never mis-attribute onto the wrong company).
  select * into v_cur
    from public.securities
   where venue_code = v_venue and ticker = v_ticker;
  if not found then return null; end if;
  v_sid := v_cur.id;

  -- Defensive FK guard: public.securities.sector is a FOREIGN KEY to public.sectors(key). A producer
  -- that emits an unknown key must NOT error the whole cross_check tx (which would stall the pipeline)
  -- — ignore an invalid sector and keep the existing value. The taxonomy mapper
  -- (ingestion/src/lake/sector-taxonomy.ts) already only emits valid keys; this is belt-and-suspenders
  -- so a future/other producer can never wedge the projection on a bad sector.
  if v_sector is not null and not exists (select 1 from public.sectors where key = v_sector) then
    v_sector := null;
  end if;

  -- Desired values: overwrite from payload where present; keep existing on a NULL/blank/invalid payload
  -- field (never clear a previously-scraped identity). sector is a FK-constrained NOT NULL — write only
  -- a non-empty VALID payload sector, else keep the current value.
  v_new_sector := coalesce(v_sector, v_cur.sector);
  v_new_isin   := coalesce(v_isin,   v_cur.isin);
  v_new_shares := coalesce(v_shares, v_cur.shares_outstanding);
  v_new_ind    := coalesce(v_industry, v_cur.industry);

  -- Idempotent: a re-projection with identical identity AND an already-stamped coverage flag is a
  -- NO-OP (a replay, or the PENDING→VERIFIED second trigger fire for the SAME object) — do not
  -- re-write the row nor re-stamp. First land (profile_scraped_at IS NULL) always writes + stamps.
  if v_cur.profile_scraped_at is not null
     and v_new_sector is not distinct from v_cur.sector
     and v_new_isin   is not distinct from v_cur.isin
     and v_new_shares is not distinct from v_cur.shares_outstanding
     and v_new_ind    is not distinct from v_cur.industry then
    return null;
  end if;

  update public.securities
     set sector             = v_new_sector,
         isin               = v_new_isin,
         shares_outstanding = v_new_shares,
         industry           = v_new_ind,
         profile_scraped_at = now(),
         updated_at         = now()
   where id = v_sid;

  return null;
end $$;

-- Fire on BOTH insert (single-source PENDING land) and update (PENDING→VERIFIED promotion, or a
-- superseding revision) — identical to the FILING.REF / FILING.FINANCIALS projection triggers. The
-- idempotency guard above makes the INSERT-then-UPDATE double-fire for the same object a safe no-op.
drop trigger if exists objects_security_profile_project_ins on lake.objects;
create trigger objects_security_profile_project_ins after insert on lake.objects
  for each row when (new.object_type = 'PROFILE.SECURITY')
  execute function lake.fn_security_profile_project();

drop trigger if exists objects_security_profile_project_upd on lake.objects;
create trigger objects_security_profile_project_upd after update on lake.objects
  for each row when (new.object_type = 'PROFILE.SECURITY')
  execute function lake.fn_security_profile_project();

-- NB: no one-time backfill loop — there are ZERO PROFILE.SECURITY objects on main today, and the
-- projection logic lives in the trigger, so every future object (the first included) is projected
-- correctly by the trigger itself.

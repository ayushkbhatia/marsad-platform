-- Sector classification, with its provenance recorded.
--
-- ── THE STATE ─────────────────────────────────────────────────────────────────
-- 487 of 762 listed securities sit at sector='unknown' — 64% of the universe. Every peer,
-- cohort and sector-relative feature is therefore unavailable for two thirds of the market:
-- the Marsad Score's sector_percentile, the §3.3 sector-conditional ratio validity, and any
-- BLK-SCATTER or peer league the research stage would build.
--
-- The mapper itself is correct and already used (ingestion/src/lake/sector-taxonomy.ts, 13
-- FK-valid keys, banks/insurance regex-preserving). The failure is UPSTREAM CAPTURE:
-- PROFILE.SECURITY.payload.rawSector is null for every venue except QE, whose 49 map perfectly.
-- Measured here: of the 487 unknowns, ZERO have an industry string and ZERO have a profile
-- sector to map. There is nothing in the database left to derive from.
--
-- ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────
-- Tier B only: the same priority-ordered rules, applied to the company NAME. Ported verbatim
-- from SECTOR_RULES, in the same order, because order is load-bearing — 'bank' before generic
-- finance, insurance before finance, materials before energy (both share the 'petro' stem),
-- healthcare before technology so "biotechnology" does not resolve to tech.
--
-- Tier A (replaying archived Tadawul XBRL for the venue's own "Sector | Industry group" cell)
-- is NOT done here, and the reason is measured rather than assumed: only 38 of the 160 TDWL
-- unknowns have a stored HTML document to replay. The plan estimated ~230 across venues; the
-- data does not support that, so it would be real work for a small yield and it can wait for
-- the profile feeds to be re-run properly.
--
-- Tier C (an LLM pass over the residual) is NOT done here either. It costs money, and a
-- guessed sector should be a deliberate, priced decision rather than something a migration
-- does quietly.
--
-- ── WHY THE PROVENANCE COLUMNS ARE THE POINT ──────────────────────────────────
-- A cohort built from a name heuristic is a DIFFERENT CLAIM from one built from the exchange's
-- own classification, and a reader comparing a company to "its sector" deserves to know which
-- they are looking at. Without sector_source, a guess and a fact become indistinguishable the
-- moment they are both written to the same column — so the columns land in the same change as
-- the first guesses.

alter table public.securities add column if not exists sector_source text;
alter table public.securities add column if not exists sector_confidence text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'securities_sector_source_chk') then
    alter table public.securities add constraint securities_sector_source_chk
      check (sector_source is null or sector_source in ('venue','name_heuristic','llm','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'securities_sector_confidence_chk') then
    alter table public.securities add constraint securities_sector_confidence_chk
      check (sector_confidence is null or sector_confidence in ('high','medium','low'));
  end if;
end $$;

comment on column public.securities.sector_source is
  'How this security''s sector was determined: venue (the exchange''s own classification), '
  'name_heuristic (regex over the company name), llm, or manual. A cohort built from a guess '
  'is a different claim from one built from a fact, and BLK-PROV must be able to say which.';

comment on column public.securities.sector_confidence is
  'high = the venue classified it · medium = reserved for a corroborated derivation · '
  'low = inferred from the name alone.';

-- Anything already classified came from the venue feed (QE's profile scrape).
update public.securities
   set sector_source = 'venue', sector_confidence = 'high'
 where sector is not null and sector <> 'unknown' and sector_source is null;

-- ─── Tier B: the same rules, same order, applied to the name ──────────────────
with rules as (
  select * from (values
    (1,  'bank',                                                                                     'banks'),
    (2,  'insur|takaful|reinsur',                                                                    'insurance'),
    (3,  'reit|real\s*estate|property|realty|estate development',                                    'real_estate'),
    (4,  'financ|invest|brokerage|asset manage|securities',                                          'financials'),
    (5,  'material|chemical|mining|metal|cement|petrochem|paper|glass|steel|packaging|basic resource','materials'),
    (6,  'energy|oil|gas|petroleum|petro|refining|drilling',                                         'energy'),
    (7,  'utilit|electric|power|water|desalinat',                                                    'utilities'),
    (8,  'telecom|communication',                                                                    'telecom'),
    (9,  'health|pharma|medical|hospital|biotech|\mdrug',                                            'healthcare'),
    (10, 'technolog|software|\mit services|semiconductor|electronic equipment|hardware',             'technology'),
    (11, 'industr|capital goods|transport|logistic|construct|contract|engineering|aerospace|machinery|building|commercial (&|and) professional|diversified operation', 'industrials'),
    (12, 'food|beverage|agricultur|household|tobacco|dairy|poultry|retail|consumer|apparel|durables|media|entertainment|hotel|leisure|tourism|travel|restaurant|automobile|luxury|education', 'consumer')
  ) as t(ord, pattern, sector)
),
matched as (
  select distinct on (s.id) s.id, r.sector
    from public.securities s
    join rules r on lower(regexp_replace(coalesce(s.name_en, ''), '\s+', ' ', 'g')) ~ r.pattern
   where s.status = 'listed'
     and (s.sector is null or s.sector = 'unknown')
   -- FIRST MATCH WINS, by rule order — the same contract as the TS mapper's array order.
   order by s.id, r.ord
)
update public.securities s
   set sector = m.sector, sector_source = 'name_heuristic', sector_confidence = 'low'
  from matched m
 where s.id = m.id;

do $$
declare v_unknown int; v_named int; v_venue int; v_total int;
begin
  select count(*) filter (where sector = 'unknown' or sector is null),
         count(*) filter (where sector_source = 'name_heuristic'),
         count(*) filter (where sector_source = 'venue'),
         count(*)
    into v_unknown, v_named, v_venue, v_total
    from public.securities where status = 'listed';

  raise notice 'sector: % venue-classified, % name-inferred, % still unknown, of % listed',
    v_venue, v_named, v_unknown, v_total;

  -- Every classified security must carry its provenance, or the guess is indistinguishable
  -- from the fact — which is the entire point of this migration.
  if exists (select 1 from public.securities
              where status = 'listed' and sector is not null and sector <> 'unknown'
                and sector_source is null) then
    raise exception 'a classified security has no sector_source';
  end if;

  -- The FK target must hold: sector is a FOREIGN KEY to public.sectors(key).
  if exists (select 1 from public.securities s where s.sector is not null
              and not exists (select 1 from public.sectors k where k.key = s.sector)) then
    raise exception 'a security carries a sector outside public.sectors';
  end if;
end $$;

-- Tier C — classify the residual, and mark what has no sector at all.
--
-- After Tier B (name regex) 317 securities remained unknown, concentrated where tickers are
-- abbreviations a regex cannot read: ADX 78 of 93, BHB 37 of 41, TDWL 115.
--
-- ── THE THING A GENERIC CLASSIFIER GETS WRONG ─────────────────────────────────
-- A large part of that residual is not unclassified COMPANIES — it is instruments that have no
-- operating sector at all: 19 Lunate-managed ETFs on ADX (CHADX15, GCCDIV, KWEB, SUKUK,
-- USTBILL, USVALUE, INDI, JPANI…), the Nizwa sukuk on MSX, the Alkhabeer/SEDCO funds and the
-- Al Bilad/Alinma capital vehicles on TDWL.
--
-- Asked "what sector is USTBILL", a classifier will answer "financials" and be wrong in a way
-- that matters: every one of those instruments would then join the financials peer cohort, and
-- the Marsad Score's sector_percentile, the §3.3 ratio-validity set and any BLK-SCATTER built
-- on that cohort would be computing a US Treasury ETF against Gulf banks.
--
-- So they get sector_source = 'not_applicable' and stay 'unknown'. That distinguishes "we know
-- this has no operating sector" from "nobody has looked yet", which is the whole reason the
-- provenance columns exist. Cohort builders should exclude them explicitly.
--
-- ── PROVENANCE OF THE REST ────────────────────────────────────────────────────
-- source='llm', confidence='medium'. Honest on both counts: these are a model's identifications
-- from ticker and name, not the exchange's own classification (which would be 'venue'/'high'),
-- and not a human's (which would be 'manual'). Anything I could not identify with confidence is
-- deliberately LEFT unknown rather than guessed — a wrong sector is worse than a missing one,
-- because a missing one is visible.

-- 'not_applicable' is a new source: the security is classified as having no sector.
alter table public.securities drop constraint if exists securities_sector_source_chk;
alter table public.securities add constraint securities_sector_source_chk
  check (sector_source is null or sector_source in ('venue','name_heuristic','llm','manual','not_applicable'));

comment on column public.securities.sector_source is
  'How this security''s sector was determined: venue (the exchange''s own classification), '
  'name_heuristic (regex over the company name), llm, manual, or not_applicable (an ETF, fund '
  'or sukuk with no operating sector — sector stays ''unknown'' and cohort builders must '
  'exclude it rather than treat it as unclassified).';

-- ─── 1. Instruments with no operating sector ──────────────────────────────────
update public.securities s
   set sector_source = 'not_applicable', sector_confidence = 'high'
  from (values
    -- ADX: Lunate-managed ETFs and index trackers.
    ('ADX','CHADX15'),('ADX','CHHK'),('ADX','GCCDIV'),('ADX','GRMNY'),('ADX','INDI'),
    ('ADX','JPANI'),('ADX','KWEB'),('ADX','KWIN'),('ADX','KWTI'),('ADX','LUXURY'),
    ('ADX','PKSTN'),('ADX','QUANTM'),('ADX','SAUDIA'),('ADX','SUKUK'),('ADX','UAEA'),
    ('ADX','UAED'),('ADX','USGRWTH'),('ADX','USTBILL'),('ADX','USVALUE'),('ADX','BONDAE'),
    ('ADX','AIPOWR'),
    ('DFM','CHAE'),('DFM','CHAESHIN'),
    -- MSX: sukuk vehicles and one placeholder row.
    ('MSX','NSUK'),('MSX','NS25'),('MSX','OFSB'),
    -- TDWL: listed funds and capital/debt vehicles, not operating companies.
    ('TDWL','4700'),('TDWL','4702'),('TDWL','4703'),
    ('TDWL','9401'),('TDWL','9402'),('TDWL','9403'),('TDWL','9404'),('TDWL','9405'),
    ('TDWL','9406'),('TDWL','9407'),('TDWL','9408'),('TDWL','9409'),('TDWL','9410'),
    ('TDWL','9412')
  ) as v(venue, ticker)
 where s.venue_code = v.venue and s.ticker = v.ticker
   and (s.sector is null or s.sector = 'unknown');

-- ─── 2. Identified operating companies ────────────────────────────────────────
update public.securities s
   set sector = v.sector, sector_source = 'llm', sector_confidence = 'medium'
  from (values
    -- ADX
    ('ADX','ADCB','banks'),('ADX','ADIB','banks'),('ADX','FAB','banks'),('ADX','NBQ','banks'),
    ('ADX','UAB','banks'),('ADX','BOS','banks'),('ADX','INB','banks'),
    ('ADX','ADNIC','insurance'),('ADX','AWNIC','insurance'),('ADX','HAYAH','insurance'),
    ('ADX','ADNH','consumer'),('ADX','ADNHC','consumer'),('ADX','AGTHIA','consumer'),
    ('ADX','AMR','consumer'),('ADX','GHITHA','consumer'),('ADX','LULU','consumer'),
    ('ADX','NCTH','consumer'),('ADX','INVICTUS','consumer'),
    ('ADX','ADNOCDIST','energy'),
    ('ADX','ADNOCLS','industrials'),('ADX','ADPORTS','industrials'),('ADX','ADSB','industrials'),
    ('ADX','AGILITY','industrials'),('ADX','ASM','industrials'),('ADX','NMDC','industrials'),
    ('ADX','IHC','industrials'),('ADX','ALPHADHABI','industrials'),('ADX','ADAVIATION','industrials'),
    ('ADX','ALDAR','real_estate'),('ADX','MANAZEL','real_estate'),('ADX','MODON','real_estate'),
    ('ADX','RAKPROP','real_estate'),
    ('ADX','BOROUGE','materials'),('ADX','FERTIGLB','materials'),('ADX','RAKCEC','materials'),
    ('ADX','BILDCO','materials'),
    ('ADX','BURJEEL','healthcare'),('ADX','JULPHAR','healthcare'),('ADX','GMPC','healthcare'),
    ('ADX','RPM','healthcare'),
    ('ADX','EAND','telecom'),('ADX','SUDATEL','telecom'),
    ('ADX','TAQA','utilities'),
    ('ADX','ALPHADATA','technology'),('ADX','PRESIGHT','technology'),('ADX','SPACE42','technology'),
    ('ADX','PHX','technology'),
    ('ADX','GFH','financials'),('ADX','WAHA','financials'),('ADX','ESHRAQ','financials'),
    -- BHB
    ('BHB','ABC','banks'),('BHB','BBK','banks'),('BHB','BISB','banks'),('BHB','BMB','banks'),
    ('BHB','KHALEEJI','banks'),('BHB','NBB','banks'),('BHB','KFH','banks'),
    ('BHB','ARIG','insurance'),('BHB','BKIC','insurance'),('BHB','BNH','insurance'),
    ('BHB','SOLID','insurance'),
    ('BHB','BCFC','financials'),('BHB','ESTERAD','financials'),('BHB','GFH','financials'),
    ('BHB','INOVEST','financials'),('BHB','ITHMR','financials'),('BHB','SICO-C','financials'),
    ('BHB','UGH','financials'),('BHB','UGIC','financials'),
    ('BHB','ALBH','materials'),
    ('BHB','APMTB','industrials'),('BHB','BASREC','industrials'),
    ('BHB','BMMI','consumer'),('BHB','CINECO','consumer'),('BHB','DUTYF','consumer'),
    ('BHB','POLTRY','consumer'),('BHB','TRAFCO','consumer'),('BHB','BFM','consumer'),
    ('BHB','SEEF','real_estate'),
    ('BHB','BEYON','telecom'),('BHB','ZAINBH','telecom'),
    -- DFM
    ('DFM','CBD','banks'),('DFM','DIB','banks'),('DFM','EMIRATESNBD','banks'),('DFM','ENBDN26','banks'),
    ('DFM','SALAMA','insurance'),('DFM','WATANIA','insurance'),('DFM','AMAN','insurance'),
    ('DFM','NGI','insurance'),('DFM','DNIR','insurance'),
    ('DFM','ALANSARI','financials'),('DFM','AMANAT','financials'),('DFM','BHMCAPITAL','financials'),
    ('DFM','DFM','financials'),('DFM','GFH','financials'),('DFM','SHUAA','financials'),
    ('DFM','ITHMR','financials'),
    ('DFM','EMAAR','real_estate'),('DFM','EMAARDEV','real_estate'),('DFM','EMRDEVN26','real_estate'),
    ('DFM','DEYAAR','real_estate'),('DFM','MAZAYA','real_estate'),('DFM','TECOM','real_estate'),
    ('DFM','UPP','real_estate'),
    ('DFM','AIRARABIA','industrials'),('DFM','ALEC','industrials'),('DFM','ARMX','industrials'),
    ('DFM','DSI','industrials'),('DFM','MKHZN','industrials'),('DFM','PARKIN','industrials'),
    ('DFM','SALIK','industrials'),('DFM','DTC','industrials'),
    ('DFM','DEWA','utilities'),('DFM','TABREED','utilities'),
    ('DFM','DU','telecom'),('DFM','DUN26','telecom'),
    ('DFM','DRC','consumer'),('DFM','SPINNEYS','consumer'),('DFM','TAALEEM','consumer'),
    ('DFM','TALABAT','consumer'),('DFM','UNIONCOOP','consumer'),('DFM','ERC','consumer'),
    -- MSX
    ('MSX','AACT','materials'),('MSX','AMCI','materials'),('MSX','GSCI','materials'),
    ('MSX','NAPI','materials'),('MSX','OCCI','materials'),('MSX','OCHL','materials'),
    ('MSX','OMIF','materials'),('MSX','AFAI','materials'),('MSX','ABMI','materials'),
    ('MSX','OMCI','materials'),
    ('MSX','AJSS','industrials'),('MSX','ASCO','industrials'),('MSX','GECP','industrials'),
    ('MSX','RNSS','industrials'),('MSX','SPSI','industrials'),
    ('MSX','DGEN','utilities'),('MSX','SSPW','utilities'),
    ('MSX','OQEP','energy'),('MSX','SOMS','energy'),('MSX','SOMP','energy'),
    ('MSX','ORDS','telecom'),
    ('MSX','LIVA','insurance'),
    ('MSX','PRFD','real_estate'),
    ('MSX','BACS','consumer'),('MSX','GMPI','consumer'),('MSX','MTMI','consumer'),
    ('MSX','NDTI','consumer'),('MSX','OFCI','consumer'),('MSX','OFMI','consumer'),
    ('MSX','ORCI','consumer'),('MSX','SFMI','consumer'),('MSX','OSCI','consumer'),
    -- TDWL
    ('TDWL','2220','materials'),('TDWL','2310','materials'),('TDWL','2330','materials'),
    ('TDWL','4270','materials'),
    ('TDWL','2284','consumer'),('TDWL','2285','consumer'),('TDWL','2286','consumer'),
    ('TDWL','4190','consumer'),('TDWL','4191','consumer'),('TDWL','4192','consumer'),
    ('TDWL','4193','consumer'),('TDWL','4210','consumer'),('TDWL','6013','consumer'),
    ('TDWL','6016','consumer'),('TDWL','9515','consumer'),('TDWL','9567','consumer'),
    ('TDWL','2320','industrials'),('TDWL','2370','industrials'),('TDWL','1835','industrials'),
    ('TDWL','4142','industrials'),('TDWL','4262','industrials'),('TDWL','4263','industrials'),
    ('TDWL','4264','industrials'),('TDWL','9578','industrials'),
    ('TDWL','2382','energy'),('TDWL','4200','energy'),
    ('TDWL','4013','healthcare'),('TDWL','4017','healthcare'),('TDWL','9574','healthcare'),
    ('TDWL','4321','real_estate'),('TDWL','4322','real_estate'),('TDWL','4323','real_estate'),
    ('TDWL','5023','real_estate'),
    ('TDWL','4280','financials'),
    ('TDWL','8030','insurance'),('TDWL','8150','insurance'),('TDWL','8160','insurance'),
    ('TDWL','8170','insurance'),('TDWL','8240','insurance')
  ) as v(venue, ticker, sector)
 where s.venue_code = v.venue and s.ticker = v.ticker
   and (s.sector is null or s.sector = 'unknown');

do $$
declare v_unknown int; v_na int; v_llm int; v_total int;
begin
  select count(*) filter (where (sector = 'unknown' or sector is null) and sector_source is distinct from 'not_applicable'),
         count(*) filter (where sector_source = 'not_applicable'),
         count(*) filter (where sector_source = 'llm'),
         count(*)
    into v_unknown, v_na, v_llm, v_total
    from public.securities where status = 'listed';

  raise notice 'sector: % identified by model, % instruments with no sector, % still unknown, of % listed',
    v_llm, v_na, v_unknown, v_total;

  -- The FK must still hold after a bulk classification by hand.
  if exists (select 1 from public.securities s where s.sector is not null
              and not exists (select 1 from public.sectors k where k.key = s.sector)) then
    raise exception 'a security carries a sector outside public.sectors';
  end if;

  -- An instrument marked not_applicable must NOT also carry a sector: the two claims contradict.
  if exists (select 1 from public.securities
              where sector_source = 'not_applicable' and sector is not null and sector <> 'unknown') then
    raise exception 'a not_applicable instrument also carries a sector';
  end if;
end $$;

-- MSX equity universe reconcile — seed the listed-equity board into public.securities.
--
-- WHY: public.securities carried only 56 of the 108 MSX equities the exchange actually lists (a
-- Mubasher-era seed, retired 2026-07-16), so any per-security researcher iterating this table silently
-- covered ~52% of the venue. The authoritative universe is the market-watch board itself:
--   POST https://www.msx.om/APIPage.aspx/GetPageData  {"sHiddens":"0|0|false||0|SectorMarket|0"}
-- which returns all 185 MSX securities grouped by market x sector. This migration seeds the 108 EQUITIES
-- from that board (captured 2026-07-17): every market EXCEPT the Bonds market (MarketID 4) and excluding
-- the Mutual Funds sector (SectorID 2) — neither files the company IS/BS/CFS statements the fundamentals
-- backfill consumes.
--
-- sector is left 'unknown' ON PURPOSE. securities.sector is an FK to sectors(key) (the 13-slug taxonomy),
-- and MSX's board publishes only 3 coarse buckets (Financial / Industrial / Services) that do NOT map onto
-- it 1:1 — "Financial Sector" alone spans banks, insurance and financials. The real sector+sub-sector lives
-- in each filing's FilingInformation document; the sector projection fills it (DEF-SECTOR-DATA). Seeding
-- 'unknown' keeps the FK honest instead of guessing a wrong key.
--
-- status is 'listed' for ALL 108 including the Under_Monitoring board: those names still quote live
-- bid/ask on the board, so board_segment carries the nuance rather than a name-substring guess.
-- Idempotent: re-running refreshes name_en/board_segment only. An existing row KEEPS its sector and status,
-- so this never stomps a sector the projection has since resolved back to 'unknown'.

create temporary table _msx_board (ticker text primary key, name_en text not null, segment text not null) on commit drop;

insert into _msx_board (ticker, name_en, segment) values
  ('AACT', 'AL ANWAR CERAMIC', 'parallel'),
  ('AAIC', 'ALANWAR INVESTMENT', 'regular'),
  ('ABHS', 'AL BURAIMI HOTEL ( Under Liquidation )', 'under_monitoring'),
  ('ABMI', 'ABRASIVES MANUFACTURING ( Under Liquidation )', 'under_monitoring'),
  ('ABOB', 'AHLI BANK', 'parallel'),
  ('ABRJ', 'ABRAJ ENERGY SERVICES', 'regular'),
  ('AFAI', 'ALFAJAR ALAMIA', 'parallel'),
  ('AFIC', 'ARABIA FALCON INSURANCE', 'parallel'),
  ('AJSP', 'JAZERAH SER-P', 'regular'),
  ('AJSS', 'ALJAZEERA SERVICES', 'regular'),
  ('AMAT', 'MADINA TAKAFUL', 'regular'),
  ('AMCI', 'ALMAHA CERAMICS', 'parallel'),
  ('AMII', 'AL MADINA INVESTMENT HOLDING', 'parallel'),
  ('AOFS', 'AL OMANIYA FINANCIAL SERVICES', 'regular'),
  ('ASCO', 'ASYAD SHIPPING', 'regular'),
  ('ATMI', 'JAZEERA STEEL PRODUCTS', 'regular'),
  ('BACS', 'MAJAN COLLEGE', 'parallel'),
  ('BATP', 'ALBATINAH POWER', 'regular'),
  ('BKDB', 'BANK DHOFAR', 'regular'),
  ('BKMB', 'BANK MUSCAT', 'regular'),
  ('BKNZ', 'BANK NIZWA', 'regular'),
  ('BKSB', 'SOHAR INTERNATIONAL BANK', 'regular'),
  ('BRDE', 'BARKA DESALINATION', 'regular'),
  ('BWPC', 'BARKA WATER AND POWER', 'regular'),
  ('BWRQ', 'BAWAREQ NIZWA', 'aim'),
  ('CMII', 'CONSTRUCTION MATERIAL INDUSTRIES', 'parallel'),
  ('DBCI', 'DHOFAR BEVERAGES', 'parallel'),
  ('DBIH', 'AL BATINAH DEVELOPMENT & INVESTMENT HO.', 'under_monitoring'),
  ('DFIN', 'DHOFAR FOODS AND INVESTMENT', 'parallel'),
  ('DGEN', 'DHOFAR GENERATING', 'parallel'),
  ('DICS', 'DHOFAR INSURANCE', 'parallel'),
  ('DIDI', 'DHOFAR INTERNATIONAL DEVELOPMENT & INVESTMENT', 'regular'),
  ('DTCS', 'DHOFAR TOURISM', 'parallel'),
  ('FINC', 'FINANCIAL CORPORATION', 'parallel'),
  ('FSCI', 'FINANCIAL SERVICES', 'parallel'),
  ('GECP', 'GALFAR ENGIN.PRE', 'parallel'),
  ('GECS', 'GALFAR ENGINEERING & CONTRACTING', 'parallel'),
  ('GFIC', 'GLOBAL FINANCIAL INVESTMENT HO.', 'regular'),
  ('GHOS', 'GULF HOTELS (OM)', 'parallel'),
  ('GICI', 'GULF INTERNATIONAL CHEMICALS', 'parallel'),
  ('GMPI', 'GULF MUSHROOM PRODUCTS', 'regular'),
  ('GSCI', 'GULF STONES', 'under_monitoring'),
  ('HECI', 'AL HASSAN ENGINEERING (Under Liquidation)', 'under_monitoring'),
  ('HMCI', 'HOTELS MANAGEMENT COMPANY INTERNATIONAL', 'parallel'),
  ('KPCS', 'AL KAMEL POWER ( Under Liquidation )', 'under_monitoring'),
  ('LIVA', 'LIVA GROUP', 'parallel'),
  ('MCDE', 'MUSCAT CITY DESALINATION', 'parallel'),
  ('MCTI', 'MUSCAT INSURANCE', 'parallel'),
  ('MFCI', 'MUSCAT FINANCE', 'parallel'),
  ('MGMC', 'MUSCAT GASES', 'parallel'),
  ('MHAS', 'Al MAHA PETROLEUM PRODUCTS MARKETING', 'regular'),
  ('MSPW', 'MUSANDAM POWER', 'regular'),
  ('MTMI', 'MUSCAT THREAD MILLS', 'parallel'),
  ('NAPI', 'NATIONAL ALUMINIUM PRODUCTS', 'under_monitoring'),
  ('NBII', 'NATIONAL BISCUIT INDUSTRIES LIMITED', 'parallel'),
  ('NBOB', 'NATIONAL BANK OMAN', 'regular'),
  ('NDTI', 'NATIONAL DETERGENT', 'parallel'),
  ('NFCI', 'NATIONAL FINANCE', 'parallel'),
  ('NGCI', 'NATIONAL GAS', 'parallel'),
  ('NMWI', 'NATIONAL MINERAL WATER', 'under_monitoring'),
  ('NRED', 'NATIONAL REAL ESTATE DEVELOPMENT & INVESTMENTS', 'parallel'),
  ('OAB', 'OMAN ARAB BANK', 'parallel'),
  ('OCAI', 'OMAN CABLES INDUSTRY', 'regular'),
  ('OCCI', 'OMAN CHROMITE', 'parallel'),
  ('OCHL', 'OMAN CHLORINE', 'parallel'),
  ('OCOI', 'OMAN CEMENT', 'regular'),
  ('OEFI', 'OMANI EURO FOOD INDUSTRIES', 'under_monitoring'),
  ('OEIO', 'OMAN EMIRATES HO.', 'regular'),
  ('OETI', 'OMAN EDUCATION & TRAINING INVESTMENTS', 'parallel'),
  ('OFCI', 'OMAN FISHERIES', 'under_monitoring'),
  ('OFMI', 'OMAN FLOUR MILLS', 'parallel'),
  ('OMCI', 'OMAN CERAMIC (Under Liquidation )', 'under_monitoring'),
  ('OMIF', 'OMIFCO', 'parallel'),
  ('OMVS', 'OMINVEST', 'regular'),
  ('ONES', 'OMAN NATIONAL ENGINEERING & INVESTMENT', 'regular'),
  ('OOMP', 'OMAN OIL- PREF.', 'regular'),
  ('OOMS', 'OMAN OIL MARKETING', 'regular'),
  ('OPCI', 'OMAN PACKAGING', 'parallel'),
  ('OQBI', 'OQ BASE INDUSTRIES (SFZ)', 'regular'),
  ('OQEP', 'OQ EXPLORATION AND PRODUCTION', 'regular'),
  ('OQGN', 'OQ GAS NETWORKS', 'regular'),
  ('OQIC', 'OMAN QATAR INSURANCE', 'parallel'),
  ('ORCI', 'OMAN REFRESHMENT', 'parallel'),
  ('ORDS', 'OOREDOO', 'regular'),
  ('ORIC', 'OMAN REINSURANCE', 'parallel'),
  ('OSCI', 'OMAN SWEETS ( Under Liquidation )', 'under_monitoring'),
  ('OTEL', 'OMAN TELECOM', 'regular'),
  ('OUIC', 'OMAN UNITED INSURANCE', 'regular'),
  ('PHPC', 'PHOENIX POWER', 'regular'),
  ('RCCI', 'RAYSUT CEMENT', 'under_monitoring'),
  ('RNSS', 'RENAISSANCE SERVICES', 'regular'),
  ('SAHS', 'SAHARA HOSPITALITY', 'parallel'),
  ('SFMI', 'SALALAH MILLS', 'parallel'),
  ('SHPS', 'SOHAR POWER', 'parallel'),
  ('SHRQ', 'SHARQIYAH DESALINATION', 'parallel'),
  ('SIHC', 'AL SHARQIYA INVESTMENT HO.', 'regular'),
  ('SMNP', 'SMN POWER HOLDING', 'regular'),
  ('SOMP', 'SHELL OM- PREF.SH', 'parallel'),
  ('SOMS', 'SHELL OMAN MARKETING', 'parallel'),
  ('SPFI', 'ASAFFA FOODS', 'regular'),
  ('SPSI', 'SALALAH PORT SERVICES', 'parallel'),
  ('SSPW', 'SEMBCORP SALALAH', 'regular'),
  ('SUWP', 'AL SUWADI POWER', 'regular'),
  ('TAOI', 'TAKAFUL OMAN', 'parallel'),
  ('TFCI', 'TAAGEER FINANCE', 'parallel'),
  ('UBAR', 'UBAR HOTELS and RESORTS', 'parallel'),
  ('UFCI', 'UNITED FINANCE', 'regular'),
  ('VOES', 'VOLTAMP ENERGY', 'regular');

insert into public.securities (venue_code, ticker, name_en, sector, currency, status, board_segment)
select 'MSX', b.ticker, b.name_en, 'unknown', 'OMR', 'listed', b.segment
from _msx_board b
on conflict (venue_code, ticker) do update
  set name_en       = excluded.name_en,
      board_segment = excluded.board_segment,
      updated_at    = now();

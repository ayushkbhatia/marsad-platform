-- 20260716141000_reconcile_dfm_securities_universe — DFM equities 51→68 (DEF-DFM-SECURITIES-RECONCILE).
--
-- public.securities held 55 DFM rows, but only 51 of them are active equities; the live equities board
-- (marketwatch.dfm.ae POST dapi/fetch, command 'stocks', filtered to market=510 + suspended='A', captured
-- 2026-07-16) lists 68 active equities. The 17 missing are mostly 2023–25 IPOs + a few older insurers/
-- foreign dual-listings the initial bootstrap never had. Without these rows the DFM financials backfill
-- (scripts/researchers/dfm-backfill.mjs) silently skips them — fn_financials_project resolves security_id
-- by (venue_code, ticker), so a filing whose ticker has no security row lands nothing — and live PE/PB/
-- Score can never cover them.
--
-- Golden source = the DFM board (market=510). name_en is the real company name from the eFsah `issuer`
-- field (api2.dfm.ae/efsah/v1/prototype_efsah). sector='unknown' platform-wide (DEF-SECTOR-DATA — filled
-- later by the securities_profile scrape); currency='AED' (every DFM row). ON CONFLICT (venue_code,
-- ticker) DO NOTHING so the 55 existing rows (incl. their real names) are untouched — this only ADDS.
--
-- The 4 live DFM rows NOT on the equities board are left as-is: BHMCAPITAL (market=520) + DUN26/EMRDEVN26/
-- ENBDN26 (bonds/sukuk, market=602). After this migration: DFM securities 55→72, active-equity coverage
-- 51→68 (the full board).

set search_path = '';

insert into public.securities (venue_code, ticker, name_en, sector, currency, status) values
    ('DFM','ALLIANCE','Alliance Insurance PJSC','unknown','AED','listed'),
    ('DFM','ASNIC','Al Sagr National Insurance Company PJSC','unknown','AED','listed'),
    ('DFM','DIN','Dubai Insurance Co. PJSC','unknown','AED','listed'),
    ('DFM','DRC','Dubai Refreshment Company PJSC','unknown','AED','listed'),
    ('DFM','EIBANK','Emirates Investment Bank PJSC','unknown','AED','listed'),
    ('DFM','IFA','International Financial Advisors Holding Co. K.P.S.C','unknown','AED','listed'),
    ('DFM','MASQ','Mashreq Bank PJSC','unknown','AED','listed'),
    ('DFM','MAZAYA','Al Mazaya Holding Company','unknown','AED','listed'),
    ('DFM','MKHZN','Agility The Public Warehousing Company K.S.C','unknown','AED','listed'),
    ('DFM','NAHO','Naeem Holding For Investments EJSC','unknown','AED','listed'),
    ('DFM','NCC','National Cement Company PJSC','unknown','AED','listed'),
    ('DFM','NIND','National Industries Group Holding S.A.K','unknown','AED','listed'),
    ('DFM','ORIENT','Orient Insurance PJSC','unknown','AED','listed'),
    ('DFM','ORIENTTKAFUL','Orient Takaful PJSC','unknown','AED','listed'),
    ('DFM','SUKOON','Sukoon Insurance PJSC','unknown','AED','listed'),
    ('DFM','UFC','United Foods Company PJSC','unknown','AED','listed'),
    ('DFM','UNIKAI','UNIKAI FOODS PJSC','unknown','AED','listed')
on conflict (venue_code, ticker) do nothing;

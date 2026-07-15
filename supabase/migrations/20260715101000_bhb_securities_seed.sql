-- Seed the full 41-stock BHB universe. Only 8 BHB securities existed; the live board
-- (webapi GetTabularData?storedProcdure=Quotes, captured 2026-07-15) lists 41. Without
-- the rows, BHB quotes can't project to quotes_latest and the EOD backfill has no
-- injection targets (the coverage guard injects from public.securities).
--
-- Symbols + currency are from the board (6 are USD-quoted: ABC/ARIG/GFH/INOVEST/ITHMR/KFH;
-- the rest BHD). name_en is a ticker PLACEHOLDER for the 33 new rows — the BHB board
-- carries no company name; the 8 pre-existing rows keep their real names via ON CONFLICT
-- DO NOTHING. sector='unknown' platform-wide (DEF-SECTOR-DATA). Name + sector enrichment
-- rides the later BHB company-profile scrape (DEF-SECTOR-DATA / DEF-BHB-NAMES).

insert into public.securities (venue_code, ticker, name_en, sector, currency) values
    ('BHB','ABC','ABC','unknown','USD'),
    ('BHB','ABRAAJ','ABRAAJ','unknown','BHD'),
    ('BHB','ALBH','ALBH','unknown','BHD'),
    ('BHB','APMTB','APMTB','unknown','BHD'),
    ('BHB','ARIG','ARIG','unknown','USD'),
    ('BHB','BASREC','BASREC','unknown','BHD'),
    ('BHB','BBK','BBK','unknown','BHD'),
    ('BHB','BCFC','BCFC','unknown','BHD'),
    ('BHB','BEYON','BEYON','unknown','BHD'),
    ('BHB','BFM','BFM','unknown','BHD'),
    ('BHB','BISB','BISB','unknown','BHD'),
    ('BHB','BKIC','BKIC','unknown','BHD'),
    ('BHB','BMB','BMB','unknown','BHD'),
    ('BHB','BMMI','BMMI','unknown','BHD'),
    ('BHB','BMUSC','BMUSC','unknown','BHD'),
    ('BHB','BNH','BNH','unknown','BHD'),
    ('BHB','CINECO','CINECO','unknown','BHD'),
    ('BHB','CPARK','CPARK','unknown','BHD'),
    ('BHB','DUTYF','DUTYF','unknown','BHD'),
    ('BHB','EBRIT','EBRIT','unknown','BHD'),
    ('BHB','ESTERAD','ESTERAD','unknown','BHD'),
    ('BHB','FAMILY','FAMILY','unknown','BHD'),
    ('BHB','GFH','GFH','unknown','USD'),
    ('BHB','GHG','GHG','unknown','BHD'),
    ('BHB','INOVEST','INOVEST','unknown','USD'),
    ('BHB','ITHMR','ITHMR','unknown','USD'),
    ('BHB','KFH','KFH','unknown','USD'),
    ('BHB','KHALEEJI','KHALEEJI','unknown','BHD'),
    ('BHB','NBB','NBB','unknown','BHD'),
    ('BHB','NHOTEL','NHOTEL','unknown','BHD'),
    ('BHB','POLTRY','POLTRY','unknown','BHD'),
    ('BHB','SALAM','SALAM','unknown','BHD'),
    ('BHB','SEEF','SEEF','unknown','BHD'),
    ('BHB','SICO-C','SICO-C','unknown','BHD'),
    ('BHB','SILAH','SILAH','unknown','BHD'),
    ('BHB','SOLID','SOLID','unknown','BHD'),
    ('BHB','TAKAFUL','TAKAFUL','unknown','BHD'),
    ('BHB','TRAFCO','TRAFCO','unknown','BHD'),
    ('BHB','UGH','UGH','unknown','BHD'),
    ('BHB','UGIC','UGIC','unknown','BHD'),
    ('BHB','ZAINBH','ZAINBH','unknown','BHD')
on conflict (venue_code, ticker) do nothing;

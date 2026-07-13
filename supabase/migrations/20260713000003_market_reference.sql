-- 0003_market_reference — venues, sectors, securities, indices, FX, sessions,
-- holidays + reference seed (6 active venues + BK inactive, 11 sectors,
-- 2026–2027 holiday calendar with Hijri rows unconfirmed). 02 §7, §22 step 3.

create table public.venues (
  code          text primary key,
  name          text not null,
  country       char(2) not null,
  timezone      text not null,
  currency      char(3) not null,
  mic           text,
  trading_days  int[] not null default '{0,1,2,3,4}',  -- dow, 0=Sun … 4=Thu
  delay_minutes int not null default 15,
  owning_agent  uuid references iam.principals(id),
  is_active     boolean not null default true,
  sort_order    int not null default 100
);

create table public.sectors (
  key        text primary key,
  name       text not null,
  sort_order int
);

create table public.securities (
  id                 bigint generated always as identity primary key,
  venue_code         text not null references public.venues(code),
  ticker             text not null,
  isin               text,
  name_en            text not null,
  -- AR-LATER: name_ar text
  sector             text not null references public.sectors(key),
  industry           text,
  board_segment      text,
  currency           char(3) not null,
  free_float_pct     numeric(6,3),
  shares_outstanding numeric(20,0),
  listing_date       date,
  status             text not null default 'listed' check (status in ('pre_listing','listed','suspended','delisted')),
  score_eligible_from date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (venue_code, ticker)
);
create index securities_sector_idx on public.securities (sector);
create index securities_name_trgm on public.securities using gin (name_en extensions.gin_trgm_ops);
create trigger securities_updated_at before update on public.securities
  for each row execute function public.set_updated_at();

create table public.indices (
  code         text primary key,
  venue_code   text not null references public.venues(code),
  name         text not null,
  is_composite boolean not null default true
);

create table public.index_sector_weights (
  index_code text not null references public.indices(code),
  sector     text not null references public.sectors(key),
  weight_pct numeric(6,3) not null,
  as_of      date not null,
  primary key (index_code, sector, as_of)
);

create table public.fx_rates (
  pair      text not null,
  rate      numeric(18,8) not null,
  as_of     timestamptz not null,
  is_pegged boolean not null default false,
  primary key (pair, as_of)
);

create table public.market_sessions (
  id                 bigint generated always as identity primary key,
  venue_code         text not null references public.venues(code),
  session_kind       text not null default 'regular' check (session_kind in ('regular','ramadan','half_day')),
  open_local         time not null,
  close_local        time not null,
  auction_open_local time,
  effective_from     date not null,
  effective_to       date,
  confirmed_by       uuid references iam.principals(id),
  confirmed_at       timestamptz
);
create index market_sessions_lookup on public.market_sessions (venue_code, effective_from desc);

create table public.market_holidays (
  id                 bigint generated always as identity primary key,
  venue_code         text not null references public.venues(code),
  holiday_date       date not null,
  name               text not null,
  is_hijri_estimated boolean not null default false,
  confirmed_by       uuid references iam.principals(id),
  confirmed_at       timestamptz,
  unique (venue_code, holiday_date)
);

-- ---------------------------------------------------------------------------
-- Reference seed.

insert into public.venues (code, name, country, timezone, currency, mic, trading_days, delay_minutes, owning_agent, is_active, sort_order) values
  ('TDWL', 'Saudi Exchange (Tadawul)', 'SA', 'Asia/Riyadh',  'SAR', 'XSAU', '{0,1,2,3,4}', 15, (select id from iam.principals where handle = 'DATA-TDWL'), true,  10),
  ('DFM',  'Dubai Financial Market',   'AE', 'Asia/Dubai',   'AED', 'XDFM', '{1,2,3,4,5}', 15, (select id from iam.principals where handle = 'DATA-DFM'),  true,  20),
  ('ADX',  'Abu Dhabi Securities Exchange', 'AE', 'Asia/Dubai', 'AED', 'XADS', '{1,2,3,4,5}', 15, (select id from iam.principals where handle = 'DATA-ADX'), true, 30),
  ('QE',   'Qatar Stock Exchange',     'QA', 'Asia/Qatar',   'QAR', 'DSMD', '{0,1,2,3,4}', 15, (select id from iam.principals where handle = 'DATA-QE'),   true,  40),
  ('MSX',  'Muscat Stock Exchange',    'OM', 'Asia/Muscat',  'OMR', 'XMUS', '{0,1,2,3,4}', 15, (select id from iam.principals where handle = 'DATA-MSX'),  true,  50),
  ('BHB',  'Bahrain Bourse',           'BH', 'Asia/Bahrain', 'BHD', 'XBAH', '{0,1,2,3,4}', 15, (select id from iam.principals where handle = 'DATA-BHB'),  true,  60),
  ('BK',   'Boursa Kuwait',            'KW', 'Asia/Kuwait',  'KWD', 'XKUW', '{0,1,2,3,4}', 15, null, false, 70); -- DEFAULTED D6: read-only placeholder

insert into public.sectors (key, name, sort_order) values
  ('energy',      'Energy',                  10),
  ('materials',   'Materials',               20),
  ('banks',       'Banks',                   30),
  ('financials',  'Diversified Financials',  40),
  ('insurance',   'Insurance',               50),
  ('telecom',     'Telecommunication',       60),
  ('utilities',   'Utilities',               70),
  ('real_estate', 'Real Estate',             80),
  ('consumer',    'Consumer',                90),
  ('healthcare',  'Health Care',            100),
  ('industrials', 'Capital Goods & Industrials', 110);

insert into public.indices (code, venue_code, name) values
  ('TASI',  'TDWL', 'Tadawul All Share Index'),
  ('DFMGI', 'DFM',  'DFM General Index'),
  ('FADGI', 'ADX',  'FTSE ADX General Index'),
  ('QSI',   'QE',   'QE General Index'),
  ('MSX30', 'MSX',  'MSX 30 Index'),
  ('BAX',   'BHB',  'Bahrain All Share Index');

-- Regular sessions (Ramadan variants land as confirmed rows via 33a).
insert into public.market_sessions (venue_code, session_kind, open_local, close_local, auction_open_local, effective_from) values
  ('TDWL', 'regular', '10:00', '15:00', '09:30', '2026-01-01'),
  ('DFM',  'regular', '10:00', '15:00', '09:30', '2026-01-01'),
  ('ADX',  'regular', '10:00', '15:00', '09:30', '2026-01-01'),
  ('QE',   'regular', '09:30', '13:15', '09:00', '2026-01-01'),
  ('MSX',  'regular', '09:00', '13:10', '08:30', '2026-01-01'),
  ('BHB',  'regular', '09:30', '13:00', '09:15', '2026-01-01');

-- Holiday calendar 2026–2027: fixed national days confirmed; Hijri-dependent
-- rows carry is_hijri_estimated = true until a human confirms (33a).
insert into public.market_holidays (venue_code, holiday_date, name, is_hijri_estimated)
select v.code, h.d, h.n, h.est
from public.venues v
cross join (values
  (date '2026-05-26', 'Eid al-Adha (estimated)',  true),
  (date '2026-05-27', 'Eid al-Adha (estimated)',  true),
  (date '2026-05-28', 'Eid al-Adha (estimated)',  true),
  (date '2026-06-16', 'Islamic New Year (estimated)', true),
  (date '2027-03-09', 'Eid al-Fitr (estimated)',  true),
  (date '2027-03-10', 'Eid al-Fitr (estimated)',  true),
  (date '2027-03-11', 'Eid al-Fitr (estimated)',  true)
) as h(d, n, est)
where v.code <> 'BK';

insert into public.market_holidays (venue_code, holiday_date, name, is_hijri_estimated) values
  ('TDWL', '2026-09-23', 'Saudi National Day',    false),
  ('TDWL', '2027-09-23', 'Saudi National Day',    false),
  ('TDWL', '2027-02-22', 'Saudi Founding Day',    false),
  ('DFM',  '2026-12-02', 'UAE National Day',      false),
  ('DFM',  '2026-12-03', 'UAE National Day',      false),
  ('ADX',  '2026-12-02', 'UAE National Day',      false),
  ('ADX',  '2026-12-03', 'UAE National Day',      false),
  ('QE',   '2026-12-18', 'Qatar National Day',    false),
  ('MSX',  '2026-11-18', 'Oman National Day',     false),
  ('MSX',  '2026-11-19', 'Oman National Day',     false),
  ('BHB',  '2026-12-16', 'Bahrain National Day',  false),
  ('BHB',  '2026-12-17', 'Bahrain National Day',  false);

-- GCC pegs (KWD floats against a basket).
insert into public.fx_rates (pair, rate, as_of, is_pegged) values
  ('USDSAR', 3.75000000, '2026-07-12 05:41:00+00', true),
  ('USDAED', 3.67250000, '2026-07-12 05:41:00+00', true),
  ('USDQAR', 3.64000000, '2026-07-12 05:41:00+00', true),
  ('USDOMR', 0.38450000, '2026-07-12 05:41:00+00', true),
  ('USDBHD', 0.37600000, '2026-07-12 05:41:00+00', true),
  ('USDKWD', 0.30660000, '2026-07-12 05:41:00+00', false);

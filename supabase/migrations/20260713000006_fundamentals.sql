-- 0006_fundamentals — filings, statements, ratios, transcripts, earnings,
-- estimates, dividends, IPOs, ownership; filings/transcripts buckets.
-- 02 §8, §22 step 6.

create table public.filings (
  id               bigint generated always as identity primary key,
  security_id      bigint references public.securities(id),
  venue_code       text not null references public.venues(code),
  source_ref       text not null,
  form_code        text,
  filing_type      text not null check (filing_type in
                   ('DIVIDEND','CAPEX','RESULTS','RATING','GOVERNANCE','OPS','CONTRACT','PROSPECTUS','OTHER')),
  title            text not null,
  filed_at         timestamptz not null,
  full_text        text,
  extracted_facts  jsonb,
  is_market_moving boolean not null default false,
  pdf_en_path      text,
  -- AR-LATER: pdf_ar_path text
  pdf_pages        int,
  ai_summary       text,
  ai_summary_model text,
  parse_run_id     bigint references lake.parse_runs(id),
  search_tsv       tsvector generated always as
                   (setweight(to_tsvector('english', coalesce(title,'')),'A') ||
                    setweight(to_tsvector('english', left(coalesce(full_text,''), 200000)),'B')) stored,
  created_at       timestamptz not null default now(),
  unique (venue_code, source_ref)
);
create index filings_security_time on public.filings (security_id, filed_at desc);
create index filings_venue_time    on public.filings (venue_code, filed_at desc);
create index filings_tsv           on public.filings using gin (search_tsv);

create table public.financial_statements (
  id               bigint generated always as identity primary key,
  security_id      bigint not null references public.securities(id),
  statement_type   text not null check (statement_type in ('income','balance','cashflow')),
  basis            text not null default 'consolidated' check (basis in ('consolidated','standalone')),
  period_kind      text not null check (period_kind in ('quarter','annual','ttm')),
  fiscal_period    text not null,
  period_end       date not null,
  currency         char(3) not null,
  is_estimate      boolean not null default false,
  line_items       jsonb not null,
  segments         jsonb,
  source_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),
  audited          boolean,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (security_id, statement_type, basis, fiscal_period, is_estimate)
);
create index fin_stmt_lookup on public.financial_statements (security_id, statement_type, period_end desc);
create trigger financial_statements_updated_at before update on public.financial_statements
  for each row execute function public.set_updated_at();

create table public.key_ratios (
  security_id      bigint primary key references public.securities(id) on delete cascade,
  market_cap       numeric(20,2),
  pe               numeric(10,3),
  pb               numeric(10,3),
  eps_ttm          numeric(12,4),
  book_value_ps    numeric(12,4),
  dividend_yield   numeric(7,4),
  payout_ratio     numeric(7,4),
  roe              numeric(7,4),
  roce             numeric(7,4),
  nim              numeric(7,4),
  net_debt_ebitda  numeric(8,3),
  ev_ebitda        numeric(10,3),
  ps               numeric(10,3),
  computed_at      timestamptz not null default now(),
  source_object_id uuid references lake.objects(id)
);

create table public.earnings_events (
  id                        bigint generated always as identity primary key,
  security_id               bigint not null references public.securities(id),
  fiscal_period             text not null,
  report_date               date not null,
  date_state                text not null default 'estimated' check (date_state in ('confirmed','estimated')),
  session                   text check (session in ('pre','post')),
  eps_consensus             numeric(12,4),
  eps_marsad                numeric(12,4),
  eps_prior                 numeric(12,4),
  eps_actual                numeric(12,4),
  revenue_consensus         numeric(20,2),
  revenue_actual            numeric(20,2),
  verdict                   text check (verdict in ('BEAT','IN_LINE','MISS','HELD')),
  surprise_pct              numeric(9,4),
  next_session_reaction_pct numeric(9,4),
  rvc_table                 jsonb,
  segment_breakdown         jsonb,
  desk_take                 text,
  house_rank                int,
  results_filing_id         bigint references public.filings(id),
  source_object_id          uuid references lake.objects(id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (security_id, fiscal_period)
);
create index earnings_calendar_idx on public.earnings_events (report_date, security_id);
create trigger earnings_events_updated_at before update on public.earnings_events
  for each row execute function public.set_updated_at();

create table public.transcripts (
  id                bigint generated always as identity primary key,
  security_id       bigint not null references public.securities(id),
  earnings_event_id bigint references public.earnings_events(id),
  call_datetime     timestamptz not null,
  duration_seconds  int,
  status            text not null default 'upcoming'
                    check (status in ('upcoming','audio_ingested','transcribed','desk_reviewed','summary_ready')),
  audio_path        text,
  chapters          jsonb,
  ai_summary        jsonb,
  ai_summary_model  text,
  parse_run_id      bigint references lake.parse_runs(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger transcripts_updated_at before update on public.transcripts
  for each row execute function public.set_updated_at();

create table public.transcript_segments (
  id            bigint generated always as identity primary key,
  transcript_id bigint not null references public.transcripts(id) on delete cascade,
  seq           int not null,
  start_ms      int not null,
  speaker_name  text,
  speaker_role  text,
  body          text not null,
  search_tsv    tsvector generated always as (to_tsvector('english', body)) stored,
  unique (transcript_id, seq)
);
create index transcript_segments_tsv on public.transcript_segments using gin (search_tsv);

create table public.estimates (
  id               bigint generated always as identity primary key,
  security_id      bigint not null references public.securities(id),
  metric           text not null,
  source           text not null check (source in ('consensus','marsad')),
  value            numeric(14,4) not null,
  n_analysts       int,
  as_of            date not null,
  source_object_id uuid references lake.objects(id),
  unique (security_id, metric, source, as_of)
);
create index estimates_series_idx on public.estimates (security_id, metric, source, as_of desc);

create table public.dividends (
  id                bigint generated always as identity primary key,
  security_id       bigint not null references public.securities(id),
  div_type          text not null check (div_type in ('FINAL','INTERIM','SPECIAL')),
  fiscal_ref        text,
  dps               numeric(12,6) not null,
  currency          char(3) not null,
  ex_date           date,
  record_date       date,
  pay_date          date,
  yield_at_announce numeric(7,4),
  payout_ratio      numeric(7,4),
  verification      text not null default 'disclosure' check (verification in ('registrar','disclosure')),
  state             text not null default 'pending_confirm' check (state in ('pending_confirm','live','cancelled')),
  confirmed_by      uuid references iam.principals(id),
  confirmed_at      timestamptz,
  source_object_id  uuid not null references lake.objects(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index dividends_uni on public.dividends
  (security_id, div_type, coalesce(fiscal_ref,''), coalesce(ex_date, date '9999-12-31'));
create index dividends_exdate_idx on public.dividends (ex_date) where state = 'live';
create trigger dividends_updated_at before update on public.dividends
  for each row execute function public.set_updated_at();

-- Human confirm gate (33b) + single-write fan-out ping (02 §8).
create or replace function public.fn_dividend_confirm_guard() returns trigger
language plpgsql as $$
begin
  if new.state = 'live' and old.state = 'pending_confirm' then
    if new.confirmed_by is null or not exists (
      select 1 from iam.principals p where p.id = new.confirmed_by and p.kind = 'human'
    ) then
      raise exception 'dividend go-live requires a HUMAN confirmer (33b)';
    end if;
    new.confirmed_at := coalesce(new.confirmed_at, now());
  end if;
  return new;
end $$;
create trigger dividends_confirm_guard before update on public.dividends
  for each row execute function public.fn_dividend_confirm_guard();

create or replace function public.fn_dividend_fanout_notify() returns trigger
language plpgsql as $$
begin
  if new.state = 'live' and old.state <> 'live' then
    perform pg_notify('fanout', 'dividend:' || new.id);
  end if;
  return null;
end $$;
create trigger dividends_fanout after update on public.dividends
  for each row execute function public.fn_dividend_fanout_notify();

create table public.ipo_offers (
  id                   bigint generated always as identity primary key,
  security_id          bigint references public.securities(id),
  company_name         text not null,
  venue_code           text not null references public.venues(code),
  stage                text not null check (stage in
                       ('intention','draft_prospectus','filing','bookbuilding','retail_open','allocation','listed')),
  price_range_low      numeric(18,6),
  price_range_high     numeric(18,6),
  final_price          numeric(18,6),
  offer_size_pct       numeric(6,3),
  shares_offered       numeric(20,0),
  raise_amount         numeric(20,2),
  implied_mcap         numeric(20,2),
  implied_pe           numeric(10,3),
  implied_yield        numeric(7,4),
  retail_tranche_pct   numeric(6,3),
  min_lot              int,
  dividend_policy      text,
  use_of_proceeds      jsonb,
  brokers              jsonb,
  refunds_by           date,
  retail_open_at       timestamptz,
  retail_close_at      timestamptz,
  expected_listing     date,
  maintainer_agent     uuid references iam.principals(id),
  object_state         text not null default 'draft' check (object_state in ('agent_current','needs_review','draft')),
  prospectus_filing_id bigint references public.filings(id),
  source_object_id     uuid references lake.objects(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger ipo_offers_updated_at before update on public.ipo_offers
  for each row execute function public.set_updated_at();

-- 33b: an agent touching price-sensitive IPO columns stages the change instead
-- of applying it — row flips to needs_review, values stay as-is.
create or replace function public.fn_ipo_price_sensitive_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.principal_kind', true), '') = 'agent'
     and old.object_state = 'agent_current'
     and (new.final_price      is distinct from old.final_price or
          new.price_range_low  is distinct from old.price_range_low or
          new.price_range_high is distinct from old.price_range_high or
          new.retail_open_at   is distinct from old.retail_open_at or
          new.retail_close_at  is distinct from old.retail_close_at or
          new.expected_listing is distinct from old.expected_listing) then
    new.final_price      := old.final_price;
    new.price_range_low  := old.price_range_low;
    new.price_range_high := old.price_range_high;
    new.retail_open_at   := old.retail_open_at;
    new.retail_close_at  := old.retail_close_at;
    new.expected_listing := old.expected_listing;
    new.object_state     := 'needs_review';
  end if;
  return new;
end $$;
create trigger ipo_price_sensitive_guard before update on public.ipo_offers
  for each row execute function public.fn_ipo_price_sensitive_guard();

create table public.ipo_timeline_events (
  id                 bigint generated always as identity primary key,
  ipo_id             bigint not null references public.ipo_offers(id) on delete cascade,
  stage              text not null,
  starts_at          timestamptz,
  ends_at            timestamptz,
  coverage_inst      numeric(8,3),
  coverage_retail    numeric(8,3),
  is_price_sensitive boolean not null default false,
  source_object_id   uuid references lake.objects(id),
  updated_at         timestamptz not null default now()
);
create trigger ipo_timeline_events_updated_at before update on public.ipo_timeline_events
  for each row execute function public.set_updated_at();

create table public.listing_debuts (
  ipo_id                bigint primary key references public.ipo_offers(id),
  security_id           bigint not null references public.securities(id),
  debut_date            date not null,
  offer_price           numeric(18,6) not null,
  open_price            numeric(18,6),
  auction_price         numeric(18,6),
  auction_volume        numeric(20,0),
  vwap                  numeric(18,6),
  free_float_traded_pct numeric(6,3),
  allocation_recap      jsonb
);

create table public.holders (
  id                  bigint generated always as identity primary key,
  name                text not null,
  holder_type         text not null check (holder_type in ('sovereign','institution','family_office','fund','individual')),
  country             char(2),
  established         int,
  disclosed_value_usd numeric(20,2),
  aum_self_reported   boolean not null default false,
  created_at          timestamptz not null default now()
);

create table public.holder_positions (
  id               bigint generated always as identity primary key,
  holder_id        bigint not null references public.holders(id),
  security_id      bigint not null references public.securities(id),
  as_of            date not null,
  stake_pct        numeric(7,4) not null,
  qoq_change_pp    numeric(7,4),
  source_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),
  unique (holder_id, security_id, as_of)
);
create index holder_positions_sec_idx on public.holder_positions (security_id, as_of desc);

create table public.ownership_snapshots (
  security_id           bigint not null references public.securities(id),
  as_of                 date not null,
  categories            jsonb not null,
  foreign_ownership_pct numeric(7,4),
  is_fol_record         boolean not null default false,
  source_object_id      uuid references lake.objects(id),
  primary key (security_id, as_of)
);

-- Filing PDFs are public documents (CDN reads); transcript audio stays private.
select ops.ensure_bucket('filings', true);
select ops.ensure_bucket('transcripts', false);

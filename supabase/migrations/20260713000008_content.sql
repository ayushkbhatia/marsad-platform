-- 0008_content — templates/blocks registries (+seed), content items/blocks/
-- corrections/revisions/attachments, citation graph, front-page/nav versions,
-- analysts. 02 §5, §10, §22 step 8.

create table ops.templates (
  key                   text primary key,
  name                  text not null,
  served_types          text[] not null,
  auto_select_rule      text not null,
  block_keys            text[] not null,
  auto_publish_eligible boolean not null default false,
  always_premium        boolean not null default false,
  max_words             int
);

create table ops.story_blocks (
  key                 text primary key,
  name                text not null,
  lake_object_type    text,
  consuming_templates text[] not null,
  renderer_component  text not null
);

create table public.content_items (
  id                      uuid primary key default gen_random_uuid(),
  content_type            text not null check (content_type in ('WIRE','ARTICLE','EXPLAINER','NOTE','TAKE','NEWSLETTER')),
  slug                    text unique,
  section                 text,
  kicker                  text,
  dek                     text,
  headline                text not null check (char_length(headline) <= 90),  -- R-10 hard floor
  status                  text not null default 'draft' check (status in
                          ('draft','in_review','rules_check','approval','scheduled','live','updated','sent','retracted')),
  template_key            text references ops.templates(key),
  author_id               uuid not null references iam.principals(id),
  byline_chain            jsonb not null default '[]',
  is_premium              boolean not null default false,
  premium_cut_after_block int,
  read_minutes            smallint,
  evergreen               boolean not null default false,
  review_cadence_days     int,
  reading_level           text,
  due_at                  timestamptz,
  scheduled_at            timestamptz,
  published_at            timestamptz,
  social_card             jsonb,
  rating_attachment       jsonb,
  retraction_notice       text,
  word_count              int,
  search_tsv              tsvector generated always as
                          (to_tsvector('english', coalesce(headline,'') || ' ' || coalesce(dek,''))) stored,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index content_status_idx  on public.content_items (status, coalesce(scheduled_at, published_at));
create index content_section_idx on public.content_items (section, published_at desc) where status in ('live','updated');
create index content_tsv         on public.content_items using gin (search_tsv);
create trigger content_items_updated_at before update on public.content_items
  for each row execute function public.set_updated_at();

-- Negative-scope enforcement, content half (05 §2.4): agents may not move
-- content to LIVE except the codified TPL-01 ≤40-word wire while the
-- auto_publish_wires switch is on and the caller is a PUBLISHING agent.
create or replace function public.fn_enforce_agent_publish_gate() returns trigger
language plpgsql as $$
declare
  v_pid uuid;
begin
  if new.status = 'live' and old.status is distinct from new.status
     and coalesce(current_setting('app.principal_kind', true), '') = 'agent' then
    v_pid := nullif(current_setting('app.principal_id', true), '')::uuid;
    if not (new.template_key = 'TPL-01'
            and coalesce(new.word_count, 999999) <= 40
            and (select value from iam.global_switches where key = 'auto_publish_wires')
            and exists (select 1 from iam.agent_accounts a
                        where a.principal_id = v_pid and a.agent_class = 'PUBLISHING' and a.run_enabled)) then
      raise exception 'agents cannot publish (only TPL-01 wires <=40 words with auto_publish_wires on)';
    end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $$;
create trigger content_agent_publish_gate before update on public.content_items
  for each row execute function public.fn_enforce_agent_publish_gate();

create table public.content_tickers (
  content_id  uuid not null references public.content_items(id) on delete cascade,
  security_id bigint not null references public.securities(id),   -- R-02 resolvable-instrument check
  is_primary  boolean not null default false,
  primary key (content_id, security_id)
);

create table public.content_blocks (
  id              bigint generated always as identity primary key,
  content_id      uuid not null references public.content_items(id) on delete cascade,
  seq             int not null,
  block_kind      text not null,
  body            jsonb not null,
  bound_object_id uuid references lake.objects(id),
  gated           boolean not null default false,  -- THE premium gate; RLS hides gated rows from free/anon
  unique (content_id, seq)
);
create index content_blocks_gated_idx on public.content_blocks (content_id, seq);

create table public.content_corrections (
  id                 bigint generated always as identity primary key,
  content_id         uuid not null references public.content_items(id),
  note               text not null,
  correction_flag_id bigint,  -- FK to ops.correction_flags added in 0009
  appended_by        uuid not null references iam.principals(id),
  appended_at        timestamptz not null default now()
);
create trigger content_corrections_append_only before update or delete on public.content_corrections
  for each row execute function public.prevent_mutation();

create table public.content_revisions (
  id         bigint generated always as identity primary key,
  content_id uuid not null references public.content_items(id) on delete cascade,
  snapshot   jsonb not null,
  saved_by   uuid not null references iam.principals(id),
  saved_at   timestamptz not null default now()
);

create table public.content_attachments (
  id           bigint generated always as identity primary key,
  content_id   uuid not null references public.content_items(id) on delete cascade,
  storage_path text not null,
  filename     text not null,
  byte_size    int not null,
  members_only boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Citation graph (02 §5; created here because it FKs content_items).

create table lake.citations (
  id           bigint generated always as identity primary key,
  content_id   uuid not null references public.content_items(id) on delete cascade,
  object_id    uuid not null references lake.objects(id),
  block_key    text,
  claim_text   text,
  quoted_value text,
  cited_by     uuid not null references iam.principals(id),
  created_at   timestamptz not null default now()
);
create unique index citations_uni on lake.citations (content_id, object_id, coalesce(block_key,''));
create index citations_object_idx  on lake.citations (object_id);
create index citations_content_idx on lake.citations (content_id);

create or replace function lake.bump_cited_count() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update lake.objects set cited_count = cited_count + 1 where id = new.object_id;
    return new;
  else
    update lake.objects set cited_count = greatest(cited_count - 1, 0) where id = old.object_id;
    return old;
  end if;
end $$;
create trigger citations_bump_count after insert or delete on lake.citations
  for each row execute function lake.bump_cited_count();

-- ---------------------------------------------------------------------------
-- Versioned front page & nav configs (02 §10).

create table ops.front_page_versions (
  id         bigint generated always as identity primary key,
  version_no int not null unique,
  config     jsonb not null,
  is_live    boolean not null default false,
  actor_id   uuid not null references iam.principals(id),
  created_at timestamptz not null default now()
);
create unique index front_page_one_live on ops.front_page_versions (is_live) where is_live;

create table ops.nav_versions (
  id           bigint generated always as identity primary key,
  version_no   int not null unique,
  tabs         jsonb not null,   -- AR-LATER: label_ar keys inside the doc
  mobile_slots jsonb not null,
  is_live      boolean not null default false,
  actor_id     uuid not null references iam.principals(id),
  created_at   timestamptz not null default now()
);
create unique index nav_one_live on ops.nav_versions (is_live) where is_live;

-- World-readable mirror of the live nav row for the reader shell.
create view public.nav_config_live as
  select version_no, tabs, mobile_slots, created_at
  from ops.nav_versions
  where is_live;

-- ---------------------------------------------------------------------------
-- Analysts (02 §10).

create table public.analysts (
  principal_id      uuid primary key references iam.principals(id),
  title             text,
  credential        text,
  bio               text,
  is_external       boolean not null default false,
  revenue_share_pct numeric(5,2),   -- reserved (open question 13)
  joined_at         timestamptz not null default now()
);

create table public.analyst_calls (
  id                         bigint generated always as identity primary key,
  analyst_id                 uuid not null references public.analysts(principal_id),
  security_id                bigint not null references public.securities(id),
  rating                     text not null check (rating in ('STRONG_BUY','BUY','OVERWEIGHT','HOLD','UNDERWEIGHT','SELL')),
  price_target               numeric(18,6),
  published_at               timestamptz not null default now(),
  price_at_publication       numeric(18,6) not null,
  index_level_at_publication numeric(18,4) not null,
  content_id                 uuid references public.content_items(id),
  closed_at                  timestamptz,
  close_price                numeric(18,6),
  close_index_level          numeric(18,4),
  call_return_pct            numeric(9,4),
  vs_index_pct               numeric(9,4),
  review_due_at              timestamptz
);
create index analyst_calls_open_idx on public.analyst_calls (analyst_id) where closed_at is null;

-- Track record is immutable: only the close_*/review columns may ever change.
create or replace function public.fn_analyst_call_freeze() returns trigger
language plpgsql as $$
begin
  if new.analyst_id  is distinct from old.analyst_id
     or new.security_id  is distinct from old.security_id
     or new.rating       is distinct from old.rating
     or new.price_target is distinct from old.price_target
     or new.published_at is distinct from old.published_at
     or new.price_at_publication is distinct from old.price_at_publication
     or new.index_level_at_publication is distinct from old.index_level_at_publication
     or new.content_id   is distinct from old.content_id then
    raise exception 'analyst_calls rating/PT/publication anchors are frozen forever';
  end if;
  return new;
end $$;
create trigger analyst_calls_freeze before update on public.analyst_calls
  for each row execute function public.fn_analyst_call_freeze();
create trigger analyst_calls_no_delete before delete on public.analyst_calls
  for each row execute function public.prevent_mutation();

create table public.analyst_applications (
  id             bigint generated always as identity primary key,
  name           text not null,
  email          text not null,
  credentials    text,
  coverage_focus text,
  sample_thesis  text not null check (char_length(sample_thesis) <= 4000),
  status         text not null default 'submitted' check (status in ('submitted','in_review','accepted','rejected')),
  reviewed_by    uuid references iam.principals(id),
  submitted_at   timestamptz not null default now(),
  decided_at     timestamptz
);

-- Forward FK from 0005 now that content_items exists (02 §22 forward-reference rule).
alter table public.security_status
  add constraint security_status_linked_wire_fkey
  foreign key (linked_wire) references public.content_items(id);

-- Members-only model files (XLSX) — private, signed URLs, premium-checked server-side.
select ops.ensure_bucket('attachments', false);

-- ---------------------------------------------------------------------------
-- Registry seeds: TPL-01…TPL-08 and the 14 BLK-* story blocks.

insert into ops.templates (key, name, served_types, auto_select_rule, block_keys, auto_publish_eligible, always_premium, max_words) values
  ('TPL-01', 'Wire',              '{WIRE}',            'single-event wire; auto-publish <=40 words (D2)', '{BLK-TICKER,BLK-DELTA}',                                  true,  false, 40),
  ('TPL-02', 'Market Wrap',       '{ARTICLE}',         'session close recap per venue',                   '{BLK-TICKER,BLK-DELTA,BLK-TABLE,BLK-CHART}',              false, false, null),
  ('TPL-03', 'Earnings Recap',    '{ARTICLE}',         'earnings verdict set on earnings_events',         '{BLK-TICKER,BLK-VERDICT,BLK-TABLE,BLK-ESTIMATE,BLK-QUOTE}',false, false, null),
  ('TPL-04', 'Dividend Note',     '{ARTICLE,NOTE}',    'DIVIDEND.* object verified',                      '{BLK-TICKER,BLK-EXDATE,BLK-YIELD}',                       false, false, null),
  ('TPL-05', 'IPO Coverage',      '{ARTICLE}',         'IPO.* object or ipo_offers stage change',         '{BLK-TICKER,BLK-COVERAGE,BLK-TIMELINE}',                  false, false, null),
  ('TPL-06', 'Explainer',         '{EXPLAINER}',       'evergreen; quarterly desk review',                '{BLK-CHART,BLK-TABLE}',                                   false, false, null),
  ('TPL-07', 'Free + Marsad Take','{ARTICLE,TAKE}',    'free piece with premium Take blocks mid-sequence','{BLK-TICKER,BLK-SCORE,BLK-QUOTE}',                        false, false, null),
  ('TPL-08', 'Premium Deep Dive', '{ARTICLE}',         'always premium',                                  '{BLK-TICKER,BLK-CHART,BLK-TABLE,BLK-HOLDERS,BLK-ESTIMATE}',false, true,  null);

insert into ops.story_blocks (key, name, lake_object_type, consuming_templates, renderer_component) values
  ('BLK-TICKER',   'Ticker chip',            null,                  '{TPL-01,TPL-02,TPL-03,TPL-04,TPL-05,TPL-07,TPL-08}', 'BlockTicker'),
  ('BLK-DELTA',    'Price delta',            null,                  '{TPL-01,TPL-02}',                                    'BlockDelta'),
  ('BLK-EXDATE',   'Ex-date card',           'DIVIDEND.EXDATE',     '{TPL-04}',                                           'BlockExDate'),
  ('BLK-VERDICT',  'Earnings verdict',       'EARNINGS.VERDICT',    '{TPL-03}',                                           'BlockVerdict'),
  ('BLK-QUOTE',    'Transcript quote',       'TRANSCRIPT.QUOTE',    '{TPL-03,TPL-07}',                                    'BlockQuote'),
  ('BLK-TABLE',    'Data table',             null,                  '{TPL-02,TPL-03,TPL-06,TPL-08}',                      'BlockTable'),
  ('BLK-CHART',    'Chart embed',            null,                  '{TPL-02,TPL-06,TPL-08}',                             'BlockChart'),
  ('BLK-SCORE',    'Marsad Score chip',      'COMPUTED.SCORE',      '{TPL-07}',                                           'BlockScore'),
  ('BLK-YIELD',    'Yield card',             'COMPUTED.YIELD',      '{TPL-04}',                                           'BlockYield'),
  ('BLK-COVERAGE', 'IPO coverage multiples', 'IPO.COVERAGE',        '{TPL-05}',                                           'BlockCoverage'),
  ('BLK-TIMELINE', 'IPO timeline',           'IPO.TIMELINE',        '{TPL-05}',                                           'BlockTimeline'),
  ('BLK-HOLDERS',  'Holders matrix',         'OWNERSHIP.SNAPSHOT',  '{TPL-08}',                                           'BlockHolders'),
  ('BLK-ESTIMATE', 'Estimate vs actual',     'ESTIMATE.OBS',        '{TPL-03,TPL-08}',                                    'BlockEstimate'),
  ('BLK-FILING',   'Filing reference',       'FILING.FINANCIALS',   '{TPL-03,TPL-08}',                                    'BlockFiling');

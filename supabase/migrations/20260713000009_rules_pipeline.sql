-- 0009_rules_pipeline — versioned rules engine config (seed V9), violations,
-- agent runs, newsroom pipeline, error queue, correction flags + R-07 trigger.
-- 02 §11, §12, §5, §22 step 9.

create table ops.rulesets (
  version_no  int primary key,
  deployed_by uuid not null references iam.principals(id),
  deployed_at timestamptz not null default now(),
  is_live     boolean not null default false,
  config      jsonb not null
);
create unique index rulesets_one_live on ops.rulesets (is_live) where is_live;

create table ops.rules (
  ruleset_version int not null references ops.rulesets(version_no),
  rule_key        text not null,
  title           text not null,
  body            text not null,
  scope           text not null default 'ALL' check (scope in ('ALL','NOTES_TAKES','PREMIUM')),
  enforcement     text not null check (enforcement in ('BLOCK','WARN','AUTO_FIX','AUTO')),
  enabled         boolean not null default true,
  params          jsonb not null default '{}',
  primary key (ruleset_version, rule_key)
);

create table ops.banned_phrases (
  id       bigint generated always as identity primary key,
  phrase   text not null,
  lang     char(2) not null default 'en',   -- AR-LATER: 'ar' rows
  added_by uuid not null references iam.principals(id),
  added_at timestamptz not null default now(),
  unique (phrase, lang)
);

create table ops.rule_violations (
  id              bigint generated always as identity primary key,
  content_id      uuid references public.content_items(id),
  ad_creative_id  bigint,   -- FK to ops.ad_creatives added in 0012
  ruleset_version int not null,
  rule_key        text not null,
  outcome         text not null check (outcome in ('blocked','warned','auto_fixed','passed_after_fix')),
  detail          jsonb,
  actor_id        uuid not null references iam.principals(id),
  occurred_at     timestamptz not null default now(),
  foreign key (ruleset_version, rule_key) references ops.rules(ruleset_version, rule_key)
);
create index rule_violations_time on ops.rule_violations (occurred_at desc);

-- ---------------------------------------------------------------------------
-- Agent runs, pipeline, errors (02 §12).

create table ops.agent_runs (
  id           bigint generated always as identity primary key,
  agent_id     uuid not null references iam.principals(id),
  task_key     text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','killed')),
  parse_run_id bigint references lake.parse_runs(id),
  stats        jsonb not null default '{}',
  error        text
);
create index agent_runs_agent_time on ops.agent_runs (agent_id, started_at desc);

-- 27a live run log = pg_notify stream tailed over Realtime broadcast; agent_runs
-- is the replayable history (02 §12) — no extra table.
create or replace function ops.fn_agent_run_notify() returns trigger
language plpgsql as $$
begin
  perform pg_notify('agent-run-log', json_build_object(
    'id', new.id, 'agent_id', new.agent_id, 'task_key', new.task_key,
    'status', new.status, 'at', now())::text);
  return null;
end $$;
create trigger agent_runs_notify after insert or update on ops.agent_runs
  for each row execute function ops.fn_agent_run_notify();

create table ops.pipeline_items (
  id                bigint generated always as identity primary key,
  content_id        uuid not null references public.content_items(id) on delete cascade,
  stage             text not null default 'queued' check (stage in
                    ('queued','draft','edit','rules','approval','published','sent_back','reassigned_human')),
  writer_agent      uuid references iam.principals(id),
  editor_agent      uuid references iam.principals(id),
  confidence        numeric(4,3),
  queued_at         timestamptz not null default now(),
  stage_entered_at  timestamptz not null default now(),
  approval_sla      interval not null default '3 minutes',
  approval_decision text check (approval_decision in ('publish_now','publish_at','send_back','reassign_human')),
  decided_by        uuid references iam.principals(id),
  decided_at        timestamptz,
  send_back_note    text
);
create index pipeline_open_idx on ops.pipeline_items (stage, queued_at)
  where stage not in ('published','reassigned_human');

create table ops.agent_errors (
  id           bigint generated always as identity primary key,
  agent_id     uuid not null references iam.principals(id),
  agent_run_id bigint references ops.agent_runs(id),
  severity     text not null check (severity in ('infra','quality')),
  error_type   text not null,
  detail       jsonb,
  retry_count  int not null default 0,
  status       text not null default 'open' check (status in ('open','retrying','muted','resolved','escalated_human')),
  muted_until  timestamptz,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index agent_errors_open on ops.agent_errors (created_at) where status in ('open','retrying');

-- ---------------------------------------------------------------------------
-- R-07 correction fan-out (02 §5, post-review fix #3).

create table ops.correction_flags (
  id          bigint generated always as identity primary key,
  content_id  uuid not null references public.content_items(id),
  revision_id bigint not null references lake.object_revisions(id),
  status      text not null default 'open' check (status in ('open','note_drafted','resolved','dismissed')),
  resolved_by uuid references iam.principals(id),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index correction_flags_open_idx on ops.correction_flags (created_at) where status = 'open';

-- Fan-out reaches live/updated pieces AND pending pieces that cite or
-- block-bind any revision of the corrected natural key.
create or replace function lake.fn_r07_fanout() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into ops.correction_flags (content_id, revision_id)
  select distinct x.content_id, new.id
  from (
    select c.content_id
    from lake.objects o
    join lake.citations c on c.object_id = o.id
    where o.natural_key = new.natural_key
    union
    select cb.content_id
    from lake.objects o
    join public.content_blocks cb on cb.bound_object_id = o.id
    where o.natural_key = new.natural_key
  ) x
  join public.content_items ci on ci.id = x.content_id
  where ci.status in ('live','updated','draft','in_review','rules_check','approval','scheduled');
  return null;
end $$;

create trigger object_revisions_r07 after insert on lake.object_revisions
  for each row execute function lake.fn_r07_fanout();

-- Deferred FK from 0008.
alter table public.content_corrections
  add constraint content_corrections_flag_fkey
  foreign key (correction_flag_id) references ops.correction_flags(id);

-- ---------------------------------------------------------------------------
-- Seed: ruleset V9 live, R-01…R-10, starter banned phrases.

insert into ops.rulesets (version_no, deployed_by, is_live, config)
values (9, (select id from iam.principals where handle = 'SYSTEM'), true,
        '{"beat_threshold_pct": 2.0, "miss_threshold_pct": -2.0, "numeric_tolerance_pct": 0.5}');

insert into ops.rules (ruleset_version, rule_key, title, body, scope, enforcement, params) values
  (9, 'R-01', 'Source or silence',        'Every factual claim must trace to a VERIFIED lake object or named public source.', 'ALL', 'BLOCK', '{}'),
  (9, 'R-02', 'Resolvable instruments',   'Every ticker mention must resolve to a listed security (content_tickers FK).',     'ALL', 'BLOCK', '{}'),
  (9, 'R-03', 'Cite what you claim',      'Numeric claims in body copy must carry a citation to the backing object.',         'ALL', 'BLOCK', '{}'),
  (9, 'R-04', 'Numbers match the lake',   'Quoted figures must match the cited object within tolerance.',                     'ALL', 'BLOCK', '{"tolerance_pct": 0.5}'),
  (9, 'R-05', 'Banned phrases',           'No phrase from the lexicon (also screens ad creatives).',                          'ALL', 'BLOCK', '{}'),
  (9, 'R-06', 'No advice',                'No investment advice, price predictions as fact, or solicitation.',                'ALL', 'BLOCK', '{}'),
  (9, 'R-07', 'Visible corrections',      'Corrected objects fan out flags; corrections are appended notes, never silent rewrites.', 'ALL', 'AUTO', '{}'),
  (9, 'R-08', 'Retractions stay live',    'Retracted URLs remain reachable with a retraction notice.',                        'ALL', 'AUTO', '{}'),
  (9, 'R-09', 'Disclose ratings',         'Pieces carrying a rating attachment must render the disclosure block.',            'ALL', 'WARN', '{}'),
  (9, 'R-10', 'Headline ceiling',         'Headlines are hard-capped at 90 characters (DB CHECK backstop).',                  'ALL', 'BLOCK', '{"max_chars": 90}');

insert into ops.banned_phrases (phrase, added_by)
select p, (select id from iam.principals where handle = 'SYSTEM')
from unnest(array[
  'guaranteed returns', 'cannot lose', 'sure thing', 'insider information',
  'buy now before it''s too late', 'to the moon'
]) as p;

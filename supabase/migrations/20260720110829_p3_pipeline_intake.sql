-- 20260720110829_p3_pipeline_intake — P3.1: the newsroom pipeline FRONT DOOR.
-- A VERIFIED lake object → pgmq q_pipeline{stage:classify} → (classify handler, P3.3) →
-- deterministic materiality pre-filter (this migration owns the config + the SQL fn) →
-- material ⇒ a content stub + an ops.pipeline_items row on the conveyor.
--
-- This migration builds the DETERMINISTIC + STATE-MACHINE half (no LLM): the trigger,
-- the pre-filter config + fn, the classifier audit table, the pipeline_items extensions,
-- and fn_transition (the DB-enforced stage adjacency — illegal transitions RAISE, so the
-- conveyor is correct even against a buggy worker). The LLM classifier tier + the four
-- stage handlers are P3.3 (worker TS).
--
-- Auto-publish starts OFF (owner decision 2026-07-19): every wire routes to the approval
-- queue until the pipeline proves itself over the first N pieces; flip the switch to arm
-- the human-free path. The seed had it true — this migration makes OFF the from-scratch default.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 0. Auto-publish OFF by default (owner steer). One-line flip to re-arm.
-- ---------------------------------------------------------------------------
update iam.global_switches set value = false where key = 'auto_publish_wires';

-- Intake kill-switch: the enqueue trigger is a NO-OP until this is flipped true (armed
-- when the P3.3 classify handler is deployed). Prevents q_pipeline accumulating a backlog
-- with no consumer during the current heavy ingest window. Same config-gated-activation
-- discipline as the ingest fleet.
insert into iam.global_switches (key, value, changed_by)
values ('pipeline_intake_enabled', false, (select id from iam.principals where handle = 'SYSTEM'))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Materiality pre-filter config (§6.1) — object_type pattern → verdict.
--    "roughly half of intake" resolves here at $0 before any model is touched.
-- ---------------------------------------------------------------------------
create table ops.materiality_prefilter (
  id            bigint generated always as identity primary key,
  object_type   text not null,          -- exact lake.objects.object_type match
  verdict       text not null check (verdict in ('material', 'not_material', 'ambiguous')),
  priority      text check (priority in ('wire', 'story', 'watch')),   -- null unless material
  template_hint text references ops.templates(key),
  note          text,
  unique (object_type)
);

comment on table ops.materiality_prefilter is
  'P3 §6.1 deterministic classifier tier. object_type not listed ⇒ ambiguous ⇒ LLM classifier.';

insert into ops.materiality_prefilter (object_type, verdict, priority, template_hint, note) values
  ('DIVIDEND.EXDATE',    'material',     'wire',  'TPL-04', 'dividend declared / ex-date → wire + dividend note'),
  ('DISCLOSURE.DPS',     'material',     'wire',  'TPL-01', 'DPS change → wire'),
  ('FILING.FINANCIALS',  'material',     'story', 'TPL-03', 'period-end results → earnings recap'),
  ('EARNINGS.VERDICT',   'material',     'story', 'TPL-03', 'earnings verdict set → recap'),
  ('IPO.OFFER',          'material',     'wire',  'TPL-07', 'IPO offer state change'),
  ('COMPUTED.SCORE',     'not_material', null,    null,     'score recompute is never newsworthy alone'),
  ('COMPUTED.YIELD',     'not_material', null,    null,     'derived recompute, never material alone'),
  ('QUOTE.LAST',         'not_material', null,    null,     'price tick — never material alone'),
  ('OHLCV.CLOSE',        'not_material', null,    null,     'daily bar — never material alone'),
  ('FILING.REF',         'ambiguous',    null,    null,     'bare filing ref → LLM classifier on title/facts'),
  ('PROFILE.SECURITY',   'not_material', null,    null,     'identity backfill — never a story');

-- ---------------------------------------------------------------------------
-- 2. classifier_verdicts — the audit trail of EVERY triage decision, incl.
--    negatives (§6.2: "what the newsroom chose to ignore" is queryable).
-- ---------------------------------------------------------------------------
create table ops.classifier_verdicts (
  id                bigint generated always as identity primary key,
  lake_object_id    uuid not null references lake.objects(id),
  object_type       text not null,
  security_id       bigint references public.securities(id),
  tier              text not null check (tier in ('prefilter', 'llm')),
  verdict           text not null check (verdict in ('material', 'not_material', 'ambiguous')),
  priority          text check (priority in ('wire', 'story', 'watch')),
  event_type        text,
  suggested_template text references ops.templates(key),
  confidence        numeric(4,3),        -- null for the deterministic tier
  reason            text,
  pipeline_item_id  bigint references ops.pipeline_items(id),  -- set when it spawned a piece
  llm_run_id        uuid,                -- ops.llm_runs id when the LLM tier ran
  created_at        timestamptz not null default now()
);
create index classifier_verdicts_obj on ops.classifier_verdicts (lake_object_id, created_at desc);
create index classifier_verdicts_watch on ops.classifier_verdicts (created_at desc)
  where priority = 'watch';

alter table ops.classifier_verdicts enable row level security;
grant select, insert on ops.classifier_verdicts to marsad_worker;
grant select on ops.classifier_verdicts to service_role;

-- ---------------------------------------------------------------------------
-- 3. pipeline_items extensions — carry the trigger object + retry/loop state
--    the §9 conveyor needs (the seed row had only the happy-path columns).
-- ---------------------------------------------------------------------------
alter table ops.pipeline_items
  add column if not exists trigger_object_id uuid references lake.objects(id),
  add column if not exists priority          text check (priority in ('wire', 'story', 'watch')),
  add column if not exists template_hint     text references ops.templates(key),
  add column if not exists rules_fail_loops  int not null default 0,
  add column if not exists attempts          int not null default 0,
  add column if not exists next_retry_at     timestamptz,
  add column if not exists rules_passed_version int;

-- 'dead' terminal stage for the infra dead-letter (§9.2 — never a delete).
alter table ops.pipeline_items drop constraint if exists pipeline_items_stage_check;
alter table ops.pipeline_items add constraint pipeline_items_stage_check check (stage in
  ('queued','draft','edit','rules','approval','published','sent_back','reassigned_human','dead'));

-- Approval SLA: 3 HOURS (Revision #6 supersedes the seeded '3 minutes' body value).
alter table ops.pipeline_items alter column approval_sla set default '3 hours';

create index if not exists pipeline_items_stage_idx on ops.pipeline_items (stage, stage_entered_at)
  where stage not in ('published','dead','reassigned_human');
create index if not exists pipeline_items_retry_idx on ops.pipeline_items (next_retry_at)
  where next_retry_at is not null;

-- ---------------------------------------------------------------------------
-- 4. fn_transition — the ONE stage-mover. Validates a static adjacency map,
--    stamps the row, and logs the transition to ops.agent_runs. Illegal moves
--    RAISE — the state machine is enforced in the DB, not worker discipline (§9.1).
-- ---------------------------------------------------------------------------
create or replace function ops.fn_transition(
  p_item bigint, p_to text, p_actor uuid, p_detail jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_from text;
  v_ok   boolean;
begin
  select stage into v_from from ops.pipeline_items where id = p_item for update;
  if not found then raise exception 'fn_transition: pipeline_item % not found', p_item; end if;
  if v_from = p_to then return; end if;  -- idempotent no-op (redelivered message)

  v_ok := case v_from
    when 'queued'   then p_to in ('draft','dead')
    when 'draft'    then p_to in ('edit','dead','reassigned_human')
    when 'edit'     then p_to in ('rules','dead','reassigned_human')
    when 'rules'    then p_to in ('approval','published','draft','reassigned_human','dead')
    when 'approval' then p_to in ('published','sent_back','reassigned_human')
    when 'sent_back' then p_to in ('draft')
    else false  -- published / reassigned_human / dead are terminal
  end;
  if not v_ok then
    raise exception 'fn_transition: illegal % -> % for pipeline_item %', v_from, p_to, p_item;
  end if;

  update ops.pipeline_items
     set stage = p_to, stage_entered_at = now()
   where id = p_item;

  insert into ops.agent_runs (agent_id, task_key, status, finished_at, stats)
  values (p_actor, 'pipeline:transition', 'succeeded', now(),
          jsonb_build_object('pipeline_item_id', p_item, 'from', v_from, 'to', p_to) || coalesce(p_detail, '{}'::jsonb));
end $$;

grant execute on function ops.fn_transition(bigint, text, uuid, jsonb) to marsad_worker;

-- ---------------------------------------------------------------------------
-- 5. The intake trigger — a VERIFIED lake object enqueues a classify message.
--    BOTH arms (Revision #4): UPDATE→VERIFIED and INSERT-already-VERIFIED (a
--    backfill/re-scrape can insert a row already VERIFIED). Deterministically
--    not-material types are skipped at the trigger (no queue spam) using the
--    pre-filter config; everything else is enqueued for the classify handler.
-- ---------------------------------------------------------------------------
create or replace function lake.fn_verified_enqueue() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_verdict text;
begin
  if new.state <> 'VERIFIED' then return null; end if;
  -- Gated off until the classify handler is live (no consumer ⇒ no enqueue).
  if not coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    return null;
  end if;

  -- Cheap trigger-time drop of the never-material types (QUOTE/OHLCV/SCORE/…) so the
  -- queue only carries plausible stories; the handler still re-checks + logs a verdict.
  select verdict into v_verdict from ops.materiality_prefilter where object_type = new.object_type;
  if v_verdict = 'not_material' then return null; end if;

  perform pgmq.send('q_pipeline', jsonb_build_object(
    'stage', 'classify',
    'lake_object_id', new.id,
    'object_type', new.object_type,
    'security_id', new.security_id,
    'venue', new.venue_code
  ));
  return null;
end $$;

drop trigger if exists objects_verified_enqueue_upd on lake.objects;
create trigger objects_verified_enqueue_upd after update on lake.objects
  for each row when (old.state is distinct from new.state and new.state = 'VERIFIED')
  execute function lake.fn_verified_enqueue();

drop trigger if exists objects_verified_enqueue_ins on lake.objects;
create trigger objects_verified_enqueue_ins after insert on lake.objects
  for each row when (new.state = 'VERIFIED')
  execute function lake.fn_verified_enqueue();

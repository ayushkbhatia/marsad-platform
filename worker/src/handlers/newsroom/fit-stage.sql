-- newsroom_fit_stage — the DDL PD.8's fit stage needs.
--
-- ⚠️ WRITTEN, NOT APPLIED, AND NOT YET IN supabase/migrations/.
--    It lives beside the code that needs it because two other agents hold
--    `supabase/migrations.ledger` in this worktree, and a .sql that CI's ledger check
--    cannot see is a broken build for them (scripts/check-migration-ledger.mjs fails when
--    supabase/migrations/*.sql and the ledger diverge).
--
--    TO APPLY: move this file to
--      supabase/migrations/<yyyymmddhhmmss>_newsroom_fit_stage.sql
--    then reconcile the ledger (`node scripts/check-migration-ledger.mjs --write`) and apply.
--    Nothing else has to change: the worker code is already deployable against a database
--    WITHOUT this migration (see below), so applying it is the switch, not a cutover.
--
-- WHY THE STAGE IS INERT UNTIL THIS LANDS. `ops.pipeline_items.stage` is a CHECK'd enum
-- and `ops.fn_transition` hard-codes the adjacency, so `rules → fit` raises until §1/§2
-- run. The worker therefore gates the hand-off on the switch seeded in §3 — and
-- `switchOn()` reads a MISSING key as false, so today (no row, no migration) the rules
-- stage keeps its existing `rules → approval | published` routing untouched, and
-- pipeline_fit is registered but never enqueued. §4's report table is probed with
-- to_regclass before every write for the same reason.
--
-- WHY fit SITS BETWEEN rules AND approval. rules judges the PROSE (R-01..R-10). fit judges
-- the COMPOSITION against ops.story_blocks — vocabulary, piece-type permission, binding,
-- prose-vs-object arithmetic, per-block constraints, the premium cut. Auto-publish is
-- routed THROUGH fit rather than around it: the human-free wire path is exactly the one
-- that needs a refusal surface most.
--
-- WHY NOT ops.rule_violations FOR THE REPORT. `rule_violations.rule_key` is FK'd to
-- `ops.rules(ruleset_version, rule_key)`, so a FIT-* code cannot be written there without
-- seeding a parallel ruleset — which would also blur "the prose broke R-04" into "the
-- composition broke". Fit gets its own table; the transition detail (→ ops.agent_runs.stats)
-- carries the evidence in either case.

begin;

-- 1) `fit` becomes a legal stage. ----------------------------------------------------
alter table ops.pipeline_items drop constraint if exists pipeline_items_stage_check;
alter table ops.pipeline_items add constraint pipeline_items_stage_check
  check (stage = any (array['queued','draft','edit','rules','fit','approval','published',
                           'sent_back','reassigned_human','dead']));

-- 2) Adjacency. rules gains `fit`; fit inherits the routing rules used to own, plus the
--    refusal exit (`reassigned_human`). rules → approval/published is KEPT so the switch
--    can be turned off again without a second migration.
create or replace function ops.fn_transition(p_item bigint, p_to text, p_actor uuid, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from text;
  v_ok   boolean;
begin
  select stage into v_from from ops.pipeline_items where id = p_item for update;
  if not found then raise exception 'fn_transition: pipeline_item % not found', p_item; end if;
  if v_from = p_to then return; end if;

  v_ok := case v_from
    when 'queued'   then p_to in ('draft','dead')
    when 'draft'    then p_to in ('edit','dead','reassigned_human')
    when 'edit'     then p_to in ('rules','dead','reassigned_human')
    when 'rules'    then p_to in ('fit','approval','published','draft','reassigned_human','dead')
    when 'fit'      then p_to in ('approval','published','draft','reassigned_human','dead')
    when 'approval' then p_to in ('published','sent_back','reassigned_human')
    when 'sent_back' then p_to in ('draft')
    else false
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
end $function$;

-- 3) The switch. OFF on arrival — applying the migration must not silently start
--    refusing pieces; an operator turns it on.
insert into iam.global_switches (key, value) values ('newsroom_fit_stage', false)
on conflict (key) do nothing;

-- 4) The report table — the Desk's read surface for a refusal.
create table if not exists ops.fit_reports (
  id               bigserial primary key,
  pipeline_item_id bigint not null references ops.pipeline_items(id) on delete cascade,
  content_id       uuid   not null references public.content_items(id) on delete cascade,
  passed           boolean not null,
  refusals         jsonb  not null default '[]'::jsonb,
  warnings         jsonb  not null default '[]'::jsonb,
  unchecked        jsonb  not null default '[]'::jsonb,
  cut              jsonb  not null default '{}'::jsonb,
  stats            jsonb  not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists fit_reports_item on ops.fit_reports (pipeline_item_id, created_at desc);
create index if not exists fit_reports_open on ops.fit_reports (created_at desc) where not passed;

comment on table ops.fit_reports is
  'PD.8 fit stage output: one row per composition check. refusals[] carries {code, block_code, seq, rule, evidence}; unchecked[] carries what could not be judged deterministically (a silent skip reads as a pass).';

grant select, insert on ops.fit_reports to marsad_worker;
grant usage, select on sequence ops.fit_reports_id_seq to marsad_worker;

commit;

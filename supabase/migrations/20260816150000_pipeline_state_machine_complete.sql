-- The newsroom state machine, completed in ONE place.
--
-- ── WHY ONE MIGRATION ─────────────────────────────────────────────────────────
-- Three separate workstreams each need to `create or replace ops.fn_transition`:
--   · PD.8 fit          — adds the `fit` stage (worker/src/handlers/newsroom/fit-stage.sql,
--                         written 2026-07 and never applied)
--   · P5.9 research     — adds a deterministic evidence-gathering stage before draft
--   · the resume path   — adds the missing exit from `reassigned_human`
-- Whichever landed last would silently delete the others' arms, because each is a full
-- redefinition of one function. So all of them land here, once, and the individual
-- workstreams ship code against a machine that already models their stage.
--
-- ── THE BUG THIS FIXES TODAY ──────────────────────────────────────────────────
-- `reassigned_human` has no `when` arm, so it falls to `else false` and EVERY transition
-- out of it raises. It is where the machine sends a piece it cannot fix — and it is a
-- one-way door. Items 3 and 4 have been frozen there since 2026-07-20 with no assignee,
-- no note, and no surface listing them; nothing in the codebase can move them.
--
-- Compare `sent_back`, which has `p_to in ('draft')`. The design gave the HUMAN send-back
-- path a way home and gave the MACHINE escalation path none — so the queue that fills
-- when the robot gives up is precisely the one a human cannot work.
--
-- ── THE STAGES, AND WHY THEY SIT WHERE THEY DO ────────────────────────────────
--   research  after queued, before draft — deterministic SQL evidence bundles, no LLM.
--             The writer currently researches, analyses, edits and lays out in one call.
--   compose   after edit, before rules — turns prose into bound BLK-* blocks. AFTER edit
--             because edit sets template_key (which fixes the legal block vocabulary), and
--             BEFORE rules so R-01..R-10 judge the prose that actually ships.
--   fit       after rules, before approval — rules judges the PROSE, fit judges the
--             COMPOSITION. Auto-publish routes THROUGH fit: the human-free wire path is
--             the one that needs a refusal surface most.
--
-- Every new stage keeps the OLD edge alongside the new one (`edit → rules` survives
-- `edit → compose`), so each stage's switch can be turned off again without a second
-- migration. All three switches arrive OFF: applying this must not change any routing.

-- ─── 1. The legal stage set ───────────────────────────────────────────────────
alter table ops.pipeline_items drop constraint if exists pipeline_items_stage_check;
alter table ops.pipeline_items add constraint pipeline_items_stage_check
  check (stage = any (array['queued','research','draft','edit','compose','rules','fit',
                            'approval','published','sent_back','reassigned_human','dead']));

-- ─── 2. The adjacency, complete ───────────────────────────────────────────────
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
    when 'queued'            then p_to in ('research','draft','dead')
    when 'research'          then p_to in ('draft','dead','reassigned_human')
    when 'draft'             then p_to in ('edit','dead','reassigned_human')
    when 'edit'              then p_to in ('compose','rules','dead','reassigned_human')
    when 'compose'           then p_to in ('rules','draft','dead','reassigned_human')
    when 'rules'             then p_to in ('fit','approval','published','draft','reassigned_human','dead')
    when 'fit'               then p_to in ('approval','published','draft','reassigned_human','dead')
    when 'approval'          then p_to in ('published','sent_back','reassigned_human')
    when 'sent_back'         then p_to in ('draft')
    -- The recovery edge. Deliberately narrow: a human either sends it back to be
    -- redrafted or kills it. It may NOT jump to approval — nothing has re-judged the
    -- piece, and letting a stuck item skip the ruleset is how an unchecked piece
    -- reaches the site. Authorisation lives in ops.desk_resume_item, not here:
    -- fn_transition is actor-agnostic and every stage handler calls it.
    when 'reassigned_human'  then p_to in ('draft','dead')
    else false   -- 'published' and 'dead' are terminal, by design
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

-- ─── 3. Stage switches — all OFF ──────────────────────────────────────────────
-- changed_by is NOT NULL — the unapplied fit-stage.sql omits it and would have failed on
-- contact, which is one more reason that file never proved itself against a real database.
insert into iam.global_switches (key, value, changed_by)
select k, false, (select id from iam.principals where handle = 'SYSTEM')
  from unnest(array['newsroom_research_stage','newsroom_compose_stage','newsroom_fit_stage']) as k
on conflict (key) do nothing;

-- ─── 4. The fit report surface (from fit-stage.sql, verbatim intent) ──────────
-- Not ops.rule_violations: its rule_key is FK'd to ops.rules(ruleset_version, rule_key),
-- so a FIT-* code cannot be written there without seeding a parallel ruleset — and it
-- would blur "the prose broke R-04" into "the composition broke".
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
alter table ops.fit_reports enable row level security;   -- 02 §19, private schema

comment on table ops.fit_reports is
  'PD.8 fit stage output: one row per composition check. refusals[] carries '
  '{code, block_code, seq, rule, evidence}; unchecked[] carries what could not be judged '
  'deterministically — a silent skip reads as a pass, so it is recorded separately.';

grant select, insert on ops.fit_reports to marsad_worker;
grant usage, select on sequence ops.fit_reports_id_seq to marsad_worker;

-- ─── 5. Who may resume a stuck piece ──────────────────────────────────────────
-- Mirrors the approvals split: the owner can do anything; an EIC can work this queue
-- WITHOUT gaining publish rights, which is the whole point of separating them.
insert into iam.capability_grants (role_key, capability, grant_kind, condition) values
  ('owner', 'pipeline.resume', 'full', null),
  ('eic',   'pipeline.resume', 'full', null)
on conflict do nothing;

-- ─── 6. The resume RPC ────────────────────────────────────────────────────────
create or replace function ops.desk_resume_item(p_item bigint, p_action text, p_note text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.principal_id', true), '')::uuid;
  v_role  text;
  v_stage text;
  v_cid   uuid;
begin
  if v_actor is null then raise exception 'desk_resume_item: no app.principal_id set'; end if;
  if p_action not in ('retry','retry_with_guidance','kill') then
    raise exception 'desk_resume_item: bad action %', p_action;
  end if;
  -- A note is mandatory. An escalation queue whose exits are unexplained becomes a
  -- second silent hole, which is the failure this whole migration is closing.
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'desk_resume_item: % requires a note', p_action;
  end if;

  select rg.role_key into v_role from iam.role_grants rg
   where rg.principal_id = v_actor
     and rg.role_key in (select role_key from iam.capability_grants where capability = 'pipeline.resume')
   order by case rg.role_key when 'owner' then 0 when 'eic' then 1 else 2 end limit 1;
  if v_role is null then raise exception 'desk_resume_item: actor holds no pipeline.resume role'; end if;

  select stage, content_id into v_stage, v_cid from ops.pipeline_items where id = p_item for update;
  if not found then raise exception 'desk_resume_item: item % not found', p_item; end if;
  if v_stage <> 'reassigned_human' then
    raise exception 'desk_resume_item: item % is at %, not reassigned_human', p_item, v_stage;
  end if;

  if p_action = 'kill' then
    perform ops.fn_transition(p_item, 'dead', v_actor, jsonb_build_object('action','kill','note',p_note));
    return 'dead';
  end if;

  -- Reset the loop counter: the piece is being given a genuinely fresh set of attempts,
  -- and leaving rules_fail_loops at its cap would escalate again on the first block.
  update ops.pipeline_items
     set rules_fail_loops = 0,
         attempts         = 0,
         next_retry_at    = null,
         decided_by       = v_actor,
         decided_at       = now(),
         -- draft.ts reads send_back_note as an authoritative desk instruction and puts it
         -- above the machine-generated revision brief.
         send_back_note   = case when p_action = 'retry_with_guidance' then p_note else send_back_note end
   where id = p_item;

  update public.content_items set status = 'draft' where id = v_cid and status <> 'live';

  perform ops.fn_transition(p_item, 'draft', v_actor,
    jsonb_build_object('action', p_action, 'note', p_note, 'resumed_by_role', v_role));
  perform pgmq.send('q_pipeline', jsonb_build_object('handler','pipeline_draft','pipeline_item_id',p_item));
  return 'draft';
end $$;

grant execute on function ops.desk_resume_item(bigint, text, text) to authenticated, service_role;

create or replace function public.desk_resume(p_item bigint, p_action text, p_note text default null)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid;
begin
  select id into v_owner from iam.principals where handle = 'DESK-OWNER';
  if v_owner is null then raise exception 'desk_resume: DESK-OWNER principal missing'; end if;
  perform set_config('app.principal_id', v_owner::text, true);
  return ops.desk_resume_item(p_item, p_action, p_note);
end $$;

revoke all on function public.desk_resume(bigint, text, text) from public, anon, authenticated;
grant execute on function public.desk_resume(bigint, text, text) to service_role;

-- ─── 7. The queue nobody could see ────────────────────────────────────────────
create or replace view public.v_desk_stuck
with (security_invoker = true) as
select pi.id                         as item_id,
       pi.content_id,
       pi.stage,
       pi.priority,
       pi.template_hint,
       pi.rules_fail_loops,
       pi.stage_entered_at,
       (extract(epoch from (now() - pi.stage_entered_at)) / 86400)::numeric(10,1) as age_days,
       ci.headline,
       ci.dek,
       ci.word_count,
       ci.status                     as content_status,
       -- The reason the machine gave up is already recorded on the transition; nothing
       -- has ever read it. Lifting it here is what turns a frozen row into a work item.
       (select ar.stats ->> 'reason' from ops.agent_runs ar
         where ar.task_key = 'pipeline:transition'
           and (ar.stats ->> 'pipeline_item_id')::bigint = pi.id
           and ar.stats ->> 'to' = 'reassigned_human'
         order by ar.finished_at desc limit 1) as reason,
       (select ar.stats -> 'rules_failed' from ops.agent_runs ar
         where ar.task_key = 'pipeline:transition'
           and (ar.stats ->> 'pipeline_item_id')::bigint = pi.id
           and ar.stats ->> 'to' = 'reassigned_human'
         order by ar.finished_at desc limit 1) as rules_failed,
       pi.send_back_note
  from ops.pipeline_items pi
  join public.content_items ci on ci.id = pi.content_id
 where pi.stage = 'reassigned_human'
    or (pi.stage in ('research','draft','edit','compose','rules','fit')
        and pi.stage_entered_at < now() - interval '2 hours');

comment on view public.v_desk_stuck is
  'Pieces the conveyor cannot move: everything at reassigned_human, plus anything sitting '
  'in a working stage for over 2h. security_invoker so the admin service-role client reads '
  'it and anon cannot. The reason/rules_failed columns are lifted out of '
  'ops.agent_runs.stats, where the machine has always written them and nothing has read them.';

grant select on public.v_desk_stuck to service_role;

-- ─── 8. Assertions ────────────────────────────────────────────────────────────
do $$
declare v_n int;
begin
  -- The recovery edge must exist. Proved by behaviour, not by reading the source.
  begin
    perform ops.fn_transition(-1, 'draft', null);
    raise exception 'fn_transition accepted a non-existent item';
  exception
    when others then
      if position('not found' in sqlerrm) = 0 then
        raise exception 'unexpected fn_transition failure: %', sqlerrm;
      end if;
  end;

  select count(*) into v_n from iam.capability_grants where capability = 'pipeline.resume';
  if v_n < 2 then raise exception 'pipeline.resume granted to % roles, expected 2', v_n; end if;

  -- Every stage the adjacency can route TO must be legal under the CHECK, or a transition
  -- the function permits gets rejected by the constraint at write time — the failure mode
  -- that made `fit` unreachable even after its handler shipped.
  declare
    v_check text;
    v_stage text;
  begin
    select pg_get_constraintdef(oid) into v_check
      from pg_constraint where conname = 'pipeline_items_stage_check';
    foreach v_stage in array array['queued','research','draft','edit','compose','rules','fit',
                                   'approval','published','sent_back','reassigned_human','dead']
    loop
      if position('''' || v_stage || '''' in v_check) = 0 then
        raise exception 'stage % is routable but not permitted by pipeline_items_stage_check', v_stage;
      end if;
    end loop;
  end;
end $$;

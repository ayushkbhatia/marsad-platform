-- 20260720142331_p3_4_sweeps_approval_budget — P3.4: the conveyor's tail — approval
-- decisions, the publish/SLA/stalled sweeps, and the LLM budget ladder. All SQL +
-- pg_cron (no worker deploy). Plus the ops.llm_runs RLS policy fix so newsroom LLM
-- spend is finally accounted (the Phase D migration granted INSERT but the table has
-- RLS on with no worker policy — every insert was silently RLS-blocked).

set search_path = '';

-- ---------------------------------------------------------------------------
-- 0. Fix ops.llm_runs accounting (RLS policy — grant alone is not enough).
-- ---------------------------------------------------------------------------
drop policy if exists worker_all on ops.llm_runs;
create policy worker_all on ops.llm_runs for all to marsad_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 1. pipeline_items: SLA-breach marker (idempotent flag the sweep sets once).
-- ---------------------------------------------------------------------------
alter table ops.pipeline_items add column if not exists sla_breached_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. desk_decide_approval — the ONE approval-decision transaction (05 §4.2).
--    Caller identity comes from app.principal_id (set by the Desk server action /
--    a manual session). owner = full; eic = send_back/reassign only.
-- ---------------------------------------------------------------------------
create or replace function ops.desk_decide_approval(
  p_item bigint, p_decision text, p_scheduled_for timestamptz default null, p_note text default null
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor  uuid := nullif(current_setting('app.principal_id', true), '')::uuid;
  v_role   text;
  v_stage  text;
  v_cid    uuid;
  v_ruleset int;
  v_live_ruleset int;
begin
  if v_actor is null then raise exception 'desk_decide_approval: no app.principal_id set'; end if;
  if p_decision not in ('approve','approve_scheduled','send_back','reassign') then
    raise exception 'desk_decide_approval: bad decision %', p_decision;
  end if;

  -- Caller role + capability (iam.role_grants → capability_grants; owner=full approvals,
  -- eic=conditional send_back/reassign only). Pick the most-privileged granted role.
  select rg.role_key into v_role from iam.role_grants rg
   where rg.principal_id = v_actor
     and rg.role_key in (select role_key from iam.capability_grants where capability = 'approvals.decide')
   order by case rg.role_key when 'owner' then 0 when 'eic' then 1 else 2 end limit 1;
  if v_role is null then raise exception 'desk_decide_approval: actor holds no approvals.decide role'; end if;
  if v_role <> 'owner' and p_decision in ('approve','approve_scheduled') then
    raise exception 'desk_decide_approval: role % may only send_back/reassign', v_role;
  end if;
  if p_decision = 'send_back' and coalesce(btrim(p_note),'') = '' then
    raise exception 'desk_decide_approval: send_back requires a note';
  end if;

  -- Lock the item; must be at 'approval' (double-click safe).
  select stage, content_id into v_stage, v_cid from ops.pipeline_items where id = p_item for update;
  if not found then raise exception 'desk_decide_approval: item % not found', p_item; end if;
  if v_stage <> 'approval' then raise exception 'desk_decide_approval: item % not at approval (is %)', p_item, v_stage; end if;

  -- RULES_STALE guard (05 §4.2): the piece must have passed the CURRENTLY-live ruleset.
  select rules_passed_version into v_ruleset from ops.pipeline_items where id = p_item;
  select version_no into v_live_ruleset from ops.rulesets where is_live limit 1;
  if p_decision in ('approve','approve_scheduled') and v_ruleset is distinct from v_live_ruleset then
    raise exception 'desk_decide_approval: RULES_STALE (passed v%, live v%) — re-run rules', v_ruleset, v_live_ruleset;
  end if;

  if p_decision = 'approve' then
    update public.content_items set status = 'live', published_at = now() where id = v_cid;
    perform ops.fn_transition(p_item, 'published', v_actor, jsonb_build_object('decision','approve'));
  elsif p_decision = 'approve_scheduled' then
    if p_scheduled_for is null then raise exception 'approve_scheduled requires p_scheduled_for'; end if;
    update public.content_items set status = 'scheduled', scheduled_at = p_scheduled_for where id = v_cid;
    -- stays at 'approval' stage until the publish sweep flips it live at scheduled_at.
    update ops.pipeline_items set approval_decision = 'publish_at', decided_by = v_actor, decided_at = now() where id = p_item;
  elsif p_decision = 'send_back' then
    update public.content_items set status = 'draft' where id = v_cid;
    update ops.pipeline_items set approval_decision = 'send_back', decided_by = v_actor, decided_at = now(), send_back_note = p_note where id = p_item;
    perform ops.fn_transition(p_item, 'sent_back', v_actor, jsonb_build_object('note', p_note));
    perform ops.fn_transition(p_item, 'draft', v_actor, jsonb_build_object('revise', true));
    perform pgmq.send('q_pipeline', jsonb_build_object('handler','pipeline_draft','pipeline_item_id',p_item));
  else -- reassign
    update ops.pipeline_items set approval_decision = 'reassign_human', decided_by = v_actor, decided_at = now() where id = p_item;
    perform ops.fn_transition(p_item, 'reassigned_human', v_actor, jsonb_build_object('note', p_note));
  end if;

  return p_decision;
end $$;

grant execute on function ops.desk_decide_approval(bigint, text, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Publish sweep — scheduled pieces whose time has come → live (as SYSTEM;
--    principal_kind is not 'agent', so the agent publish gate does not apply).
-- ---------------------------------------------------------------------------
create or replace function ops.newsroom_publish_sweep() returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; r record; v_sys uuid;
begin
  select id into v_sys from iam.principals where handle = 'SYSTEM';
  for r in
    select pi.id as item_id, ci.id as content_id
      from ops.pipeline_items pi join public.content_items ci on ci.id = pi.content_id
     where ci.status = 'scheduled' and ci.scheduled_at is not null and ci.scheduled_at <= now()
       and pi.stage = 'approval'
     for update of pi skip locked
  loop
    update public.content_items set status = 'live', published_at = now() where id = r.content_id;
    perform ops.fn_transition(r.item_id, 'published', v_sys, jsonb_build_object('scheduled', true));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 4. SLA sweep — flag approval items past their SLA. Quiet hours 22:00–07:00
--    Riyadh pause the clock (05 §4.1); breach only ESCALATES, never auto-publishes.
-- ---------------------------------------------------------------------------
create or replace function ops.newsroom_sla_sweep() returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; v_hour int;
begin
  v_hour := extract(hour from (now() at time zone 'Asia/Riyadh'))::int;
  if v_hour >= 22 or v_hour < 7 then return 0; end if; -- owner quiet hours: clock paused
  update ops.pipeline_items
     set sla_breached_at = now()
   where stage = 'approval' and sla_breached_at is null
     and stage_entered_at < now() - approval_sla;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Stalled-stage sweep — re-enqueue items stuck mid-conveyor (crash-after-delete
--    stranding). Idempotent: the handler no-ops if the item already advanced.
-- ---------------------------------------------------------------------------
create or replace function ops.newsroom_stalled_sweep() returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; r record;
begin
  for r in
    select id, stage from ops.pipeline_items
     where stage in ('draft','edit','rules')
       and stage_entered_at < now() - interval '20 minutes'
     for update skip locked
  loop
    perform pgmq.send('q_pipeline', jsonb_build_object('handler', 'pipeline_' || r.stage, 'pipeline_item_id', r.id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 6. LLM budget ladder (03 §1.7): daily rollup + a month-to-date state fn.
-- ---------------------------------------------------------------------------
create table if not exists ops.llm_cost_daily (
  day        date primary key,
  cost_usd   numeric(12, 4) not null default 0,
  run_count  int not null default 0,
  computed_at timestamptz not null default now()
);
grant select on ops.llm_cost_daily to service_role;

create or replace function ops.fn_rollup_llm_costs() returns void
language sql security definer set search_path = ''
as $$
  insert into ops.llm_cost_daily (day, cost_usd, run_count, computed_at)
  select (created_at at time zone 'Asia/Riyadh')::date as day,
         round(sum(cost_usd)::numeric, 4), count(*), now()
  from ops.llm_runs
  where created_at >= (now() at time zone 'Asia/Riyadh')::date - 2  -- last ~2 days, idempotent upsert
  group by 1
  on conflict (day) do update set cost_usd = excluded.cost_usd, run_count = excluded.run_count, computed_at = now();
$$;

-- 'ok' | 'degraded' (past $60 → writers use the cheaper fallback chain) | 'halted'
-- (past $120 → pause non-wire drafting; wires stay). Reads month-to-date live spend.
create or replace function ops.newsroom_budget_state(
  p_soft numeric default 60, p_hard numeric default 120
) returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when mtd >= p_hard then 'halted'
    when mtd >= p_soft then 'degraded'
    else 'ok' end
  from (
    select coalesce(sum(cost_usd), 0) as mtd from ops.llm_runs
    where created_at >= date_trunc('month', now() at time zone 'Asia/Riyadh')
  ) x;
$$;
grant execute on function ops.newsroom_budget_state(numeric, numeric) to marsad_worker, service_role;

-- ---------------------------------------------------------------------------
-- 7. pg_cron schedules.
-- ---------------------------------------------------------------------------
select cron.schedule('newsroom_publish_sweep', '* * * * *',      $$select ops.newsroom_publish_sweep()$$);
select cron.schedule('newsroom_sla_sweep',     '*/5 * * * *',    $$select ops.newsroom_sla_sweep()$$);
select cron.schedule('newsroom_stalled_sweep', '*/5 * * * *',    $$select ops.newsroom_stalled_sweep()$$);
select cron.schedule('llm_cost_rollup',        '0 21 * * *',     $$select ops.fn_rollup_llm_costs()$$);  -- 00:00 Riyadh

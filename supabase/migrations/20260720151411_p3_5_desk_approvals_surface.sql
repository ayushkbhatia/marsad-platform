-- 20260720151411_p3_5_desk_approvals_surface — P3.5: the public read/act surface the
-- /admin/approvals screen needs. ops.* and lake.* are NOT PostgREST-exposed (02 locks the
-- exposed schemas to public, graphql_public), so the Next app reaches the approval queue
-- through public wrappers only:
--
--   • DESK-OWNER principal (kind 'system') + owner role — the founder's audit identity while
--     the /admin gate is HTTP Basic Auth (proxy.ts) and real per-user Supabase Auth is not yet
--     wired (P5). Every desk decision attributes here until human owners get auth_user_ids.
--   • public.v_desk_approvals — the queue list (one row per pipeline item at 'approval').
--   • public.desk_approval_detail(item) → jsonb — one piece: content, blocks, citations
--     (each resolved to its cited object + state), rule violations, byline.
--   • public.desk_approve(item, decision, scheduled_for, note) — the action wrapper: stamps
--     the DESK-OWNER principal, then calls ops.desk_decide_approval (the real, capability-checked,
--     RULES_STALE-guarded transaction). service_role-only; the Basic-Auth /admin gate is the guard.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. DESK-OWNER audit principal + owner role.
-- ---------------------------------------------------------------------------
insert into iam.principals (kind, handle, display_name, is_active)
values ('system', 'DESK-OWNER', 'Desk Owner (interim, behind /admin Basic Auth)', true)
on conflict (handle) do nothing;

insert into iam.role_grants (principal_id, role_key, granted_by)
select p.id, 'owner', p.id from iam.principals p where p.handle = 'DESK-OWNER'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Queue list view.
-- ---------------------------------------------------------------------------
create or replace view public.v_desk_approvals as
select
  pi.id                                as item_id,
  ci.id                                as content_id,
  ci.content_type,
  ci.template_key,
  ci.headline,
  ci.dek,
  ci.word_count,
  ci.is_premium,
  pi.priority,
  pi.stage_entered_at,
  pi.approval_sla,
  pi.sla_breached_at,
  (now() > pi.stage_entered_at + pi.approval_sla) as sla_over,
  pi.rules_passed_version,
  (select version_no from ops.rulesets where is_live)                 as live_ruleset,
  (pi.rules_passed_version is distinct from (select version_no from ops.rulesets where is_live)) as rules_stale,
  s.ticker,
  s.venue_code,
  s.name_en                            as security_name,
  (select count(*) from lake.citations c where c.content_id = ci.id)  as citation_count,
  (select count(*) from ops.rule_violations rv where rv.content_id = ci.id and rv.outcome = 'warned') as warn_count
from ops.pipeline_items pi
join public.content_items ci on ci.id = pi.content_id
left join public.content_tickers ct on ct.content_id = ci.id and ct.is_primary
left join public.securities s on s.id = ct.security_id
where pi.stage = 'approval'
order by pi.sla_breached_at nulls last, pi.stage_entered_at;

grant select on public.v_desk_approvals to service_role;

-- ---------------------------------------------------------------------------
-- 3. Detail RPC — one piece, fully assembled for review.
-- ---------------------------------------------------------------------------
create or replace function public.desk_approval_detail(p_item bigint)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'item', (select to_jsonb(v) from public.v_desk_approvals v where v.item_id = p_item),
    'blocks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', cb.seq, 'kind', cb.block_kind, 'body', cb.body, 'gated', cb.gated
      ) order by cb.seq), '[]'::jsonb)
      from public.content_blocks cb
      join ops.pipeline_items pi on pi.content_id = cb.content_id
      where pi.id = p_item),
    'citations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'claim_key', c.claim_key, 'object_id', c.object_id, 'object_type', o.object_type,
        'object_state', o.state, 'quoted_value', c.quoted_value, 'claim', c.claim_text
      ) order by c.claim_key), '[]'::jsonb)
      from lake.citations c
      join ops.pipeline_items pi on pi.content_id = c.content_id
      left join lake.objects o on o.id = c.object_id
      where pi.id = p_item),
    'violations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'rule_key', rv.rule_key, 'outcome', rv.outcome, 'detail', rv.detail
      ) order by rv.rule_key), '[]'::jsonb)
      from ops.rule_violations rv
      join ops.pipeline_items pi on pi.content_id = rv.content_id
      where pi.id = p_item)
  );
$$;

revoke all on function public.desk_approval_detail(bigint) from public, anon, authenticated;
grant execute on function public.desk_approval_detail(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Action wrapper — stamp DESK-OWNER, delegate to the real ops transaction.
-- ---------------------------------------------------------------------------
create or replace function public.desk_approve(
  p_item bigint, p_decision text, p_scheduled_for timestamptz default null, p_note text default null
) returns text language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid;
begin
  select id into v_owner from iam.principals where handle = 'DESK-OWNER';
  if v_owner is null then raise exception 'desk_approve: DESK-OWNER principal missing'; end if;
  perform set_config('app.principal_id', v_owner::text, true);
  return ops.desk_decide_approval(p_item, p_decision, p_scheduled_for, p_note);
end $$;

revoke all on function public.desk_approve(bigint, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.desk_approve(bigint, text, timestamptz, text) to service_role;

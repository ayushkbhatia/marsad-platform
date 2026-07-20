-- Regression: P3.4 desk_decide_approval + publish sweep (migration 20260720142331).
-- Transactional, rolls back. RAISE on failure = red. A clean run is a pass.
begin;
do $$
declare v_owner uuid; v_eic uuid; v_cid uuid; v_item bigint; v_res text; v_stage text; v_status text;
begin
  select id into v_owner from iam.principals where handle='SYSTEM';
  select id into v_eic from iam.principals where handle='WRITER-1';
  insert into iam.role_grants (principal_id, role_key, granted_by) values (v_owner,'owner',v_owner),(v_eic,'eic',v_owner) on conflict do nothing;

  insert into public.content_items (content_type, headline, status, author_id, template_key, word_count)
    values ('WIRE','QNB posts QAR 4.43bn Q2 profit','approval', v_owner, 'TPL-01', 30) returning id into v_cid;
  insert into ops.pipeline_items (content_id, stage, priority, rules_passed_version) values (v_cid,'approval','wire',9) returning id into v_item;

  perform set_config('app.principal_id', v_eic::text, true);
  begin perform ops.desk_decide_approval(v_item,'approve'); raise exception 'FAIL: eic approve allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  update ops.pipeline_items set rules_passed_version = 8 where id = v_item;
  perform set_config('app.principal_id', v_owner::text, true);
  begin perform ops.desk_decide_approval(v_item,'approve'); raise exception 'FAIL: stale approve allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update ops.pipeline_items set rules_passed_version = 9 where id = v_item;

  v_res := ops.desk_decide_approval(v_item,'approve');
  select stage into v_stage from ops.pipeline_items where id = v_item;
  select status into v_status from public.content_items where id = v_cid;
  if v_res <> 'approve' or v_stage <> 'published' or v_status <> 'live' then raise exception 'FAIL: approve → % / %', v_stage, v_status; end if;

  insert into public.content_items (content_type, headline, status, author_id, template_key, scheduled_at)
    values ('WIRE','scheduled wire','scheduled', v_owner, 'TPL-01', now() - interval '1 min') returning id into v_cid;
  insert into ops.pipeline_items (content_id, stage) values (v_cid,'approval') returning id into v_item;
  perform ops.newsroom_publish_sweep();
  select status into v_status from public.content_items where id = v_cid;
  if v_status <> 'live' then raise exception 'FAIL: publish sweep left %', v_status; end if;

  raise notice 'p3_4_approval: ALL PASS';
end $$;
rollback;

-- Regression: P3.1 pipeline intake (migration 20260720110829).
-- fn_transition state machine (legal path, terminal block, illegal-skip block,
-- idempotent no-op, transition logging) + the materiality prefilter seed.
-- Transactional, rolls back — safe against live DB. RAISE on failure = a red test.

begin;
do $$
declare
  v_sid bigint; v_cid uuid; v_item bigint; v_sys uuid; v_stage text;
begin
  select id into v_sys from iam.principals where handle='SYSTEM';
  insert into public.securities (venue_code,ticker,name_en,currency,status,sector)
    values ('QE','ZZQ','Pipeline Test','QAR','listed','unknown') returning id into v_sid;
  insert into public.content_items (content_type,headline,status,author_id)
    values ('WIRE','Test wire headline','draft',v_sys) returning id into v_cid;
  insert into ops.pipeline_items (content_id,stage,priority) values (v_cid,'queued','wire') returning id into v_item;

  perform ops.fn_transition(v_item,'draft',v_sys);
  perform ops.fn_transition(v_item,'edit',v_sys);
  perform ops.fn_transition(v_item,'rules',v_sys);
  perform ops.fn_transition(v_item,'approval',v_sys);
  perform ops.fn_transition(v_item,'published',v_sys);
  select stage into v_stage from ops.pipeline_items where id=v_item;
  if v_stage <> 'published' then raise exception 'FAIL: expected published got %', v_stage; end if;

  begin perform ops.fn_transition(v_item,'draft',v_sys); raise exception 'FAIL: published->draft did not raise';
  exception when others then null; end;

  perform ops.fn_transition(v_item,'published',v_sys); -- idempotent no-op

  insert into ops.pipeline_items (content_id,stage) values (v_cid,'queued') returning id into v_item;
  begin perform ops.fn_transition(v_item,'rules',v_sys); raise exception 'FAIL: queued->rules did not raise';
  exception when others then null; end;

  if (select count(*) from ops.agent_runs where task_key='pipeline:transition') < 5 then
    raise exception 'FAIL: transition log rows missing'; end if;
  if (select verdict from ops.materiality_prefilter where object_type='FILING.FINANCIALS') <> 'material' then
    raise exception 'FAIL: prefilter FILING.FINANCIALS'; end if;
  if (select verdict from ops.materiality_prefilter where object_type='QUOTE.LAST') <> 'not_material' then
    raise exception 'FAIL: prefilter QUOTE.LAST'; end if;

  raise notice 'p3_pipeline_intake: ALL CASES PASS';
end $$;
rollback;

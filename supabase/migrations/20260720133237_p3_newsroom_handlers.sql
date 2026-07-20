-- 20260720133237_p3_newsroom_handlers — P3.3 support: the small DB changes the
-- newsroom worker handlers need on top of the P3.1 intake scaffolding.
--
--   1. fn_verified_enqueue emits the `handler` envelope key the worker consumer
--      dispatches on (P3.1 emitted `stage`, which the consumer archives as
--      unhandled). Now → {handler:'pipeline_classify', ...}.
--   2. lake.citations gains claim_key ('c1','c2', …) so the rules engine can bind
--      a [cN] marker to its cited object deterministically (R-03/R-04). Kept
--      nullable — human/legacy citations may omit it.
--   3. ops.pipeline_items gains a content_id-nullable path is NOT needed: classify
--      creates the content stub first, then the pipeline item (content_id set).

set search_path = '';

alter table lake.citations add column if not exists claim_key text;
create index if not exists citations_content_claim on lake.citations (content_id, claim_key);

create or replace function lake.fn_verified_enqueue() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_verdict text;
begin
  if new.state <> 'VERIFIED' then return null; end if;
  if not coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    return null;
  end if;

  select verdict into v_verdict from ops.materiality_prefilter where object_type = new.object_type;
  if v_verdict = 'not_material' then return null; end if;

  perform pgmq.send('q_pipeline', jsonb_build_object(
    'handler', 'pipeline_classify',
    'lake_object_id', new.id,
    'object_type', new.object_type,
    'security_id', new.security_id,
    'venue', new.venue_code
  ));
  return null;
end $$;

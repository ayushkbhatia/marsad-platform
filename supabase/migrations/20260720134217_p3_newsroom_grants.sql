-- 20260720134217_p3_newsroom_grants — P3.3: grant marsad_worker the newsroom
-- tables/functions the pipeline handlers read + write. The P3.1/P3.3 migrations
-- created the tables but only granted classifier_verdicts; the handlers also touch
-- the content + pipeline + rules tables. Least-privilege per handler need.

set search_path = '';

-- classify: read prefilter, write the piece + verdict
grant select on ops.materiality_prefilter to marsad_worker;
grant select, insert on public.content_items to marsad_worker;
grant select, insert on public.content_tickers to marsad_worker;
grant select, insert, update on ops.pipeline_items to marsad_worker;

-- draft/edit: mutate the piece, blocks, citations
grant update on public.content_items to marsad_worker;
grant select, insert, delete on public.content_blocks to marsad_worker;
grant select, insert, delete on lake.citations to marsad_worker;

-- rules: ruleset/banned config + violations + correction-flag read
grant select on ops.rulesets to marsad_worker;
grant select on ops.rules to marsad_worker;
grant select on ops.banned_phrases to marsad_worker;
grant select, insert on ops.rule_violations to marsad_worker;
grant select on ops.correction_flags to marsad_worker;

-- RLS policies: a GRANT is not enough — these tables have RLS enabled, so the worker also needs
-- a policy. `worker_all` gives marsad_worker full row access; the real publishing guard is the
-- fn_enforce_agent_publish_gate TRIGGER (triggers fire regardless of RLS), so a broad worker
-- policy here does not weaken the human-free-path constraints.
do $$
declare t text;
begin
  foreach t in array array[
    'ops.classifier_verdicts','ops.pipeline_items','ops.rule_violations',
    'public.content_items','public.content_tickers','public.content_blocks','lake.citations'
  ] loop
    execute format('drop policy if exists worker_all on %s', t);
    execute format('create policy worker_all on %s for all to marsad_worker using (true) with check (true)', t);
  end loop;
end $$;

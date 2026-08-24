-- PR.1 — where an assembled evidence brief is stored.
--
-- ── WHY A TABLE AND NOT A JSONB COLUMN ON pipeline_items ────────────────────────────────────────
-- A brief is evidence for one SECURITY at one moment, and a pipeline item is one PIECE. They are
-- not the same grain: a revision re-runs the piece and should be able to reuse or re-assemble the
-- brief deliberately, and a brief is worth reading even for a piece that was never written.
--
-- `contract_version` is a COLUMN rather than a key inside the jsonb so a reader can dispatch on it
-- without parsing a 30 KB payload first. `BUNDLE_CONTRACT_VERSION` in
-- ingestion/src/research/envelope.ts is the authority; bump both together or a stored brief becomes
-- uninterpretable.
--
-- ── WHY THE STAGE SHIPS BEFORE THIS APPLIES ─────────────────────────────────────────────────────
-- `research.ts` probes information_schema for this table and skips persistence when it is absent,
-- the same pattern fit.ts already uses twice (citable_states, templates.piece_type). So the worker
-- is deployable in either order, and applying this migration is the switch rather than a cutover.
--
-- ⚠️ This does NOT start the research stage. `iam.global_switches.newsroom_research_stage` stays
-- false; 20260816150000 already seeded it and nothing reads it until the handler is armed.

create table if not exists ops.research_briefs (
  id               bigserial primary key,
  security_id      bigint not null references public.securities(id) on delete cascade,
  -- Nullable: a brief may be assembled for a security with no piece in flight, which is how the
  -- desk would preview what the researcher can actually see before commissioning anything.
  content_id       uuid references public.content_items(id) on delete set null,
  pipeline_item_id bigint references ops.pipeline_items(id) on delete set null,
  contract_version int not null,
  trigger_object_id uuid,
  brief            jsonb not null,
  -- Denormalised from the payload so the readiness view does not have to open every brief.
  bound_fact_count int not null default 0,
  fit_bindable_count int not null default 0,
  legs_present     int not null default 0,
  legs_absent      int not null default 0,
  assembly_ms      int,
  assembled_at     timestamptz not null default now()
);

create index if not exists research_briefs_security
  on ops.research_briefs (security_id, assembled_at desc);
create index if not exists research_briefs_item
  on ops.research_briefs (pipeline_item_id) where pipeline_item_id is not null;

comment on table ops.research_briefs is
  'PR.1 — one assembled EvidenceBrief. Deterministic: the same database yields the same facts with '
  'the same object ids, which is what makes the evidence layer auditable rather than merely useful. '
  'brief.allow_set is the server-built citation allow-set the compose stage writes lake.citations '
  'from — a writer never handles a uuid, so it cannot cite outside its evidence.';

comment on column ops.research_briefs.fit_bindable_count is
  'How many bound facts are in a state the fit stage will accept for THIS object_type (D-14, '
  'ops.materiality_prefilter.citable_states). Lower than bound_fact_count means the brief carries '
  'readable evidence that cannot be rendered as a bound number — worth seeing before composing.';

alter table ops.research_briefs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies
                  where schemaname='ops' and tablename='research_briefs' and policyname='worker_all')
  then create policy worker_all on ops.research_briefs for all to marsad_worker
       using (true) with check (true); end if;
end $$;

grant select, insert on ops.research_briefs to marsad_worker;
grant usage, select on sequence ops.research_briefs_id_seq to marsad_worker;
grant select on ops.research_briefs to service_role;

-- What a human reads before arming the stage: can the researcher actually see anything?
create or replace view ops.v_research_readiness as
select rb.security_id,
       s.venue_code,
       s.ticker,
       rb.assembled_at,
       rb.bound_fact_count,
       rb.fit_bindable_count,
       rb.legs_present,
       rb.legs_absent,
       rb.assembly_ms
  from ops.research_briefs rb
  join public.securities s on s.id = rb.security_id
 order by rb.assembled_at desc;

comment on view ops.v_research_readiness is
  'PR.1 — the last briefs assembled, with how much of each was bindable. Read this before arming '
  'newsroom_research_stage: a brief with facts but zero fit_bindable is a piece that will be '
  'refused at fit, and it is cheaper to see that here than after the tokens are spent.';

grant select on ops.v_research_readiness to service_role;

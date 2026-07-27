-- PE.6 — open the intake gate, per-object-type, with a provenance floor and dedup at the door.
--
-- THE WALL. `lake.fn_verified_enqueue` fires only on state='VERIFIED', and both its triggers
-- hard-code `WHEN (new.state = 'VERIFIED')`. VERIFIED is written by exactly one general path,
-- `cross-check.ts`, whose predicate is "≥2 distinct source_ids in lake.staging_rows agreeing within
-- ±0.5%". Researchers (Lane B) write lake.objects DIRECTLY via upsertLakeObject — no staging row
-- ever exists — so their objects are not "unpromoted", they are UNREACHABLE. That is all 36,327
-- FILING.FINANCIALS, i.e. the entire fundamentals corpus. Decision D-10.
--
-- ── CORRECTING MY OWN SPEC ─────────────────────────────────────────────────────────────────────
-- `architecture/09-signal-to-article.md §3.2` specified a provenance floor of "a lake.parse_runs
-- lineage that resolves to a stored snapshot or PDF". Measured against live data before writing
-- this: **every Lane B object has has_snapshot = false** — researchers open a parse_run but never
-- write lake.parse_run_snapshots. That floor would reject 100% of the objects it was designed to
-- admit, which is the exact failure mode of the VERIFIED gate it replaces. Writing an
-- unsatisfiable rule twice would be worse than the original bug.
--
-- The floor that is both meaningful and satisfiable:
--   * the parse run SUCCEEDED — a crashed or still-running extraction must not produce a story;
--   * the object names a security — a story has to be about something;
--   * the object is live (not superseded).
-- `parse_runs.parser_key` ('msx_pdf_llm', 'adx_fspdf_llm', …) still records WHICH lane produced it,
-- so lineage is preserved even without a snapshot row.
--
-- ── DEDUP AT THE DOOR, NOT AT THE DESK ─────────────────────────────────────────────────────────
-- Measured: the last 7 days hold 4,050 FILING.FINANCIALS objects representing **1,413 real events**
-- — 2.9 objects per event, because one earnings release yields one object per statement type
-- (income / balance / cashflow / oci / equity_change). Opening the gate without dedup reproduces
-- DEF-NEWSROOM-DEDUP at scale: the recorded incident was two near-identical QNB stories three
-- minutes apart, and this would make that the norm at 2.9x.
--
-- Dedup belongs HERE, before the classifier, not at the content_items insert: suppressing at the
-- door costs one index probe, suppressing at the desk costs a classifier call, a writer call, an
-- editor call and a rules pass first. Same outcome, ~3x the LLM spend.
--
-- ⚠️ THIS MIGRATION DOES NOT START THE NEWSROOM. `iam.global_switches.pipeline_intake_enabled`
-- stays FALSE and is checked before anything is enqueued. This opens the gate; flipping the switch
-- is a separate, deliberate act with its own prerequisites (see the doc note at the end).

-- ---------------------------------------------------------------------------
-- (a) Per-type acceptable states. The config table already exists at exactly the right grain.

alter table ops.materiality_prefilter
  add column if not exists accepted_states text[] not null default '{VERIFIED}';

comment on column ops.materiality_prefilter.accepted_states is
  'Which lake.objects states may enter the newsroom for this object_type. Default {VERIFIED} keeps '
  'the original contract. {VERIFIED,PENDING} admits Lane-B (researcher-written) objects, which can '
  'never reach VERIFIED because they bypass lake.staging_rows entirely — see D-10.';

-- FILING.FINANCIALS is the whole point: 36,327 objects, all PENDING, all structurally unreachable.
update ops.materiality_prefilter
   set accepted_states = '{VERIFIED,PENDING}'
 where object_type = 'FILING.FINANCIALS';

-- ---------------------------------------------------------------------------
-- (b) The eligibility predicate, as a STABLE function so the trigger WHEN clause can call it.
--     A WHEN clause cannot contain a subquery, but it CAN call a function — which keeps the config
--     table the single authority instead of duplicating the allowlist into a trigger predicate
--     where the two would silently drift.

create or replace function lake.fn_intake_eligible_state(p_object_type text, p_state lake.object_state)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p_state::text = any (mp.accepted_states)
       from ops.materiality_prefilter mp
      where mp.object_type = p_object_type),
    -- No prefilter row = unknown type. Fall back to the original VERIFIED-only contract rather
    -- than admitting anything unrecognised.
    p_state = 'VERIFIED');
$$;

comment on function lake.fn_intake_eligible_state(text, lake.object_state) is
  'PE.6 — may an object of this type, in this state, enter the newsroom? Reads '
  'ops.materiality_prefilter.accepted_states so the config table stays the single authority. '
  'Unknown types fall back to VERIFIED-only (fail closed).';

-- ---------------------------------------------------------------------------
-- (c) The intake dedup ledger, owned by the gate itself.
--     Deliberately NOT ops.pipeline_items: that row is created later, by classify.ts, so the
--     trigger cannot use it to decide. A tiny ledger the gate writes atomically is the only way to
--     suppress BEFORE the first LLM call.

create table if not exists ops.intake_dedup (
  dedup_key   text primary key,
  object_id   uuid not null,
  object_type text not null,
  security_id bigint,
  first_seen  timestamptz not null default now()
);

comment on table ops.intake_dedup is
  'PE.6 — one row per real-world EVENT admitted to the newsroom, keyed by (type, security, period). '
  'Suppresses the 2.9 objects-per-event fan-out of FILING.FINANCIALS at the door. Deleting a row '
  'deliberately re-opens that event for a fresh piece (the supported way to re-run a story).';

alter table ops.intake_dedup enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='ops' and tablename='intake_dedup' and policyname='worker_all')
  then create policy worker_all on ops.intake_dedup for all to marsad_worker using (true) with check (true); end if;
end $$;
grant select, insert, delete on ops.intake_dedup to marsad_worker;
grant all on ops.intake_dedup to service_role;

/**
 * The event identity. For a financial statement this is (type, security, fiscal period) — the
 * statement TYPE is deliberately excluded, because income/balance/cashflow for one company-quarter
 * are one event and must yield one piece. Falls back to natural_key for types with no period, which
 * degrades to per-object behaviour rather than over-suppressing.
 */
create or replace function lake.fn_intake_dedup_key(p_obj lake.objects)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_obj.security_id is not null
     and coalesce(p_obj.payload->>'fiscal_period', '') <> ''
      then p_obj.object_type || ':' || p_obj.security_id || ':' || (p_obj.payload->>'fiscal_period')
    else p_obj.object_type || ':nk:' || p_obj.natural_key
  end;
$$;

-- ---------------------------------------------------------------------------
-- (d) The gate.

create or replace function lake.fn_verified_enqueue()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_verdict text;
  v_key     text;
  v_status  text;
begin
  -- The master switch. Checked FIRST and unchanged: PE.6 opens the gate, it does not start the
  -- newsroom. Flipping this is a separate deliberate act.
  if not coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    return null;
  end if;

  if not lake.fn_intake_eligible_state(new.object_type, new.state) then return null; end if;
  if new.superseded_by is not null then return null; end if;

  select verdict into v_verdict from ops.materiality_prefilter where object_type = new.object_type;
  if v_verdict = 'not_material' then return null; end if;

  -- PROVENANCE FLOOR. A story may not rest on a crashed extraction, and must be about something.
  if new.security_id is null then return null; end if;
  select pr.status into v_status from lake.parse_runs pr where pr.id = new.parse_run_id;
  if v_status is distinct from 'succeeded' then return null; end if;

  -- DEDUP. One row per real event; the loser of a race simply does not enqueue.
  v_key := lake.fn_intake_dedup_key(new);
  insert into ops.intake_dedup (dedup_key, object_id, object_type, security_id)
  values (v_key, new.id, new.object_type, new.security_id)
  on conflict (dedup_key) do nothing;
  if not found then return null; end if;

  perform pgmq.send('q_pipeline', jsonb_build_object(
    'handler', 'pipeline_classify',
    'lake_object_id', new.id,
    'object_type', new.object_type,
    'security_id', new.security_id,
    'venue', new.venue_code
  ));
  return null;
end $$;

comment on function lake.fn_verified_enqueue() is
  'PE.6 — the newsroom intake gate. Order: master switch, per-type accepted_states (D-10), not '
  'superseded, materiality, provenance floor (named security + succeeded parse run), then dedup by '
  'event. Named fn_VERIFIED_enqueue for history; it no longer requires VERIFIED.';

-- ---------------------------------------------------------------------------
-- (e) Re-point the triggers. Their WHEN clauses hard-coded VERIFIED, so changing the function alone
--     would have changed nothing — the predicate gates before the body ever runs.

drop trigger if exists objects_verified_enqueue_ins on lake.objects;
create trigger objects_verified_enqueue_ins
  after insert on lake.objects
  for each row
  when (lake.fn_intake_eligible_state(new.object_type, new.state))
  execute function lake.fn_verified_enqueue();

drop trigger if exists objects_verified_enqueue_upd on lake.objects;
create trigger objects_verified_enqueue_upd
  after update on lake.objects
  for each row
  when (old.state is distinct from new.state
        and lake.fn_intake_eligible_state(new.object_type, new.state))
  execute function lake.fn_verified_enqueue();

-- ---------------------------------------------------------------------------
-- (f) What a human needs to see before flipping the switch.

create or replace view ops.v_intake_readiness as
select mp.object_type,
       mp.verdict,
       mp.accepted_states,
       mp.template_hint,
       (select count(*) from lake.objects o
         where o.object_type = mp.object_type
           and o.superseded_by is null
           and o.state::text = any (mp.accepted_states)) as eligible_objects,
       (select count(*) from ops.intake_dedup d where d.object_type = mp.object_type) as events_admitted
from ops.materiality_prefilter mp
where mp.verdict <> 'not_material'
order by 5 desc nulls last;

comment on view ops.v_intake_readiness is
  'PE.6 — what would flow if pipeline_intake_enabled were flipped: per type, how many live objects '
  'are eligible and how many distinct events have already been admitted. Read this BEFORE flipping.';

grant select on ops.v_intake_readiness to service_role;

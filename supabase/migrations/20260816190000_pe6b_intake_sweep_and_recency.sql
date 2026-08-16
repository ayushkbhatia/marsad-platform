-- PE.6b — the intake door stops being a single instant, and gains a recency floor + rate limit.
--
-- ── THE RACE ──────────────────────────────────────────────────────────────────
-- lake.fn_verified_enqueue asserts the provenance floor with:
--
--     select pr.status into v_status from lake.parse_runs pr where pr.id = new.parse_run_id;
--     if v_status is distinct from 'succeeded' then return null; end if;
--
-- Every researcher opens its run as status='running' and only marks it 'succeeded' at the END
-- (scripts/researchers/dividend-declared.mjs:151 and every sibling). The trigger reads the
-- status at INSERT time — while the run is still 'running' — so it returns null.
--
-- Nothing ever revisits that decision. The UPDATE trigger is gated
-- `when (old.state is distinct from new.state)`, and upsertLakeObject's update branch keeps
-- the object PENDING, so the state never changes and the trigger never re-fires.
--
-- Result: EVERY object any Lane-B researcher has ever written is permanently non-enqueueable.
-- Not "not yet promoted" — unreachable, and no amount of re-running fixes it. This is the same
-- class of unsatisfiable gate that PE.6's own header says it was written to avoid, and it
-- would have silently swallowed the entire FILING.EVENT / EARNINGS.VERDICT canonicalisation
-- that is about to land.
--
-- ── THE FIX: A SWEEPER, NOT A BIGGER TRIGGER ──────────────────────────────────
-- Making the trigger smarter cannot work — at INSERT time the run genuinely has not finished,
-- and that is not a lie to route around. The decision has to be revisited later, which is a
-- sweep. It also buys three things the trigger structurally cannot:
--
--   · a RECENCY FLOOR. ops.v_intake_readiness reports 36,458 eligible FILING.FINANCIALS,
--     collapsing to 10,388 distinct events. The triggers are AFTER INSERT/UPDATE so today's
--     backlog is inert — but the moment the dead statement researchers restart and re-touch
--     Q2, it stops being inert. A floor on period_end means history stays history.
--   · a RATE LIMIT. The only defence against a backfill turning into ~$200 of writer calls
--     and an approval queue no human can work.
--   · a KILL SWITCH independent of pipeline_intake_enabled.
--
-- The triggers STAY for genuine real-time (a human confirming a price-sensitive object should
-- reach the newsroom in seconds, not within the hour).
--
-- ── ONE PREDICATE, TWO CALLERS ────────────────────────────────────────────────
-- The admissibility test moves into lake.fn_intake_admissible() and both the trigger and the
-- sweeper call it. Two copies of this logic is exactly how R-03 and intake drifted apart for
-- a month, and that bug cost the newsroom every draft it ever attempted.

-- ─── 0. The index the sweeper needs ───────────────────────────────────────────
-- Without this, finding candidates is a seq scan of ~790k rows with wide jsonb payloads —
-- measured at over 30s, i.e. an hourly cron job that never finishes inside a statement
-- timeout. The sweeper filters on object_type and orders by created_at among live rows, so
-- that is exactly the index.
create index if not exists objects_live_type_created
  on lake.objects (object_type, created_at desc)
  where superseded_by is null;

-- ─── 1. The shared predicate ──────────────────────────────────────────────────
create or replace function lake.fn_intake_admissible(p_object_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $$
  select
    lake.fn_intake_eligible_state(o.object_type, o.state)
    and o.superseded_by is null
    and o.security_id is not null
    and coalesce((select mp.verdict from ops.materiality_prefilter mp
                   where mp.object_type = o.object_type), '') is distinct from 'not_material'
    -- The provenance floor: the object traces to a parse run that SUCCEEDED. Re-read rather
    -- than trusted, because a run can be marked failed (or reaped) after the object landed.
    and (select pr.status from lake.parse_runs pr where pr.id = o.parse_run_id) = 'succeeded'
  from lake.objects o
  where o.id = p_object_id;
$$;

comment on function lake.fn_intake_admissible(uuid) is
  'Is this object admissible to the newsroom? The single source of truth for that question, '
  'called by BOTH lake.fn_verified_enqueue (real-time) and ops.intake_sweep (catch-up). '
  'Excludes the global switch and the dedup check, which are the callers'' own concerns.';

-- ─── 2. The trigger now delegates ─────────────────────────────────────────────
create or replace function lake.fn_verified_enqueue()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare
  v_key text;
begin
  if not coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    return null;
  end if;
  if not lake.fn_intake_admissible(new.id) then return null; end if;

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
end $function$;

-- ─── 3. When is an object "recent"? ───────────────────────────────────────────
-- effective_date is NULL on all 36,458 FILING.FINANCIALS, so the column alone cannot answer
-- this; the date lives in the payload. Cast defensively — one malformed period_end must not
-- abort a sweep over thousands of rows.
create or replace function lake.fn_object_event_date(p_object lake.objects)
returns date
language plpgsql immutable set search_path to ''
as $$
declare v_d date;
begin
  if p_object.effective_date is not null then return p_object.effective_date; end if;
  begin
    v_d := nullif(p_object.payload ->> 'period_end', '')::date;
  exception when others then v_d := null;
  end;
  if v_d is not null then return v_d; end if;
  begin
    v_d := nullif(p_object.payload ->> 'event_date', '')::date;
  exception when others then v_d := null;
  end;
  return coalesce(v_d, p_object.created_at::date);
end $$;

-- ─── 4. The sweeper ───────────────────────────────────────────────────────────
create or replace function ops.intake_sweep(
  p_limit   int      default 20,
  p_max_age interval default interval '120 days'
) returns int
language plpgsql security definer set search_path to ''
as $$
declare
  v_sent int := 0;
  r      record;
  v_key  text;
begin
  if not coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    return 0;
  end if;
  if not coalesce((select value from iam.global_switches where key = 'newsroom_intake_sweep'), true) then
    return 0;   -- independent brake: stop the catch-up lane without closing the front door
  end if;

  for r in
    -- PRUNE, THEN TEST. lake.objects is ~790k rows and fn_intake_admissible does three
    -- subqueries, so calling it per row scans for minutes. The join to materiality_prefilter
    -- cuts to the handful of types that can ever be material (~38k rows) using the SAME
    -- not_material clause the function applies, then the function makes the final call on a
    -- bounded candidate set. Same answer, bounded work.
    with candidates as (
      select o.*
        from lake.objects o
        join ops.materiality_prefilter mp
          on mp.object_type = o.object_type and mp.verdict is distinct from 'not_material'
       where o.superseded_by is null
         and o.security_id is not null
         and not exists (select 1 from ops.intake_dedup d where d.object_id = o.id)
       -- Newest arrivals first: if the rate limit bites it should bite on history, never on today.
       order by o.created_at desc
       limit greatest(p_limit * 20, 200)
    )
    select c.*
      from candidates c
     where lake.fn_object_event_date(c.*) > (current_date - p_max_age)
       and lake.fn_intake_admissible(c.id)
     order by lake.fn_object_event_date(c.*) desc
     limit p_limit
  loop
    v_key := lake.fn_intake_dedup_key(r);
    insert into ops.intake_dedup (dedup_key, object_id, object_type, security_id)
    values (v_key, r.id, r.object_type, r.security_id)
    on conflict (dedup_key) do nothing;
    if not found then continue; end if;   -- another event of the same real-world thing won

    perform pgmq.send('q_pipeline', jsonb_build_object(
      'handler', 'pipeline_classify',
      'lake_object_id', r.id,
      'object_type', r.object_type,
      'security_id', r.security_id,
      'venue', r.venue_code
    ));
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;

comment on function ops.intake_sweep(int, interval) is
  'Catch-up half of newsroom intake. lake.fn_verified_enqueue decides at INSERT time, when a '
  'researcher''s parse run is still ''running'', so every Lane-B object was permanently '
  'non-enqueueable; this revisits that decision. Also carries the recency floor and the rate '
  'limit, which a per-row trigger cannot. Returns how many it enqueued.';

insert into iam.global_switches (key, value, changed_by)
select 'newsroom_intake_sweep', true, (select id from iam.principals where handle = 'SYSTEM')
on conflict (key) do nothing;

select cron.unschedule('newsroom_intake_sweep') where exists
  (select 1 from cron.job where jobname = 'newsroom_intake_sweep');
select cron.schedule('newsroom_intake_sweep', '23 * * * *',
  $$select ops.intake_sweep()$$);

-- ─── 5. Observability: what WOULD flow, without arming anything ──────────────
-- The view expresses fn_intake_admissible RELATIONALLY rather than calling it per row.
-- Measured: the candidate scan is 1.9s, but the function costs ~1ms a row and there are
-- 36,458 candidates — over 30 seconds, which is a diagnostic nobody can run. The sweeper does
-- not have this problem because it prunes to a few hundred rows before testing.
--
-- Two expressions of one rule is the drift risk this migration otherwise works to avoid, so
-- the assertion at the foot of this file checks them against each other on a live sample.
create or replace view ops.v_intake_pending as
select o.object_type,
       count(*)                                                                              as admissible,
       count(*) filter (where lake.fn_object_event_date(o.*) > current_date - interval '120 days') as within_recency,
       min(lake.fn_object_event_date(o.*))                                                   as oldest_event,
       max(lake.fn_object_event_date(o.*))                                                   as newest_event
  from lake.objects o
  join ops.materiality_prefilter mp
    on mp.object_type = o.object_type
   and mp.verdict is distinct from 'not_material'
   and o.state::text = any (mp.accepted_states)
  join lake.parse_runs pr
    on pr.id = o.parse_run_id and pr.status = 'succeeded'
 where o.superseded_by is null
   and o.security_id is not null
   and not exists (select 1 from ops.intake_dedup d where d.object_id = o.id)
 group by o.object_type;

comment on view ops.v_intake_pending is
  'What the sweeper would pick up if intake were armed, by type — the answer to "how much '
  'would flipping the switch actually cost" BEFORE flipping it.';

grant select on ops.v_intake_pending to service_role;

do $$
declare v_n int; v_view int; v_fn int;
begin
  -- The sweeper must be inert while the front door is shut.
  select ops.intake_sweep(5) into v_n;
  if v_n <> 0 then
    raise exception 'intake_sweep enqueued % rows with pipeline_intake_enabled false', v_n;
  end if;

  -- The view's relational form and fn_intake_admissible must agree. Checked on a bounded
  -- sample because the function cannot be run over the full candidate set inside a statement
  -- timeout — which is the whole reason the view does not call it.
  with sample as (
    select o.id
      from lake.objects o
      join ops.materiality_prefilter mp
        on mp.object_type = o.object_type and mp.verdict is distinct from 'not_material'
     where o.superseded_by is null and o.security_id is not null
     order by o.created_at desc
     limit 300
  ),
  by_view as (
    select s.id from sample s
     join lake.objects o on o.id = s.id
     join ops.materiality_prefilter mp
       on mp.object_type = o.object_type
      and mp.verdict is distinct from 'not_material'
      and o.state::text = any (mp.accepted_states)
     join lake.parse_runs pr on pr.id = o.parse_run_id and pr.status = 'succeeded'
     where o.superseded_by is null and o.security_id is not null
  ),
  by_fn as (
    select s.id from sample s where lake.fn_intake_admissible(s.id)
  )
  select (select count(*) from by_view), (select count(*) from by_fn) into v_view, v_fn;

  if v_view <> v_fn then
    raise exception 'v_intake_pending and fn_intake_admissible disagree on a 300-row sample (% vs %)', v_view, v_fn;
  end if;
  raise notice 'intake predicate agreement verified on % of 300 sampled rows', v_fn;
end $$;

-- PE.6c — claim the corroboration the lake already earned, and label verification honestly.
--
-- ── WHAT THIS FIXES ────────────────────────────────────────────────────────────
-- `lake.objects` was 1,554 VERIFIED out of ~790,000 (0.2%), and the newsroom's R-03
-- refuses to cite anything that is not VERIFIED. The received diagnosis was that
-- cross-check is starved — 99.88% of staging natural_keys have exactly one source —
-- and therefore that VERIFIED is structurally unreachable for fundamentals (09 §3.1).
--
-- That is true of the STAGING lane. It is not true of the lake. `public.financial_
-- statement_xcheck` already holds 9,915 `agree` verdicts covering 523 securities,
-- each produced by 20260721100000_financials_xcheck_reconcile_v2 comparing two
-- genuinely independent extraction lanes — the venue's own filing (PDF/XBRL) against
-- stockanalysis — and requiring the core line items to agree within 1%.
--
-- That is a stronger claim than the rule that has produced every VERIFIED object to
-- date (two quote feeds agreeing within 0.5% on a price, which the newsroom itself
-- classifies as `not_material`). The verdicts were computed and then never acted on:
-- nothing ever promoted the object. This migration writes the UPDATE.
--
-- ── WHY A SEPARATE TRIGGER RATHER THAN EDITING THE RECONCILE ───────────────────
-- The reconcile function is ~200 lines and owned by its own migration. Re-declaring
-- it here to append six lines invites exactly the two-uncoordinated-`create or
-- replace` drift this repo has been bitten by. Instead the promotion hangs off the
-- verdict TABLE, which the reconcile already upserts into — so every future
-- stockanalysis pass promotes or conflicts its counterpart with no further wiring.
--
-- ── VERIFICATION_BASIS ────────────────────────────────────────────────────────
-- `COMPUTED.RATIOS` (737) and `COMPUTED.SCORE` (552) write themselves VERIFIED with
-- `verified_by = SYSTEM`. That is a lineage assertion, not corroboration, and it has
-- been polluting the only metric anyone can use to judge lake quality. They keep the
-- state — the ratios are correct and downstream depends on it — but they stop
-- claiming to be corroborated. `BLK-PROV` and the rules stage read this column.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────────
-- Verified before writing: all 9,915 `agree` rows resolve to distinct objects, every
-- one PENDING, none price-sensitive, none superseded. `lake.fn_object_state_guard`
-- permits PENDING→VERIFIED and PENDING→CONFLICT and requires a non-null verified_by
-- (a HUMAN one only for price-sensitive rows — none of these are).
-- `iam.global_switches.pipeline_intake_enabled` is false, so the 9,915
-- `objects_verified_enqueue_upd` firings return on `fn_verified_enqueue`'s first line
-- instead of flooding the newsroom. RE-CHECK THAT BEFORE RE-RUNNING THIS.
-- `fn_financials_project` re-fires on each promoted row but the payload is unchanged,
-- so it takes its no-op branch: no version bump, no `financial_statement_history` row.
-- `fn_datapoint_fanout` is inert (no object carries `metric_key`).

-- ─── 1. How a VERIFIED object earned its state ────────────────────────────────
alter table lake.objects add column if not exists verification_basis text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'objects_verification_basis_chk') then
    alter table lake.objects add constraint objects_verification_basis_chk
      check (verification_basis is null or verification_basis in
             ('corroborated', 'derived', 'human', 'primary_document'));
  end if;
end $$;

comment on column lake.objects.verification_basis is
  'HOW this object reached VERIFIED, which is not the same question as whether it is. '
  'corroborated = two independent sources agreed (cross-check, or financial_statement_xcheck). '
  'derived = computed from already-verified inputs and self-asserted by the compute agent '
  '(COMPUTED.*) — a lineage claim, NOT corroboration. human = a desk principal confirmed it '
  '(required for price_sensitive, per fn_object_state_guard). primary_document = traceable to a '
  'stored filing we hold the bytes of (the provenance floor, 09 §3.2). NULL on non-VERIFIED rows.';

-- Existing VERIFIED rows, labelled for what they actually are.
update lake.objects
   set verification_basis = 'derived'
 where state = 'VERIFIED' and verification_basis is null
   and object_type like 'COMPUTED.%';

update lake.objects
   set verification_basis = 'corroborated'
 where state = 'VERIFIED' and verification_basis is null
   and object_type = 'QUOTE.LAST';

-- The single 2026-07-20 FILING.FINANCIALS VERIFIED row is an artefact of a manual
-- proving run, not a corroboration (09 §1.2 calls it exactly that).
update lake.objects
   set verification_basis = 'derived'
 where state = 'VERIFIED' and verification_basis is null;

-- ─── 2. The promotion, as a function so the backfill and the trigger agree ────
create or replace function lake.fn_apply_xcheck_verdict(p_golden_object_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_system uuid;
  v_state  text;
begin
  if p_golden_object_id is null then return 'skipped:no_golden'; end if;

  select state::text into v_state from lake.objects where id = p_golden_object_id;
  if v_state is null then return 'skipped:missing'; end if;
  if v_state <> 'PENDING' then return 'skipped:not_pending'; end if;

  if p_status = 'agree' then
    select id into v_system from iam.principals where handle = 'SYSTEM';

    -- price_sensitive is deliberately excluded rather than handled: those objects
    -- require a HUMAN verifier (fn_object_state_guard), and routing them through a
    -- machine promotion would be the exact bypass that guard exists to prevent.
    update lake.objects
       set state              = 'VERIFIED',
           verified_by        = v_system,
           verification_basis = 'corroborated'
     where id = p_golden_object_id
       and state = 'PENDING'
       and not price_sensitive
       and superseded_by is null;
    if found then return 'verified'; end if;
    return 'skipped:ineligible';

  elsif p_status = 'conflict' then
    -- Two lanes disagree on a core line item. CONFLICT drops the object out of
    -- lake.v_citable_objects, so R-03 refuses to let a piece cite a disputed figure.
    -- NOTE: the already-projected public.financial_statements row is NOT withdrawn —
    -- fn_financials_project simply stops refreshing it. Surfacing that dispute to
    -- readers is BLK-CONFLICT's job and is not in scope here.
    update lake.objects
       set state = 'CONFLICT'
     where id = p_golden_object_id
       and state = 'PENDING'
       and superseded_by is null;
    if found then return 'conflicted'; end if;
    return 'skipped:ineligible';
  end if;

  return 'skipped:status';   -- gap_golden_missing / gap_source_only: nothing to say
end $$;

revoke all on function lake.fn_apply_xcheck_verdict(uuid, text) from public;
grant execute on function lake.fn_apply_xcheck_verdict(uuid, text) to service_role, marsad_worker;

-- ─── 3. Keep it continuous ────────────────────────────────────────────────────
create or replace function lake.fn_xcheck_verdict_promote()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.status in ('agree', 'conflict') then
    perform lake.fn_apply_xcheck_verdict(new.golden_object_id, new.status);
  end if;
  return null;
end $$;

drop trigger if exists xcheck_verdict_promote on public.financial_statement_xcheck;
create trigger xcheck_verdict_promote
  after insert or update of status, golden_object_id on public.financial_statement_xcheck
  for each row execute function lake.fn_xcheck_verdict_promote();

-- ─── 4. The one-shot backfill over verdicts already computed ──────────────────
do $$
declare
  v_verified int := 0;
  v_conflict int := 0;
  r          record;
begin
  if coalesce((select value from iam.global_switches where key = 'pipeline_intake_enabled'), false) then
    raise exception 'pipeline_intake_enabled is TRUE — promoting ~9,915 objects would enqueue '
                    'them all into the newsroom. Turn intake off, run this, then turn it back on.';
  end if;

  for r in
    select golden_object_id, status
      from public.financial_statement_xcheck
     where status in ('agree', 'conflict') and golden_object_id is not null
  loop
    case lake.fn_apply_xcheck_verdict(r.golden_object_id, r.status)
      when 'verified'   then v_verified := v_verified + 1;
      when 'conflicted' then v_conflict := v_conflict + 1;
      else null;
    end case;
  end loop;

  raise notice 'PE.6c: % objects VERIFIED (corroborated), % marked CONFLICT', v_verified, v_conflict;

  if v_verified < 9000 then
    raise exception 'PE.6c: expected ~9,915 promotions, got % — investigate before committing', v_verified;
  end if;
end $$;

-- ─── 5. Assertions ────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
begin
  -- No VERIFIED row may claim a basis it did not earn.
  select count(*) into v_bad from lake.objects
   where state = 'VERIFIED' and verification_basis is null;
  if v_bad > 0 then raise exception '% VERIFIED objects have no verification_basis', v_bad; end if;

  -- Corroborated FILING.FINANCIALS must each have an `agree` verdict behind them.
  select count(*) into v_bad
    from lake.objects o
   where o.object_type = 'FILING.FINANCIALS' and o.state = 'VERIFIED'
     and o.verification_basis = 'corroborated'
     and not exists (select 1 from public.financial_statement_xcheck x
                      where x.golden_object_id = o.id and x.status = 'agree');
  if v_bad > 0 then raise exception '% corroborated objects lack an agree verdict', v_bad; end if;

  -- The guard's own invariant, re-asserted.
  select count(*) into v_bad from lake.objects
   where state = 'VERIFIED' and verified_by is null;
  if v_bad > 0 then raise exception '% VERIFIED objects have no verified_by', v_bad; end if;
end $$;

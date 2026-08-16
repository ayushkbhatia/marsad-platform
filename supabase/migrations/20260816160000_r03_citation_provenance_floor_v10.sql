-- R-03's provenance floor, as data — and ruleset v10 to record which floor a piece passed.
--
-- ── THE CONTRADICTION THIS RESOLVES ───────────────────────────────────────────
-- 20260727150000 (PE.6) deliberately widened INTAKE to admit PENDING FILING.FINANCIALS,
-- because Lane-B researchers write PENDING unconditionally and cross-check can never
-- promote what never entered staging. The rules engine was never updated to match, and
-- kept demanding `object_state = 'VERIFIED'` on every citation.
--
-- So the system admitted exactly the objects it then refused to let anyone cite. Every
-- piece the conveyor was allowed to start was guaranteed to be blocked. That is not a
-- hypothesis: all 6 rule runs ever executed blocked on `cited_object_not_verified`, both
-- real drafts exhausted the retry cap, and the newsroom has been dark since 2026-07-20.
--
-- ── WHY A SEPARATE COLUMN FROM accepted_states ────────────────────────────────
-- `accepted_states` answers "may this type TRIGGER a piece". `citable_states` answers "may
-- a piece CITE this type". They are different questions with different answers, and
-- conflating them breaks in both directions: COMPUTED.RATIOS / COMPUTED.SCORE / QUOTE.LAST
-- are `not_material` (they will never trigger anything) yet writers cite them constantly,
-- while a type could be triggerable in a state you would not want quoted.
--
-- ── THE FLOOR ─────────────────────────────────────────────────────────────────
-- A citation is legal when the object is in its type's citable state set AND not superseded
-- AND not CONFLICT AND its parse-run lineage succeeded. That is traceability to a primary
-- document we still hold — a stronger guarantee than "two scrapers agreed", because it is
-- anchored to the source rather than to a coincidence between two secondaries.
--
-- `distinct_lineage_roots >= 2` does NOT move: it remains the AUTO-PUBLISH gate in
-- engine.ts (09 §3.2, Revision #5). A single-rooted piece still publishes, through a human.
--
-- ── WHY v10 RATHER THAN EDITING v9 ────────────────────────────────────────────
-- ops.rule_violations FKs (ruleset_version, rule_key) and item 7 is stamped
-- rules_passed_version = 9. Editing v9 would rewrite the history of the one piece that ever
-- passed. Deploying v10 also arms the existing RULES_STALE guard in ops.desk_decide_approval,
-- which will now correctly force a re-run of anything approved under the old floor — which
-- is the desired behaviour, not a side effect.

-- ─── 1. The allowlist ─────────────────────────────────────────────────────────
alter table ops.materiality_prefilter
  add column if not exists citable_states text[] not null default '{VERIFIED}';

comment on column ops.materiality_prefilter.citable_states is
  'R-03: the lake object states in which THIS type may be cited by a published piece. '
  'Distinct from accepted_states, which governs whether the type may TRIGGER a piece. '
  'Default {VERIFIED} is fail-closed: a type nobody has thought about is not citable, '
  'mirroring lake.fn_intake_eligible_state''s fallback for an unknown type.';

update ops.materiality_prefilter set citable_states = v.states
  from (values
    -- Widened to PENDING: single-source by nature (a Saudi statement comes only from Tadawul),
    -- and each carries a parse-run lineage to a stored filing. The floor, not the state, is
    -- what makes these safe to quote.
    ('FILING.FINANCIALS', array['VERIFIED','PENDING']),
    ('FILING.REF',        array['VERIFIED','PENDING']),
    ('FILING.EVENT',      array['VERIFIED','PENDING']),
    ('PROFILE.SECURITY',  array['VERIFIED','PENDING']),
    ('OHLCV.CLOSE',       array['VERIFIED','PENDING']),
    ('QUOTE.LAST',        array['VERIFIED','PENDING']),
    ('INDEX.LEVEL',       array['VERIFIED','PENDING']),
    -- Derived from already-verified inputs by our own compute; the object IS the arithmetic,
    -- so a PENDING one is a half-written recompute and must not be quoted.
    ('COMPUTED.RATIOS',   array['VERIFIED']),
    ('COMPUTED.SCORE',    array['VERIFIED']),
    ('COMPUTED.YIELD',    array['VERIFIED']),
    -- Price-sensitive: a human confirms these (lake.fn_object_state_guard requires a HUMAN
    -- verifier), and that confirmation IS the licence to quote them.
    ('DIVIDEND.EXDATE',   array['VERIFIED']),
    ('DISCLOSURE.DPS',    array['VERIFIED']),
    ('EARNINGS.VERDICT',  array['VERIFIED']),
    ('IPO.OFFER',         array['VERIFIED']),
    -- Evidence ABOUT a fact, never the fact. Cite the FILING.FINANCIALS it corroborates.
    ('FINANCIALS.XCHECK', array['VERIFIED'])
  ) as v(object_type, states)
 where ops.materiality_prefilter.object_type = v.object_type;

-- ─── 2. Ruleset v10 ───────────────────────────────────────────────────────────
insert into ops.rulesets (version_no, is_live, deployed_by, config)
select 10, false, (select id from iam.principals where handle = 'SYSTEM'),
       jsonb_build_object(
         'note', 'R-03 provenance floor: per-type citable_states + not-superseded + not-CONFLICT '
                 '+ parse-run lineage succeeded, replacing the blanket VERIFIED demand that '
                 'contradicted PE.6 intake. distinct_lineage_roots>=2 remains the auto-publish gate.',
         'max_revisions', 2)
on conflict (version_no) do nothing;

-- v10 inherits v9's rule rows verbatim; only R-03's body changes.
insert into ops.rules (ruleset_version, rule_key, title, body, scope, enforcement, enabled, params)
select 10, r.rule_key, r.title, r.body, r.scope, r.enforcement, r.enabled, r.params
  from ops.rules r where r.ruleset_version = 9
on conflict (ruleset_version, rule_key) do nothing;

update ops.rules
   set body = 'Source or silence. Every number-bearing sentence carries a [cN]; every marker '
              'resolves to a citation; and the cited object must satisfy the provenance floor — '
              'in its type''s citable_states, not superseded, not in CONFLICT, with a parse-run '
              'lineage that succeeded.'
 where ruleset_version = 10 and rule_key = 'R-03';

-- Flip live in one statement so no window exists with two live rulesets.
update ops.rulesets set is_live = (version_no = 10) where version_no in (9, 10);

-- ─── 3. Assertions ────────────────────────────────────────────────────────────
do $$
declare v_n int; v_live int;
begin
  select count(*) into v_live from ops.rulesets where is_live;
  if v_live <> 1 then raise exception 'expected exactly 1 live ruleset, found %', v_live; end if;

  select version_no into v_live from ops.rulesets where is_live;
  if v_live <> 10 then raise exception 'live ruleset is v%, expected v10', v_live; end if;

  select count(*) into v_n from ops.rules where ruleset_version = 10;
  if v_n < 10 then raise exception 'ruleset v10 has only % rules', v_n; end if;

  -- The floor must actually admit something, or this migration has changed nothing and the
  -- newsroom is still deadlocked. Belt-and-braces against a typo'd object_type above.
  select count(*) into v_n
    from ops.materiality_prefilter
   where object_type = 'FILING.FINANCIALS' and 'PENDING' = any (citable_states);
  if v_n <> 1 then raise exception 'FILING.FINANCIALS is not citable while PENDING — the deadlock stands'; end if;
end $$;

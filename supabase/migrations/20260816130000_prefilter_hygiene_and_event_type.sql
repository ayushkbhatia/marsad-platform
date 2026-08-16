-- Materiality prefilter: close the gaps that turn a missing row into a paid LLM call,
-- and give the deterministic tier an event_type so the research/angle layer has a key.
--
-- ── GAP 1: a missing row is not "unknown", it is "material" ────────────────────
-- lake.fn_verified_enqueue short-circuits ONLY on verdict = 'not_material'. A missing
-- ops.materiality_prefilter row leaves the verdict NULL, which passes that test, so the
-- object is enqueued and classify.ts escalates it to the LLM tier. COMPUTED.SCORE has a
-- row; COMPUTED.RATIOS never got one. It is VERIFIED on 737 objects and recomputed
-- nightly by key-ratios.ts, so arming intake today would buy a classifier call for every
-- ratio recompute, forever, to be told what the table already knows: a derived recompute
-- is never a story. FINANCIALS.XCHECK (41,621 objects) has the same hole; it is currently
-- shielded only by being PENDING, which fn_intake_eligible_state rejects for unknown
-- types — a shield that disappears the moment anything promotes it.
--
-- ── GAP 2: the deterministic tier produces no event_type ───────────────────────
-- classify.ts writes ops.classifier_verdicts.event_type only on the LLM path. Every type
-- that can actually flow today resolves deterministically (FILING.FINANCIALS is
-- 'material'), and only FILING.REF is 'ambiguous' — so in practice event_type is NULL on
-- every piece the conveyor will ever produce. Anything keyed on it (per-event-type
-- research bundles, angle guidance, forbidden claims) is therefore a no-op before it is
-- written. The event_type belongs on the prefilter row, next to the verdict that is
-- already deterministic.
--
-- FILING.EVENT is registered ahead of its producer on purpose: lake.objects.object_type
-- is free text with no CHECK, no enum and no FK, so an unregistered family is never
-- rejected — it is silently invisible to every consumer that string-matches. Registering
-- it here means the canonicaliser cannot land a family that nothing routes.

alter table ops.materiality_prefilter add column if not exists event_type text;

comment on column ops.materiality_prefilter.event_type is
  'The canonical event this object type represents, for the deterministic prefilter tier. '
  'classify.ts copies it onto ops.classifier_verdicts / ops.pipeline_items so the research '
  'and angle layers have a key on every piece, not only on pieces that went to the LLM tier.';

insert into ops.materiality_prefilter (object_type, verdict, priority, template_hint, accepted_states, note)
values
  ('COMPUTED.RATIOS', 'not_material', null, null, '{VERIFIED}',
   'derived recompute, never material alone — mirrors COMPUTED.SCORE. Without this row the '
   'NULL verdict passes the not_material short-circuit and 737 objects reach the LLM tier.'),
  ('FINANCIALS.XCHECK', 'not_material', null, null, '{VERIFIED}',
   'a cross-check verdict is evidence ABOUT a fact, not a fact — it corroborates '
   'FILING.FINANCIALS and is never itself the story.'),
  ('FILING.EVENT', 'not_material', null, null, '{VERIFIED,PENDING}',
   'retrieval substrate, not a trigger: one object per comprehended filing so the research '
   'stage has a citable, event-typed handle on the corpus. Deliberately not_material — '
   'making it material would open a story per filing.'),
  ('INDEX.LEVEL', 'not_material', null, null, '{VERIFIED}',
   'an index close is market context, never a story on its own — same posture as '
   'OHLCV.CLOSE and QUOTE.LAST. Found by this migration''s own completeness assertion.')
on conflict (object_type) do nothing;

update ops.materiality_prefilter set event_type = v.event_type
  from (values
    ('FILING.FINANCIALS',  'EARNINGS_RESULT'),
    ('EARNINGS.VERDICT',   'EARNINGS_RESULT'),
    ('DIVIDEND.EXDATE',    'DIVIDEND_DECLARED'),
    ('DISCLOSURE.DPS',     'DIVIDEND_DECLARED'),
    ('IPO.OFFER',          'IPO_STEP'),
    ('FILING.EVENT',       'CORPORATE_EVENT'),
    ('FILING.REF',         'CORPORATE_EVENT')
  ) as v(object_type, event_type)
 where ops.materiality_prefilter.object_type = v.object_type;

do $$
declare
  v_missing text;
  v_material_no_event text;
begin
  -- Every object type that exists in the lake must have a prefilter row, or its verdict
  -- is NULL and it silently escalates.
  select string_agg(distinct o.object_type, ', ')
    into v_missing
    from lake.objects o
   where not exists (select 1 from ops.materiality_prefilter m where m.object_type = o.object_type);
  if v_missing is not null then
    raise exception 'lake object types with no prefilter row: %', v_missing;
  end if;

  -- Anything that can trigger a piece needs an event_type for the research/angle layer.
  select string_agg(object_type, ', ')
    into v_material_no_event
    from ops.materiality_prefilter
   where verdict <> 'not_material' and event_type is null;
  if v_material_no_event is not null then
    raise exception 'triggering types with no event_type: %', v_material_no_event;
  end if;
end $$;

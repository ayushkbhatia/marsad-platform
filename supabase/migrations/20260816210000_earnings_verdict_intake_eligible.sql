-- EARNINGS.VERDICT becomes admissible while PENDING — otherwise 5,781 new objects are inert.
--
-- The canonicaliser (20260816200000) created 5,781 EARNINGS.VERDICT objects and
-- ops.v_intake_pending still showed only FILING.FINANCIALS. The reason:
-- ops.materiality_prefilter.accepted_states for EARNINGS.VERDICT is {VERIFIED}, and nothing
-- can ever verify one. It is derived from public.earnings_events by our own projection, so it
-- has no second source to be corroborated against and is not price-sensitive, so no human
-- confirms it either. {VERIFIED} means "never".
--
-- The provenance-floor test (09 §3.2) is not "did two scrapers agree" but "does this trace to
-- a primary document we hold". It does: payload.source_filing_id is the results filing, and
-- payload.earnings_event_id is the row it was computed from. That is the same standard on
-- which FILING.FINANCIALS was widened to {VERIFIED,PENDING} in PE.6.
--
-- Applies to both gates for the same reason: accepted_states (may it trigger a piece) and
-- citable_states (may a piece quote it). A verdict that can trigger a story but cannot be
-- cited in it would be a new deadlock of exactly the kind R-03's floor was written to end.
--
-- DISCLOSURE.DPS and DIVIDEND.EXDATE deliberately do NOT move: they are price-sensitive,
-- lake.fn_object_state_guard requires a human verifier, and the desk confirm IS their intake
-- gate. They stay {VERIFIED} until ops.desk_confirm_lake_object exists.

update ops.materiality_prefilter
   set accepted_states = array['VERIFIED','PENDING'],
       citable_states  = array['VERIFIED','PENDING']
 where object_type = 'EARNINGS.VERDICT';

do $$
declare v_admissible int; v_recent int;
begin
  select coalesce(sum(admissible),0), coalesce(sum(within_recency),0)
    into v_admissible, v_recent
    from ops.v_intake_pending where object_type = 'EARNINGS.VERDICT';

  raise notice 'EARNINGS.VERDICT now admissible: % (% within the 120-day recency floor)',
    v_admissible, v_recent;

  if v_admissible = 0 then
    raise exception 'EARNINGS.VERDICT is still not admissible after widening its states';
  end if;
end $$;

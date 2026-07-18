-- fix_feed_status_sweep_incident_dedup
--
-- Stop ingest.sweep_feed_status() stacking a NEW feed:<venue> incident every trading day
-- for one persistently-dead feed — and stop a RECOVERED feed orphaning its incident open
-- forever. Closes audit-2026-07-15 open item (a) ("the feed:* incidents come from
-- ingest.sweep_feed_status, which is a SEPARATE subsystem also not session-aware"), the
-- last untouched half of the false-incident cleanup; job:* was done by 20260715161005 /
-- 20260716121312 / 20260716130004 / 20260717101959.
--
-- ROOT CAUSE — 'closed' RESETS the transition memory instead of being SUPPRESSED BY it.
-- Both incident rules were edge-triggered on the previously STORED state (v_old), but the
-- state machine overwrites that state with 'closed' at every market close. 'closed' means
-- "no information about the feed", yet it participates in the memory, so both edges read a
-- lie on the next session's first tick:
--
--   (1) DUPLICATE RAISE — `if v_new = 'offline' and coalesce(v_old,'') <> 'offline'`.
--       A permanently-dead feed cycles offline (in session) → closed (at market close) →
--       offline (next open). On that last edge v_old = 'closed', so `<> 'offline'` is TRUE
--       and it inserts a SECOND incident while the first is still open and unresolved.
--       One new duplicate per venue per trading day, forever.
--       Live 2026-07-17: two open feed:ADX rows with identical messages ("ADX quotes feed
--       OFFLINE — last sync 2026-07-15 11:07:19"), ids 17879 (created 07-16 06:00) and
--       18145 (created 07-17 06:00) — exactly 24 h apart. Same pattern for feed:BHB.
--
--   (2) ORPHANED RESOLVE — `if v_new = 'live' and coalesce(v_old,'') = 'offline'`. The
--       mirror image of the same bug; unobserved so far only because neither dead feed has
--       yet recovered. enqueue_due_jobs() enqueues session_only feeds with a 10-min
--       PRE-OPEN grace (`venue_is_open(venue, now(), interval '10 minutes', interval '20
--       minutes')`) while this sweep's own gate takes NO grace (`venue_is_open(code,
--       now())` — p_grace_before defaults to '0'). So a feed that recovers overnight lands
--       a fresh last_success_at BEFORE the sweep calls the venue open: the first in-session
--       tick reads v_last ≈ 8 min old → v_new = 'live' while v_old is still 'closed'. The
--       resolve edge never fires, and the incident + its banner stay open forever.
--
-- FIX — adopt the job:* shape (20260716121312, extended by 20260717101959):
--
--   (1) RAISE — dedupe on the OPEN INCIDENT, not on v_old:
--         `not exists (select 1 from ops.incidents i
--                      where i.source = 'feed:'||code and i.resolved_at is null)`
--       byte-for-byte the guard ops.heartbeat_sentinel uses. An already-flagged feed cannot
--       stack a second incident no matter what the state machine does in between, so
--       'closed' can no longer reset anything. This makes the rule level-triggered-with-
--       dedupe: if the open incident is resolved while the feed is still dead, the next tick
--       re-raises. That is the same contract as the job:* sentinel and the correct one — a
--       resolved incident on a still-dead feed is a lie.
--       Deliberately NOT scoped to auto_expire, also matching heartbeat_sentinel: a
--       desk-PINNED open feed:<venue> incident suppresses the sweep's own raise, because
--       there is already an open incident saying that feed is broken.
--
--   (2) RESOLVE — keep the existing live→resolve edge and its auto_expire scoping (a
--       desk-pinned incident stays pinned), but accept v_old = 'closed' as well as
--       'offline' so the pre-open-grace path above resolves.
--       'halted'/'auction' stay EXCLUDED: they are desk-set MARKET states that the sweep
--       must never clear (the same law the upsert's WHERE clause enforces), and during a
--       halt the board still serves quotes — v_new computes to 'live' — so v_old is the
--       only thing standing between a halt and a wrongly-cleared halt banner. Keeping the
--       edge (rather than going level-triggered on v_new='live' alone) is what preserves
--       that.
--       'delayed'/'reconnecting' are not listed because they are unreachable on a recovery:
--       v_last jumps straight to ~now() on the first successful poll, so an offline feed
--       goes offline→live in ONE tick. Those states only occur as a LIVE feed ages, and
--       carry no incident anyway.
--
-- Banner note: the widened edge means a HEALTHY venue now runs the auto_expire_on_recovery
-- banner clear once per day (closed→live at open) where it previously never ran. That is
-- the banner's own contract (clear when the venue's feed is back), and it is inert today —
-- ops.incident_banners.created_by is `not null references iam.principals(id)`, i.e. banners
-- are Desk-33a-composed (05 §9.3) and nothing writes them yet.
--
-- NOT session-awareness in the ops.ingest_job_expected_silent sense: this sweep is already
-- calendar-gated (it computes 'closed' from ingest.venue_is_open, and never raises off
-- session). Its bug was the transition MEMORY, not the gate.
--
-- Then resolve the duplicates already stacked live.
--
-- Pure SQL, idempotent (CREATE OR REPLACE + a conditional UPDATE) — safe to replay from
-- scratch or re-run.

set search_path = '';

-- ---------------------------------------------------------------------------
-- Loop B (01 §8): pure SQL over ingest.sources + calendar; the single writer of
-- public.venue_feed_status. Thresholds at quotes cadence C = 10 min.
-- Unchanged from 20260713000005 except the two incident rules at the bottom.
create or replace function ingest.sweep_feed_status() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_new text;
  v_old text;
  v_last timestamptz;
begin
  for r in select code from public.venues where is_active
  loop
    select max(s.last_success_at) into v_last
    from ingest.sources s
    where s.venue = r.code and s.data_type = 'quotes' and s.active;

    if not ingest.venue_is_open(r.code, now()) then
      v_new := 'closed';
    elsif v_last is null or now() - v_last > interval '45 minutes' then
      v_new := 'offline';
    elsif now() - v_last > interval '30 minutes' then
      v_new := 'delayed';
    elsif now() - v_last > interval '15 minutes' then
      v_new := 'reconnecting';
    else
      v_new := 'live';
    end if;

    select state into v_old from public.venue_feed_status where venue_code = r.code;

    insert into public.venue_feed_status (venue_code, state, last_sync_at, updated_at)
    values (r.code, v_new, v_last, now())
    on conflict (venue_code) do update
      set state        = excluded.state,
          last_sync_at = excluded.last_sync_at,
          retry_count  = case when excluded.state in ('reconnecting','delayed','offline')
                              then public.venue_feed_status.retry_count + 1 else 0 end,
          updated_at   = now()
      -- halted/auction are market states set by the desk/parsers; the pipeline
      -- sweep never overwrites them (01 §8).
      where public.venue_feed_status.state not in ('halted','auction')
         or excluded.state = 'closed';

    -- RAISE — one open incident per feed, however the state machine wanders in between.
    -- Guarded on the OPEN INCIDENT rather than on v_old: 'closed' overwrites v_old at every
    -- market close, so the old `v_old <> 'offline'` edge re-raised a duplicate on the next
    -- session's first tick. Same not-exists guard as ops.heartbeat_sentinel.
    if v_new = 'offline' and not exists (
         select 1 from ops.incidents i
         where i.source = 'feed:' || r.code and i.resolved_at is null
       ) then
      insert into ops.incidents (severity, source, message)
      values ('degraded', 'feed:' || r.code,
              r.code || ' quotes feed OFFLINE — last sync ' || coalesce(v_last::text, 'never'));
    end if;

    -- RESOLVE — recovery closes the auto-expiring incident + banner. v_old = 'closed' is
    -- accepted because the scheduler's 10-min pre-open grace can land a successful poll
    -- before this sweep (no grace) calls the venue open, making closed→live the NORMAL
    -- recovery edge. 'halted'/'auction' remain excluded — the sweep must not clear a
    -- desk-set market state, and a halted venue's board still quotes (v_new = 'live').
    if v_new = 'live' and coalesce(v_old, '') in ('offline', 'closed') then
      update ops.incidents set resolved_at = now()
      where source = 'feed:' || r.code and resolved_at is null and auto_expire;
      update ops.incident_banners set cleared_at = now()
      where venue_code = r.code and cleared_at is null and auto_expire_on_recovery;
    end if;
  end loop;
end $$;

comment on function ingest.sweep_feed_status() is
  'Loop B (01 §8): single writer of public.venue_feed_status. Raises one degraded feed:<venue> '
  'incident while a venue''s quotes feed is offline (deduped on the open incident, not on the '
  'previous state — ''closed'' resets that memory every market close) and resolves it + its '
  'auto-expiring banner on recovery, including the closed->live edge the scheduler''s pre-open '
  'grace makes normal.';

-- ---------------------------------------------------------------------------
-- One-time: collapse the duplicates already stacked live (feed:ADX ×2, feed:BHB ×2 as of
-- 2026-07-17). Keep the OLDEST open row per source — it carries the true outage start, and
-- the newer rows are pure closed→offline artifacts with identical messages. The fixed sweep
-- will not regenerate them; a feed that is still offline keeps exactly one open incident.
-- Scoped to feed:* — job:* belongs to ops.heartbeat_sentinel, which now self-resolves.
-- Idempotent: re-running finds one open row per source and matches nothing.
update ops.incidents i
   set resolved_at = now()
 where i.resolved_at is null
   and i.source like 'feed:%'
   and exists (
     select 1 from ops.incidents j
     where j.source = i.source
       and j.resolved_at is null
       and (j.created_at, j.id) < (i.created_at, i.id)
   );

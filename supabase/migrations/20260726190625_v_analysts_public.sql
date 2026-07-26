-- 20260726190625 — public.v_analysts_public: the anon-safe analyst identity view
-- (BRIDGE-BUILD-PLAN P0.5).
--
-- THE GAP THIS CLOSES: `public.analysts` is world-readable but carries NO name and NO slug —
-- its only identity column is `principal_id -> iam.principals`, and `iam` has a `worker_read`
-- policy and nothing else (0713000014_rls.sql §2). So `getAnalystProfileBySlug` was a stub *by
-- construction*: there was no schema path from a URL slug to an analyst, independent of row
-- count. `iam.principals.handle` IS the public slug; this view is the only place that mapping
-- is exposed.
--
-- SECURITY: `security_invoker = false` (the view runs as its owner) is the same pattern as
-- public.v_scores_public / public.v_key_ratios_public — it is how anon reaches a worker-only
-- relation through a deliberately narrowed column list. This trips the ERROR-level
-- `security_definer_view` advisor; that is INTENDED and documented (BRIDGE-PLAN §1).
--
-- `revenue_share_pct` is deliberately NOT selected — it is commercial terms between Marsad and
-- an external contributor, never public. Do not add it.
--
-- The filter `p.is_active and p.purged_at is null` means a deactivated or GDPR-purged principal
-- disappears from the public roster with no application change.

set search_path = '';

create or replace view public.v_analysts_public with (security_invoker = false) as
  select
    p.handle       as slug,
    p.display_name as display_name,
    a.title,
    a.credential,
    a.bio,
    a.is_external,
    a.joined_at,
    a.principal_id
  from public.analysts a
  join iam.principals p on p.id = a.principal_id
  where p.is_active
    and p.purged_at is null;

comment on view public.v_analysts_public is
  'Anon-safe analyst roster — joins public.analysts to iam.principals for the public slug '
  '(= principals.handle) and display_name. revenue_share_pct is intentionally excluded. '
  'security_invoker=false by design (mirrors v_scores_public); BRIDGE-BUILD-PLAN P0.5.';

grant select on public.v_analysts_public to anon, authenticated;

-- 20260720161000_v_scores_public_headline — the anon-readable HEADLINE of the
-- Marsad Score. Financials and the factor GRADES are premium-gated (owner
-- decision): public.scores has RLS enabled with no anon policy, so anon reads of
-- the base table return zero rows. The reader's public surface needs only the
-- headline number + AI rating + weekly delta; the five factor grades
-- (grade_value/growth/profitability/momentum/revisions) and the percentile stay
-- behind the premium RPC path.
--
-- Mechanism mirrors the existing public wrapper views (public.v_desk_approvals in
-- 20260720151411, public.v_lake_landing_* in 20260719170000): a plain view that
-- runs with the view OWNER's privileges (security_invoker = false) so it can read
-- the RLS-protected base table, then SELECT granted to the public roles. Unlike
-- the lake wrappers (security_invoker = true, service_role only) this one is
-- deliberately owner-privileged and granted to anon/authenticated, because anon
-- cannot read public.scores itself — the view IS the sanctioned exposure surface.
--
-- The projection lists ONLY the five headline columns. Adding grade_* here would
-- leak the gated factors, so the column list is the security boundary — keep it.
-- (Supabase's advisor will flag this as a "Security Definer View"; that is the
-- intended, column-restricted exposure, not a defect.)

set search_path = '';

create or replace view public.v_scores_public
  with (security_invoker = false) as
  select
    security_id,
    score,           -- 0..100 headline number
    rating,          -- BUY | OVERWEIGHT | HOLD | UNDERWEIGHT | SELL (AI rating)
    weekly_delta,    -- signed points move vs last week (headline delta line)
    computed_at      -- as-of stamp for the "UPDATED …" footnote
  from public.scores;

-- Fail closed: strip default grants, then expose read-only to the public roles.
revoke all on public.v_scores_public from public, anon, authenticated;
grant select on public.v_scores_public to anon, authenticated;
-- service_role keeps read for server/admin surfaces.
grant select on public.v_scores_public to service_role;

comment on view public.v_scores_public is
  'Anon-readable HEADLINE of public.scores (security_id, score, rating, weekly_delta, computed_at). '
  'Owner-privileged (security_invoker=false) so it bypasses the premium RLS on public.scores; '
  'factor grades + percentile are deliberately excluded and stay premium-gated. '
  'Read by createAnonClient() in src/lib/data/stocks.ts. See 04-reader-app.md §5.';

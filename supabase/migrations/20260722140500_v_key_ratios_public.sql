-- 20260722140500 — anon-readable wrapper over the FREE key_ratios columns.
--
-- key_ratios has only a `worker_all` RLS policy (no world_read), so anon sees zero
-- rows and the reader Compare page renders every ratio as "—". This mirrors
-- public.v_scores_public exactly: an owner-privileged view exposing ONLY the
-- non-premium columns. The PREMIUM valuation ratios (pe, pb, roe, dividend_yield,
-- payout_ratio, ev_ebitda, ps, nim, etc.) are deliberately NOT selected here — they
-- stay gated until the entitlement model ships. Free fields = identity metrics,
-- returns, margins and growth, matching what the screener/compare already treat as public.

set search_path = '';

create or replace view public.v_key_ratios_public as
  select
    security_id,
    market_cap,
    eps_ttm,
    net_margin,
    gross_margin,
    rev_growth_yoy,
    eps_growth_yoy,
    rev_cagr_3y,
    eps_cagr_3y,
    ret_3m,
    ret_6m,
    ret_12_1,
    currency_computed,
    computed_at
  from public.key_ratios;

comment on view public.v_key_ratios_public is
  'Anon-safe headline of key_ratios — FREE columns only (identity/returns/margins/growth). '
  'Premium valuation ratios (pe/pb/roe/dividend_yield/…) are intentionally excluded. Mirrors v_scores_public.';

grant select on public.v_key_ratios_public to anon, authenticated;

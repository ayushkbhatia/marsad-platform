import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum } from "./util";

/**
 * Anon-safe per-security ratio + headline-score reads.
 *
 * Both base tables are premium-gated (`key_ratios` is `worker_all` only;
 * `scores` is `premium_read{authenticated}`), so these read ONLY the
 * SECURITY DEFINER wrapper views — `public.v_key_ratios_public` and
 * `public.v_scores_public` — exactly as `stocks.ts` and `entities.ts` do.
 *
 * WHAT THE FREE RATIO VIEW ACTUALLY CARRIES (measured 2026-07-26):
 *   market_cap, eps_ttm, net_margin, gross_margin, rev_growth_yoy,
 *   eps_growth_yoy, rev_cagr_3y, eps_cagr_3y, ret_3m, ret_6m, ret_12_1,
 *   currency_computed
 * It does NOT carry P/B, dividend yield, ROE or EV/EBITDA. Those are rendered
 * "—" by the adapter rather than derived from something they aren't
 * (DEF-STOCK-RATIO-GAPS). P/E is the one honest derivation: price ÷ eps_ttm.
 */

export interface KeyRatiosRow {
  securityId: number;
  marketCap: number | null;
  epsTtm: number | null;
  netMargin: number | null;
  grossMargin: number | null;
  revGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  revCagr3y: number | null;
  epsCagr3y: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret12m1: number | null;
  currency: string | null;
  computedAt: string | null;
}

export async function getKeyRatiosRow(securityId: number): Promise<KeyRatiosRow | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data } = await sb
    .from("v_key_ratios_public")
    .select(
      "security_id,market_cap,eps_ttm,net_margin,gross_margin,rev_growth_yoy,eps_growth_yoy,rev_cagr_3y,eps_cagr_3y,ret_3m,ret_6m,ret_12_1,currency_computed,computed_at",
    )
    .eq("security_id", securityId)
    .maybeSingle<Record<string, unknown>>();

  if (!data) return null;
  return {
    securityId,
    marketCap: toNum(data.market_cap),
    epsTtm: toNum(data.eps_ttm),
    netMargin: toNum(data.net_margin),
    grossMargin: toNum(data.gross_margin),
    revGrowthYoy: toNum(data.rev_growth_yoy),
    epsGrowthYoy: toNum(data.eps_growth_yoy),
    revCagr3y: toNum(data.rev_cagr_3y),
    epsCagr3y: toNum(data.eps_cagr_3y),
    ret3m: toNum(data.ret_3m),
    ret6m: toNum(data.ret_6m),
    ret12m1: toNum(data.ret_12_1),
    currency: (data.currency_computed as string | null)?.trim() || null,
    computedAt: (data.computed_at as string | null) ?? null,
  };
}

export interface HeadlineScoreRow {
  score: number | null;
  rating: string | null;
  weeklyDelta: number | null;
  computedAt: string | null;
}

export async function getHeadlineScore(securityId: number): Promise<HeadlineScoreRow | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data } = await sb
    .from("v_scores_public")
    .select("score,rating,weekly_delta,computed_at")
    .eq("security_id", securityId)
    .maybeSingle<{
      score: number | null;
      rating: string | null;
      weekly_delta: number | null;
      computed_at: string | null;
    }>();

  if (!data) return null;
  return {
    score: toNum(data.score),
    rating: data.rating?.trim() || null,
    weeklyDelta: toNum(data.weekly_delta),
    computedAt: data.computed_at ?? null,
  };
}

/**
 * P/E from the free view — price ÷ trailing EPS.
 *
 * ⚠️ Returns null for TDWL. `DEF-TDWL-EPS-MAPPING` is OPEN: the Tadawul XBRL
 * extractor writes `net_income` into `eps_diluted`, so `eps_ttm` for a TDWL
 * name is off by orders of magnitude and any P/E built on it is nonsense.
 * Showing "—" is correct until that extractor is fixed; showing a number would
 * be worse than showing nothing (Law #2).
 */
export function derivePe(
  price: number | null,
  epsTtm: number | null,
  venueCode: string,
): number | null {
  if (venueCode.toUpperCase() === "TDWL") return null;
  if (price == null || epsTtm == null || epsTtm <= 0) return null;
  const pe = price / epsTtm;
  return Number.isFinite(pe) && pe > 0 && pe < 1000 ? pe : null;
}

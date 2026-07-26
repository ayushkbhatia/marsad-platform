import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";

/**
 * The prerender head for the stock workspace.
 *
 * Owner decision **D-6(b)** (`docs/BRIDGE-BUILD-PLAN.md` §2): 705 quoted names
 * × 7 tabs is ~4,900 prerendered pages for very little benefit — a long build
 * for a long tail nobody requests. Prerender the most-traded head and let the
 * rest render on demand; both paths are identical code, so an on-demand name is
 * not second-class, it just isn't warm.
 *
 * Sorted by `value_traded` on the most recent session rather than by market cap:
 * turnover is what actually predicts which pages get requested.
 *
 * MUST stay deterministic — `generateStaticParams` runs at build time, so no
 * wall-clock reads and no request state (`cacheComponents` rule).
 */
const PRERENDER_LIMIT = 60;

export interface StockParam {
  venue: string;
  ticker: string;
}

export async function listPrerenderStocks(): Promise<StockParam[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("securities");

  const sb = createAnonClient();

  // Most recent trade date present in the daily bars, then that day's turnover
  // leaders. Two steps because `ohlcv_daily` has no "is latest" flag.
  const { data: latest } = await sb
    .from("ohlcv_daily")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ trade_date: string }>();

  if (!latest?.trade_date) return [];

  const { data: bars } = await sb
    .from("ohlcv_daily")
    .select("security_id,value_traded")
    .eq("trade_date", latest.trade_date)
    .order("value_traded", { ascending: false, nullsFirst: false })
    .limit(PRERENDER_LIMIT);

  const ids = (bars ?? []).map((b) => (b as { security_id: number }).security_id);
  if (ids.length === 0) return [];

  const { data: secs } = await sb
    .from("securities")
    .select("id,venue_code,ticker,status")
    .in("id", ids)
    .in("status", ["listed", "suspended"]);

  const order = new Map(ids.map((id, i) => [id, i]));
  return ((secs as Array<{ id: number; venue_code: string; ticker: string }> | null) ?? [])
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((s) => ({ venue: s.venue_code, ticker: s.ticker }));
}

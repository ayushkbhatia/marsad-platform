import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { prerenderHead } from "@/lib/data/prerender";
import type { SupabaseClient } from "@supabase/supabase-js";

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
 *
 * The turnover query needs `ohlcv_daily_date_turnover` (20260727170000). Without
 * that index it is a 609,723-row seq scan — 1,855 ms measured privileged and
 * warm — which blows the `anon` role's 3s statement_timeout every time. Until
 * the index is applied this path fails on every build and the listed head is
 * what actually ships. See `prerenderHead` for why that is a fallback and not
 * a build failure.
 */
const PRERENDER_LIMIT = 60;

export interface StockParam {
  venue: string;
  ticker: string;
}

type Sb = SupabaseClient;

/**
 * The intended head: the latest session's turnover leaders.
 *
 * Throws rather than returning `[]` on any DB error, so the caller can tell
 * "this query failed" from "this query found nothing".
 */
async function turnoverHead(sb: Sb): Promise<StockParam[]> {
  // Most recent trade date present in the daily bars, then that day's turnover
  // leaders. Two steps because `ohlcv_daily` has no "is latest" flag.
  const latest = await sb
    .from("ohlcv_daily")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ trade_date: string }>();
  if (latest.error) throw new Error(`ohlcv_daily latest trade_date: ${latest.error.message}`);
  if (!latest.data?.trade_date) return [];

  // Served by `ohlcv_daily_date_turnover` (20260727170000). Without that index
  // this is a full-table scan plus a sort, and it times out as `anon`.
  const bars = await sb
    .from("ohlcv_daily")
    .select("security_id,value_traded")
    .eq("trade_date", latest.data.trade_date)
    .order("value_traded", { ascending: false, nullsFirst: false })
    .limit(PRERENDER_LIMIT);
  if (bars.error) throw new Error(`ohlcv_daily turnover leaders: ${bars.error.message}`);

  const ids = (bars.data ?? []).map((b) => (b as { security_id: number }).security_id);
  if (ids.length === 0) return [];

  const secs = await sb
    .from("securities")
    .select("id,venue_code,ticker,status")
    .in("id", ids)
    .in("status", ["listed", "suspended"]);
  if (secs.error) throw new Error(`securities for turnover head: ${secs.error.message}`);

  const order = new Map(ids.map((id, i) => [id, i]));
  return ((secs.data as Array<{ id: number; venue_code: string; ticker: string }> | null) ?? [])
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((s) => ({ venue: s.venue_code, ticker: s.ticker }));
}

/**
 * The floor: a deterministic slice of the listed universe, ordered by venue then
 * ticker so two builds of the same commit prerender the same pages.
 *
 * Reads only `securities` (~767 rows, indexed), so it cannot be the slow query.
 * It ranks by nothing meaningful, and that is accepted — its whole job is to
 * stop a turnover outage from becoming a deploy outage.
 */
async function listedHead(sb: Sb): Promise<StockParam[]> {
  const secs = await sb
    .from("securities")
    .select("venue_code,ticker")
    .eq("status", "listed")
    .order("venue_code", { ascending: true })
    .order("ticker", { ascending: true })
    .limit(PRERENDER_LIMIT);
  if (secs.error) throw new Error(`securities prerender fallback: ${secs.error.message}`);

  // An empty result here is handled by `prerenderHead`, which throws — one place
  // owns that rule rather than each caller restating it.
  return ((secs.data as Array<{ venue_code: string; ticker: string }> | null) ?? []).map((s) => ({
    venue: s.venue_code,
    ticker: s.ticker,
  }));
}

export async function listPrerenderStocks(): Promise<StockParam[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("securities");

  const sb = createAnonClient();
  return prerenderHead("stocks", () => turnoverHead(sb), () => listedHead(sb));
}

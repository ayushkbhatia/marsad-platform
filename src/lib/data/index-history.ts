import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum } from "./util";

/**
 * Daily index closes — the series behind the home page's Live Markets sparkline.
 *
 * WHY `index_levels_daily` AND NOT `index_levels`: the intraday table is written
 * by a 10-minute timer that runs 24/7, so off-session it repeats the last level
 * verbatim — TASI has 723 intraday rows but only **34 distinct levels**, and the
 * most recent 12 are byte-identical. A sparkline drawn from those would be a
 * mostly-flat line that misrepresents the session. The daily table is one row
 * per trade date, which is what the design's sparkline actually means.
 *
 * HONEST LIMIT: `index_levels_daily` currently holds only ~6 trade dates per
 * index (backfill pending, DEF-INDEX-LEVELS follow-ups). The adapter therefore
 * labels the sparkline with its true date range instead of implying a long
 * history, and renders nothing at all below 2 points.
 */
export interface IndexDailyPoint {
  tradeDate: string;
  close: number;
}

export async function getIndexDailySeries(
  indexCode: string,
  limit = 30,
): Promise<IndexDailyPoint[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("indices");

  const take = Math.min(Math.max(limit, 2), 400);
  const sb = createAnonClient();
  const { data } = await sb
    .from("index_levels_daily")
    .select("trade_date,close")
    .eq("index_code", indexCode.toUpperCase())
    .order("trade_date", { ascending: false })
    .limit(take);

  const rows = ((data as Array<{ trade_date: string; close: unknown }> | null) ?? [])
    .map((r) => ({ tradeDate: r.trade_date, close: toNum(r.close) }))
    .filter((r): r is IndexDailyPoint => r.close != null);

  // newest-first from the query → oldest-first for drawing
  return rows.reverse();
}

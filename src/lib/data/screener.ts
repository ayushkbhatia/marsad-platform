import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

/**
 * Screener universe — the PUBLIC, cacheable base set the `/api/screener/run`
 * route filters/sorts/paginates in memory. Reading it once per revalidation
 * window (instead of per filter-combo request) keeps origin cost flat no matter
 * how many filter permutations clients try.
 *
 * PUBLIC COLUMNS ONLY: identity + latest quote (price/change/volume) + the
 * HEADLINE Marsad Score (number + rating from `public.v_scores_public`). It does
 * NOT read `key_ratios` or `financial_statements` — the valuation ratio columns
 * (P/E, P/B, ROE, yield) are premium and are rendered as locked stubs client-side,
 * never sourced here. There is intentionally no code path in this module that
 * can reach a premium table.
 */

export interface ScreenerRow {
  securityId: number;
  venueCode: string;
  ticker: string;
  name: string;
  sector: string;
  sectorName: string;
  currency: string | null;
  last: number | null;
  changePct: number | null;
  volume: number | null;
  tickDir: number | null;
  score: number | null;
  rating: string | null;
}

export async function getScreenerUniverse(): Promise<ScreenerRow[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("screener");
  cacheTag("movers");

  const sb = createAnonClient();
  const [{ data: secs }, { data: quotes }, { data: scores }, { data: sectors }] = await Promise.all([
    sb
      .from("securities")
      .select("id,venue_code,ticker,name_en,sector,currency,status")
      .in("status", ["listed", "suspended"]),
    sb.from("quotes_latest").select("security_id,last,change_pct,volume,tick_dir"),
    sb.from("v_scores_public").select("security_id,score,rating"),
    sb.from("sectors").select("key,name"),
  ]);

  const quoteById = new Map<number, { last: unknown; change_pct: unknown; volume: unknown; tick_dir: number | null }>();
  for (const q of (quotes as Array<{ security_id: number; last: unknown; change_pct: unknown; volume: unknown; tick_dir: number | null }> | null) ?? []) {
    quoteById.set(q.security_id, q);
  }
  const scoreById = new Map<number, { score: number | null; rating: string | null }>();
  for (const s of (scores as Array<{ security_id: number; score: number | null; rating: string | null }> | null) ?? []) {
    scoreById.set(s.security_id, { score: s.score, rating: s.rating });
  }
  const sectorName = new Map<string, string>();
  for (const s of (sectors as Array<{ key: string; name: string }> | null) ?? []) {
    sectorName.set(s.key, s.name);
  }

  return ((secs as Array<{ id: number; venue_code: string; ticker: string; name_en: string; sector: string | null; currency: string | null }> | null) ?? [])
    .map((s) => {
      const q = quoteById.get(s.id);
      const sc = scoreById.get(s.id);
      const key = s.sector ?? "unknown";
      return {
        securityId: s.id,
        venueCode: s.venue_code,
        ticker: s.ticker,
        name: s.name_en,
        sector: key,
        sectorName: sectorName.get(key) ?? key,
        currency: s.currency ?? null,
        last: toNum(q?.last),
        changePct: toNum(q?.change_pct),
        volume: toNum(q?.volume),
        tickDir: toInt(q?.tick_dir ?? null),
        score: toInt(sc?.score ?? null),
        rating: sc?.rating ?? null,
      };
    });
}

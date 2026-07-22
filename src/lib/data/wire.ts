import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum } from "./util";

/**
 * Newswire (1d)-specific reads that sit alongside `./filings.ts` without
 * editing it: a per-venue activity facet for the left-rail VENUE checklist
 * (mirrors `getFilingTypeFacets`'s bounded-recency-scan approach), an exact
 * "today" count for the header's LIVE status, and a light `quotes_latest`
 * batch fetch so the center feed's ticker chips can show a real change % —
 * same shape as `newsroom.ts`'s internal `quoteLiteMap`, kept local here so
 * this file never imports a runtime value from that slice either.
 */

export const WIRE_VENUE_CODES = ["TDWL", "DFM", "ADX", "QE", "MSX", "BHB"] as const;

export interface WireVenueFacet {
  venue: string;
  count: number;
}

/**
 * Recent-activity count per venue across the last ~4000 filings (same
 * bounded-scan posture as `getFilingTypeFacets` — a busiest-first read, not
 * an exact lifetime total). Fixed venue order (not sorted by count) so the
 * left-rail checklist doesn't reflow as counts change. ~10 min cache, tagged
 * `filings` (same tag `filings.ts` uses, so a filings ingest invalidates
 * this too).
 */
export async function getWireVenueFacets(): Promise<WireVenueFacet[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("filings");

  const sb = createAnonClient();
  const { data } = await sb
    .from("filings")
    .select("venue_code")
    .order("filed_at", { ascending: false })
    .limit(4000);

  const counts = new Map<string, number>();
  for (const r of (data as Array<{ venue_code: string | null }> | null) ?? []) {
    const v = (r.venue_code ?? "").trim().toUpperCase();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return WIRE_VENUE_CODES.map((v) => ({ venue: v, count: counts.get(v) ?? 0 }));
}

/**
 * Exact count of filings filed since UTC midnight "today" — the header's
 * "· N TODAY" figure. Honors the same venue/type facets as the feed itself
 * so the count matches what's actually on screen. ~30s cache (same window as
 * `getWireFilings`), tagged `filings`.
 */
export async function getFilingsTodayCount(opts: { venue?: string; type?: string } = {}): Promise<number> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 30, expire: 3600 });
  cacheTag("filings");

  const sb = createAnonClient();
  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();

  let q = sb.from("filings").select("id", { count: "exact", head: true }).gte("filed_at", startOfDay);
  const venue = (opts.venue ?? "").trim().toUpperCase();
  const type = (opts.type ?? "").trim().toUpperCase();
  if (venue) q = q.eq("venue_code", venue);
  if (type) q = q.eq("filing_type", type);

  const { count } = await q;
  return count ?? 0;
}

export interface WireQuoteLite {
  changePct: number | null;
  last: number | null;
}

/**
 * Batch `quotes_latest` lookup for the center feed's ticker chips. Mirrors
 * `newsroom.ts`'s internal (uncached) `quoteLiteMap` helper — deliberately
 * NOT `"use cache"` itself (it returns a `Map`, which the cache layer can't
 * serialize, and its input varies per request anyway); the *page* body that
 * calls it runs inside the route's `<Suspense>` boundary same as every other
 * per-request read here.
 */
export async function getQuotesForSecurities(ids: number[]): Promise<Map<number, WireQuoteLite>> {
  const map = new Map<number, WireQuoteLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;

  const sb = createAnonClient();
  const { data } = await sb
    .from("quotes_latest")
    .select("security_id,change_pct,last")
    .in("security_id", unique);
  for (const r of (data as Array<{ security_id: number; change_pct: unknown; last: unknown }> | null) ?? []) {
    map.set(r.security_id, { changePct: toNum(r.change_pct), last: toNum(r.last) });
  }
  return map;
}

import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";

/**
 * Venue + ticker → securities.id resolver.
 *
 * Tickers are NOT unique across venues — AMAN (DFM/MSX), GFH (ADX/BHB/DFM),
 * ITHMR (BHB/DFM), ORDS (MSX/QE) all collide — so the canonical stock route is
 * `/stocks/[venue]/[ticker]`, and a ticker-only lookup is ambiguous by design.
 * Both `venue` and `ticker` are stored uppercase; inputs are upper-cased here so
 * `/stocks/dfm/emaar` resolves the same as `/stocks/DFM/EMAAR`.
 */

export interface ResolvedSecurity {
  id: number;
  venueCode: string;
  ticker: string;
  name: string;
  status: string;
}

export interface SecurityParam {
  venue: string;
  ticker: string;
}

/** Statuses that get a public stock page (delisted/pre_listing are excluded). */
const PUBLIC_STATUSES = ["listed", "suspended"];

/** Resolve one (venue, ticker) pair to a security, or null if none match. */
export async function resolveSecurity(
  venue: string,
  ticker: string,
): Promise<ResolvedSecurity | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("securities");

  const v = (venue ?? "").trim().toUpperCase();
  const t = (ticker ?? "").trim().toUpperCase();
  if (!v || !t) return null;

  const sb = createAnonClient();
  const { data } = await sb
    .from("securities")
    .select("id,venue_code,ticker,name_en,status")
    .eq("venue_code", v)
    .eq("ticker", t)
    .maybeSingle<{ id: number; venue_code: string; ticker: string; name_en: string; status: string }>();

  if (!data) return null;
  return {
    id: data.id,
    venueCode: data.venue_code,
    ticker: data.ticker,
    name: data.name_en,
    status: data.status,
  };
}

/**
 * Every (venue, ticker) pair with a public stock page — the source for
 * `generateStaticParams` on `/stocks/[venue]/[ticker]`. Under cacheComponents
 * this must be non-empty (the securities universe is ~760 rows).
 */
export async function listSecurityParams(): Promise<SecurityParam[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("securities");

  const sb = createAnonClient();
  const { data } = await sb
    .from("securities")
    .select("venue_code,ticker,status")
    .in("status", PUBLIC_STATUSES)
    .order("venue_code", { ascending: true })
    .order("ticker", { ascending: true });

  return ((data as Array<{ venue_code: string; ticker: string }> | null) ?? []).map((s) => ({
    venue: s.venue_code,
    ticker: s.ticker,
  }));
}

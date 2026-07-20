import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import type { FreshnessBlock } from "@/lib/market/freshness";
import { toFreshnessBlock, toNum, toInt, type VenueFeedRow } from "./util";

/**
 * Public per-security reads. Every export is a `use cache` function reading only
 * anon-RLS tables (securities, quotes_latest, ohlcv_daily, venue_feed_status)
 * plus the headline wrapper `public.v_scores_public`. Financials + the factor
 * grades are premium-gated and are NOT read here.
 *
 * Cached with `stock:{id}` tags so the score batch / filings ingest can call
 * `revalidateTag('stock:'+id)` from a job on update.
 */

export interface QuoteLite {
  last: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  vwap: number | null;
  week52High: number | null;
  week52Low: number | null;
  asOf: string | null;
  delayMinutes: number | null;
  /** -1 down · 0 flat · +1 up (quotes_latest.tick_dir). */
  tickDir: number | null;
}

export interface HeadlineScore {
  securityId: number;
  score: number | null;
  /** BUY | OVERWEIGHT | HOLD | UNDERWEIGHT | SELL (uppercase, from public.scores). */
  rating: string | null;
  weeklyDelta: number | null;
  computedAt: string | null;
}

export interface StockHeader {
  securityId: number;
  ticker: string;
  venueCode: string;
  name: string;
  currency: string | null;
  sector: string | null;
  status: string;
  quote: QuoteLite | null;
  freshness: FreshnessBlock | null;
}

export interface StockOverview extends StockHeader {
  /** Last-N daily closes, oldest → newest, for the inline server sparkline. */
  sparkline: number[];
  sparklineFrom: string | null;
  sparklineTo: string | null;
  score: HeadlineScore | null;
}

/** A single daily bar for the server-rendered price chart (chart tab). */
export interface OhlcvPoint {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface OhlcvSeries {
  points: OhlcvPoint[];
  range: OhlcvRange;
  from: string | null;
  to: string | null;
  /** True when the range was capped (older bars exist beyond `points`). */
  capped: boolean;
}

export type OhlcvRange = "1M" | "3M" | "6M" | "1Y" | "5Y" | "MAX";

/** Lower-bound day windows per range. `MAX` has no lower bound (cap only). */
const RANGE_DAYS: Record<OhlcvRange, number | null> = {
  "1M": 31,
  "3M": 93,
  "6M": 186,
  "1Y": 372,
  "5Y": 1830,
  MAX: null,
};

/** Hard cap on points returned to the SVG chart (keeps the payload/DOM sane). */
const OHLCV_CAP = 2000;

export function normalizeRange(raw: string | null | undefined): OhlcvRange {
  const up = (raw ?? "").trim().toUpperCase();
  return (["1M", "3M", "6M", "1Y", "5Y", "MAX"] as const).includes(up as OhlcvRange)
    ? (up as OhlcvRange)
    : "1Y";
}

interface SecurityRow {
  id: number;
  venue_code: string;
  ticker: string;
  name_en: string;
  sector: string | null;
  currency: string | null;
  status: string;
}

interface QuoteRow {
  security_id: number;
  last: unknown; change: unknown; change_pct: unknown;
  open: unknown; high: unknown; low: unknown; volume: unknown; vwap: unknown;
  week52_high: unknown; week52_low: unknown;
  as_of: string | null; delay_minutes: number | null; tick_dir: number | null;
}

function mapQuote(q: QuoteRow | null | undefined): QuoteLite | null {
  if (!q) return null;
  return {
    last: toNum(q.last),
    change: toNum(q.change),
    changePct: toNum(q.change_pct),
    open: toNum(q.open),
    high: toNum(q.high),
    low: toNum(q.low),
    volume: toNum(q.volume),
    vwap: toNum(q.vwap),
    week52High: toNum(q.week52_high),
    week52Low: toNum(q.week52_low),
    asOf: q.as_of ?? null,
    delayMinutes: toInt(q.delay_minutes),
    tickDir: toInt(q.tick_dir),
  };
}

const QUOTE_COLS =
  "security_id,last,change,change_pct,open,high,low,volume,vwap,week52_high,week52_low,as_of,delay_minutes,tick_dir";

/**
 * Lightweight header: identity + latest quote + venue freshness. Feeds the stock
 * page's quote header (which then polls /api/pulse/quote client-side). ~60s.
 */
export async function getStockHeader(securityId: number): Promise<StockHeader | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data: sec } = await sb
    .from("securities")
    .select("id,venue_code,ticker,name_en,sector,currency,status")
    .eq("id", securityId)
    .maybeSingle<SecurityRow>();

  if (!sec) return null;

  const [{ data: quote }, { data: feed }] = await Promise.all([
    sb.from("quotes_latest").select(QUOTE_COLS).eq("security_id", securityId).maybeSingle<QuoteRow>(),
    sb
      .from("venue_feed_status")
      .select("venue_code,state,detail,last_sync_at,latency_ms")
      .eq("venue_code", sec.venue_code)
      .maybeSingle<VenueFeedRow>(),
  ]);

  return {
    securityId: sec.id,
    ticker: sec.ticker,
    venueCode: sec.venue_code,
    name: sec.name_en,
    currency: sec.currency ?? null,
    sector: sec.sector ?? null,
    status: sec.status,
    quote: mapQuote(quote),
    freshness: toFreshnessBlock(feed),
  };
}

/**
 * Full overview: header + a server-rendered sparkline (last 30 closes) + the
 * headline Marsad Score (number/rating/weekly delta only — grades stay gated).
 * ~10 min, tagged `stock:{id}`.
 */
export async function getStockOverview(securityId: number): Promise<StockOverview | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data: sec } = await sb
    .from("securities")
    .select("id,venue_code,ticker,name_en,sector,currency,status")
    .eq("id", securityId)
    .maybeSingle<SecurityRow>();

  if (!sec) return null;

  const [{ data: quote }, { data: feed }, { data: bars }, { data: scoreRow }] = await Promise.all([
    sb.from("quotes_latest").select(QUOTE_COLS).eq("security_id", securityId).maybeSingle<QuoteRow>(),
    sb
      .from("venue_feed_status")
      .select("venue_code,state,detail,last_sync_at,latency_ms")
      .eq("venue_code", sec.venue_code)
      .maybeSingle<VenueFeedRow>(),
    // Newest-first in the query (keyset on date, never a JS date compare); reversed below.
    sb
      .from("ohlcv_daily")
      .select("trade_date,close")
      .eq("security_id", securityId)
      .order("trade_date", { ascending: false })
      .limit(30),
    sb
      .from("v_scores_public")
      .select("security_id,score,rating,weekly_delta,computed_at")
      .eq("security_id", securityId)
      .maybeSingle<{
        security_id: number; score: number | null; rating: string | null;
        weekly_delta: number | null; computed_at: string | null;
      }>(),
  ]);

  const ordered = ((bars as Array<{ trade_date: string; close: unknown }> | null) ?? [])
    .slice()
    .reverse();
  const sparkline = ordered.map((b) => toNum(b.close)).filter((n): n is number => n !== null);

  const score: HeadlineScore | null = scoreRow
    ? {
        securityId: scoreRow.security_id,
        score: toInt(scoreRow.score),
        rating: scoreRow.rating ?? null,
        weeklyDelta: toInt(scoreRow.weekly_delta),
        computedAt: scoreRow.computed_at ?? null,
      }
    : null;

  return {
    securityId: sec.id,
    ticker: sec.ticker,
    venueCode: sec.venue_code,
    name: sec.name_en,
    currency: sec.currency ?? null,
    sector: sec.sector ?? null,
    status: sec.status,
    quote: mapQuote(quote),
    freshness: toFreshnessBlock(feed),
    sparkline,
    sparklineFrom: ordered.length ? ordered[0].trade_date : null,
    sparklineTo: ordered.length ? ordered[ordered.length - 1].trade_date : null,
    score,
  };
}

/** Compute a `YYYY-MM-DD` lower bound `days` before today (UTC). */
function cutoffDate(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Daily OHLCV series for the server-rendered price chart. Newest-first keyset in
 * the query (date filtering stays in SQL — never a JS Date compare), capped at
 * `OHLCV_CAP`, then reversed to oldest→newest for the SVG path. `ohlcv_daily`
 * holds ~571k bars, so most names return a rich series; empty for names without
 * bars (the chart page renders an empty state). Tagged `stock:{id}`. ~10 min.
 */
export async function getOhlcvSeries(
  securityId: number,
  range: OhlcvRange = "1Y",
): Promise<OhlcvSeries> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const days = RANGE_DAYS[range];

  let q = sb
    .from("ohlcv_daily")
    .select("trade_date,open,high,low,close,volume")
    .eq("security_id", securityId)
    .order("trade_date", { ascending: false })
    .limit(OHLCV_CAP + 1);
  if (days != null) q = q.gte("trade_date", cutoffDate(days));

  const { data } = await q;
  const rows = (data as Array<{
    trade_date: string; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown;
  }> | null) ?? [];

  const capped = rows.length > OHLCV_CAP;
  const points: OhlcvPoint[] = rows
    .slice(0, OHLCV_CAP)
    .reverse()
    .map((r) => ({
      date: r.trade_date,
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      volume: toNum(r.volume),
    }));

  return {
    points,
    range,
    from: points.length ? points[0].date : null,
    to: points.length ? points[points.length - 1].date : null,
    capped,
  };
}

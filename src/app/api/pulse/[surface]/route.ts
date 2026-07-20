import { createAnonClient } from "@/lib/supabase/public";
import { toFreshnessBlock, toNum, toInt, type VenueFeedRow } from "@/lib/data/util";
import type { FreshnessBlock } from "@/lib/market/freshness";

/**
 * Consolidated client-poll surface: `GET /api/pulse/[surface]`.
 *
 * These handlers use the COOKIELESS anon client only — never the cookie-bound
 * client. @supabase/ssr session refresh emits `Set-Cookie`, which makes a
 * response uncacheable at the CDN and collapses the §4 cost model from ~2 origin
 * hits/min/surface to per-user invocations. proxy.ts's matcher is admin-only, so
 * these routes are never touched by session refresh; the `Cache-Control` headers
 * below do the caching.
 *
 * Every payload embeds a `freshness` block sourced from venue_feed_status. A
 * venue is NEVER labelled `live` when its feed says otherwise (S1 color law).
 */

// ── Cache-Control presets ─────────────────────────────────────────────────────
const CACHE_30S = "public, s-maxage=25, stale-while-revalidate=30";
const CACHE_60S = "public, s-maxage=55, stale-while-revalidate=30";

function jsonResponse(body: unknown, cacheControl: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

const FEED_COLS = "venue_code,state,detail,last_sync_at,latency_ms";

type SB = ReturnType<typeof createAnonClient>;

async function allFreshness(sb: SB): Promise<FreshnessBlock[]> {
  const { data } = await sb.from("venue_feed_status").select(FEED_COLS);
  return ((data as VenueFeedRow[] | null) ?? [])
    .map((r) => toFreshnessBlock(r))
    .filter((b): b is FreshnessBlock => b !== null);
}

async function venueFreshness(sb: SB, venue: string): Promise<FreshnessBlock | null> {
  const { data } = await sb.from("venue_feed_status").select(FEED_COLS).eq("venue_code", venue).maybeSingle<VenueFeedRow>();
  return toFreshnessBlock(data);
}

const QUOTE_COLS =
  "security_id,last,change,change_pct,open,high,low,volume,vwap,week52_high,week52_low,as_of,delay_minutes,tick_dir";

function mapQuote(q: Record<string, unknown> | null): Record<string, unknown> | null {
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
    asOf: (q.as_of as string | null) ?? null,
    delayMinutes: toInt(q.delay_minutes),
    tickDir: toInt(q.tick_dir),
  };
}

// ── quote (30s) ───────────────────────────────────────────────────────────────
async function surfaceQuote(sb: SB, params: URLSearchParams): Promise<Response> {
  const idParam = params.get("id");
  const venueParam = params.get("venue")?.toUpperCase();
  const tickerParam = (params.get("ticker") ?? params.get("t"))?.toUpperCase();

  let secQuery = sb.from("securities").select("id,ticker,venue_code,name_en,currency");
  if (idParam && Number(idParam)) {
    secQuery = secQuery.eq("id", Number(idParam));
  } else if (venueParam && tickerParam) {
    secQuery = secQuery.eq("venue_code", venueParam).eq("ticker", tickerParam);
  } else if (tickerParam) {
    // Ticker-only is ambiguous across venues (AMAN/GFH/ITHMR/ORDS) — first match.
    secQuery = secQuery.eq("ticker", tickerParam);
  } else {
    return jsonResponse({ error: "quote requires ?id=, ?venue=&ticker=, or ?t=" }, CACHE_30S, 400);
  }

  const { data: sec } = await secQuery
    .limit(1)
    .maybeSingle<{ id: number; ticker: string; venue_code: string; name_en: string; currency: string | null }>();

  if (!sec) return jsonResponse({ error: "security not found" }, CACHE_30S, 404);

  const [{ data: quote }, freshness] = await Promise.all([
    sb.from("quotes_latest").select(QUOTE_COLS).eq("security_id", sec.id).maybeSingle<Record<string, unknown>>(),
    venueFreshness(sb, sec.venue_code),
  ]);

  return jsonResponse(
    {
      security: { id: sec.id, ticker: sec.ticker, venueCode: sec.venue_code, name: sec.name_en, currency: sec.currency },
      quote: mapQuote(quote),
      freshness,
    },
    CACHE_30S,
  );
}

// ── indices (60s; index_levels is EMPTY today) ───────────────────────────────
async function surfaceIndices(sb: SB): Promise<Response> {
  const [{ data: indices }, { data: levels }, freshness] = await Promise.all([
    sb.from("indices").select("code,venue_code,name,is_composite"),
    sb.from("index_levels").select("index_code,level,change,change_pct,day_high,day_low,as_of"),
    allFreshness(sb),
  ]);

  const levelByCode = new Map<string, Record<string, unknown>>();
  for (const l of (levels as Array<Record<string, unknown>> | null) ?? []) levelByCode.set(l.index_code as string, l);

  const items = ((indices as Array<{ code: string; venue_code: string; name: string; is_composite: boolean }> | null) ?? [])
    .map((idx) => {
      const lv = levelByCode.get(idx.code);
      return {
        code: idx.code,
        name: idx.name,
        venueCode: idx.venue_code,
        isComposite: idx.is_composite,
        level: toNum(lv?.level),
        change: toNum(lv?.change),
        changePct: toNum(lv?.change_pct),
        dayHigh: toNum(lv?.day_high),
        dayLow: toNum(lv?.day_low),
        asOf: (lv?.as_of as string | undefined) ?? null,
      };
    })
    .sort((a, b) => a.venueCode.localeCompare(b.venueCode));

  return jsonResponse({ indices: items, freshness }, CACHE_60S);
}

// ── wire (30s) — filings newer than ?after= cursor, else latest N ────────────
async function surfaceWire(sb: SB, params: URLSearchParams): Promise<Response> {
  const after = params.get("after");
  const limit = Math.min(Math.max(Number(params.get("limit")) || 30, 1), 100);

  let q = sb
    .from("filings")
    .select("id,security_id,venue_code,form_code,filing_type,title,filed_at,is_market_moving,pdf_pages,ai_summary")
    .order("filed_at", { ascending: false })
    .limit(limit);
  // filed_at compared server-side (timestamptz) — never a JS date string compare.
  if (after) q = q.gt("filed_at", after);

  const { data: rows } = await q;
  const filings = (rows as Array<Record<string, unknown>> | null) ?? [];

  const ids = [...new Set(filings.map((r) => r.security_id as number).filter((n) => n != null))];
  const secMap = new Map<number, { ticker: string; venue_code: string; name_en: string }>();
  if (ids.length) {
    const { data: secs } = await sb.from("securities").select("id,ticker,venue_code,name_en").in("id", ids);
    for (const s of (secs as Array<{ id: number; ticker: string; venue_code: string; name_en: string }> | null) ?? []) {
      secMap.set(s.id, { ticker: s.ticker, venue_code: s.venue_code, name_en: s.name_en });
    }
  }

  const items = filings.map((r) => {
    const sec = r.security_id != null ? secMap.get(r.security_id as number) : undefined;
    return {
      id: r.id as number,
      securityId: (r.security_id as number | null) ?? null,
      venueCode: (r.venue_code as string | null) ?? sec?.venue_code ?? null,
      ticker: sec?.ticker ?? null,
      name: sec?.name_en ?? null,
      formCode: (r.form_code as string | null) ?? null,
      filingType: (r.filing_type as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      filedAt: (r.filed_at as string | null) ?? null,
      isMarketMoving: Boolean(r.is_market_moving),
      pdfPages: toInt(r.pdf_pages),
      aiSummary: (r.ai_summary as string | null) ?? null,
    };
  });

  const freshness = await allFreshness(sb);
  const latest = items.length ? items[0].filedAt : (after ?? null);

  return jsonResponse({ items, latest, freshness }, CACHE_30S);
}

// ── heatmap (60s) — sector aggregates from securities × quotes_latest ────────
async function surfaceHeatmap(sb: SB): Promise<Response> {
  const [{ data: secs }, { data: quotes }, { data: sectors }, freshness] = await Promise.all([
    sb.from("securities").select("id,sector,venue_code,status").in("status", ["listed", "suspended"]),
    sb.from("quotes_latest").select("security_id,change_pct"),
    sb.from("sectors").select("key,name,sort_order"),
    allFreshness(sb),
  ]);

  const changeById = new Map<number, number | null>();
  for (const q of (quotes as Array<{ security_id: number; change_pct: unknown }> | null) ?? []) {
    changeById.set(q.security_id, toNum(q.change_pct));
  }
  const sectorMeta = new Map<string, { name: string; sort_order: number | null }>();
  for (const s of (sectors as Array<{ key: string; name: string; sort_order: number | null }> | null) ?? []) {
    sectorMeta.set(s.key, { name: s.name, sort_order: s.sort_order });
  }

  type Agg = { key: string; count: number; advancers: number; decliners: number; unchanged: number; sum: number; n: number };
  const aggByKey = new Map<string, Agg>();

  for (const s of (secs as Array<{ id: number; sector: string | null }> | null) ?? []) {
    const key = s.sector ?? "unknown";
    let a = aggByKey.get(key);
    if (!a) { a = { key, count: 0, advancers: 0, decliners: 0, unchanged: 0, sum: 0, n: 0 }; aggByKey.set(key, a); }
    a.count += 1;
    const chg = changeById.get(s.id);
    if (chg != null) {
      a.sum += chg;
      a.n += 1;
      if (chg > 0) a.advancers += 1;
      else if (chg < 0) a.decliners += 1;
      else a.unchanged += 1;
    }
  }

  const out = [...aggByKey.values()]
    .map((a) => ({
      key: a.key,
      name: sectorMeta.get(a.key)?.name ?? a.key,
      count: a.count,
      advancers: a.advancers,
      decliners: a.decliners,
      unchanged: a.unchanged,
      avgChangePct: a.n > 0 ? a.sum / a.n : null,
      sortOrder: sectorMeta.get(a.key)?.sort_order ?? 999,
    }))
    .sort((x, y) => x.sortOrder - y.sortOrder);

  return jsonResponse({ sectors: out, freshness }, CACHE_60S);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ surface: string }> },
): Promise<Response> {
  const { surface } = await params;
  const url = new URL(request.url);
  const sp = url.searchParams;
  const sb = createAnonClient();

  switch (surface) {
    case "quote":
      return surfaceQuote(sb, sp);
    case "indices":
      return surfaceIndices(sb);
    case "wire":
      return surfaceWire(sb, sp);
    case "heatmap":
      return surfaceHeatmap(sb);
    default:
      return jsonResponse({ error: `unknown pulse surface: ${surface}` }, "no-store", 404);
  }
}

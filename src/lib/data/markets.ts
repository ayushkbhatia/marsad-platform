import "server-only";
import { connection } from "next/server";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import type { FreshnessBlock } from "@/lib/market/freshness";
import { toFreshnessBlock, toNum, toInt, type VenueFeedRow } from "./util";

/**
 * Public market-wide reads: the index tape, venue freshness, and the
 * (holiday-aware) market open/closed state. Anon-RLS tables only.
 */

// ── Index tape ──────────────────────────────────────────────────────────────

export interface IndexTapeItem {
  code: string;
  name: string;
  venueCode: string;
  isComposite: boolean;
  level: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  asOf: string | null;
  freshness: FreshnessBlock | null;
}

/**
 * The index strip: every index joined to its latest level + venue freshness.
 * `public.index_levels` is populated for all six headline indices (TASI, DFMGI,
 * FADGI, QSI, MSX30, BAX) on a 10-minute timer — DEF-INDEX-LEVELS closed
 * 2026-07-21. An index with no level still degrades gracefully (null level, the
 * tape renders the name only) and never fabricates a value. ~60s.
 */
export async function getIndexTape(): Promise<IndexTapeItem[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("indices");

  const sb = createAnonClient();
  const [{ data: indices }, { data: levels }, { data: feeds }] = await Promise.all([
    sb.from("indices").select("code,venue_code,name,is_composite"),
    sb.from("index_levels").select("index_code,level,change,change_pct,day_high,day_low,as_of"),
    sb.from("venue_feed_status").select("venue_code,state,detail,last_sync_at,latency_ms"),
  ]);

  const levelByCode = new Map<string, Record<string, unknown>>();
  for (const l of (levels as Array<Record<string, unknown>> | null) ?? []) {
    levelByCode.set(l.index_code as string, l);
  }
  const feedByVenue = new Map<string, VenueFeedRow>();
  for (const f of (feeds as VenueFeedRow[] | null) ?? []) feedByVenue.set(f.venue_code, f);

  return ((indices as Array<{ code: string; venue_code: string; name: string; is_composite: boolean }> | null) ?? [])
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
        freshness: toFreshnessBlock(feedByVenue.get(idx.venue_code)),
      };
    })
    .sort((a, b) => a.venueCode.localeCompare(b.venueCode));
}

// ── Venue freshness ─────────────────────────────────────────────────────────

export interface VenueFreshness extends FreshnessBlock {
  venueName: string | null;
  sortOrder: number | null;
}

/** All venue freshness rows, ordered by venues.sort_order. ~60s. */
export async function getVenueFreshness(): Promise<VenueFreshness[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("freshness");

  const sb = createAnonClient();
  const [{ data: feeds }, { data: venues }] = await Promise.all([
    sb.from("venue_feed_status").select("venue_code,state,detail,last_sync_at,latency_ms"),
    sb.from("venues").select("code,name,sort_order"),
  ]);

  const meta = new Map<string, { name: string; sort_order: number | null }>();
  for (const v of (venues as Array<{ code: string; name: string; sort_order: number | null }> | null) ?? []) {
    meta.set(v.code, { name: v.name, sort_order: v.sort_order });
  }

  return ((feeds as VenueFeedRow[] | null) ?? [])
    .map((f) => {
      const block = toFreshnessBlock(f)!;
      const m = meta.get(f.venue_code);
      return { ...block, venueName: m?.name ?? null, sortOrder: m?.sort_order ?? null };
    })
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
}

// ── Market open / closed (authoritative, holiday-aware) ─────────────────────

export interface VenueMarketState {
  venueCode: string;
  timezone: string | null;
  isOpen: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  opensLocal: string | null; // "HH:MM"
  closesLocal: string | null; // "HH:MM"
}

export interface MarketState {
  venues: VenueMarketState[];
  anyOpen: boolean;
  /** ISO instant this snapshot was computed (cached ~60s). */
  asOf: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Local weekday index, minutes-past-midnight, and YYYY-MM-DD for a timezone. */
function localParts(timezone: string, at: Date): { dow: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  let dow = 0, hour = 0, minute = 0, y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "weekday") dow = WEEKDAY_INDEX[p.value] ?? 0;
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
    else if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return { dow, minutes: hour * 60 + minute, date: `${y}-${m}-${d}` };
}

const parseHm = (t: string | null): number | null => {
  if (!t) return null;
  const [h, m] = t.split(":");
  const mins = Number(h) * 60 + Number(m);
  return Number.isFinite(mins) ? mins : null;
};
const hm = (mins: number | null): string | null =>
  mins == null ? null : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Per-venue open/closed right now, holiday-aware — the authoritative calendar
 * read a layout does server-side (04-reader-app.md §4) to drive the masthead and
 * to hand `anyOpen` down to `usePulse` so polling stops when everything is shut.
 *
 * Computed from public.venues (timezone + trading_days), public.market_sessions
 * (open/close), and public.market_holidays. All timezone/day math is done in JS
 * via Intl against ISO strings — never a JS Date range-compare on DB timestamps.
 * Cached ~60s, so open/close transitions are accurate to within a minute.
 */
export async function getMarketState(): Promise<MarketState> {
  // NOT `use cache`: open/closed/holiday depends on the CURRENT time (new Date()), which is
  // request-time/dynamic — a cached function must be deterministic, so reading the wall clock
  // inside `use cache` is the cacheComponents "blocking-route" violation. This fn is therefore
  // dynamic and MUST be called inside a <Suspense> boundary (it is — Markets/Ledger bodies).
  // The underlying calendar tables (venues/market_sessions/market_holidays, ~60 rows total) are
  // tiny; caching just that lookup while keeping the time math fresh is a documented follow-up.
  // cacheComponents requires reading a dynamic source before the current time — connection() marks
  // this fn dynamic so it runs per-request inside its <Suspense> hole (never during prerender).
  await connection();
  const now = new Date();
  const sb = createAnonClient();

  // ±1 UTC day window covers every venue's local "today" near midnight.
  const lo = utcDate(new Date(now.getTime() - 86400000));
  const hi = utcDate(new Date(now.getTime() + 86400000));

  const [{ data: venues }, { data: sessions }, { data: holidays }] = await Promise.all([
    sb.from("venues").select("code,timezone,trading_days,is_active").eq("is_active", true),
    sb.from("market_sessions").select("venue_code,session_kind,open_local,close_local").eq("session_kind", "regular"),
    sb.from("market_holidays").select("venue_code,holiday_date,name").gte("holiday_date", lo).lte("holiday_date", hi),
  ]);

  const sessionByVenue = new Map<string, { open_local: string | null; close_local: string | null }>();
  for (const s of (sessions as Array<{ venue_code: string; open_local: string | null; close_local: string | null }> | null) ?? []) {
    sessionByVenue.set(s.venue_code, { open_local: s.open_local, close_local: s.close_local });
  }
  const holidayRows = (holidays as Array<{ venue_code: string; holiday_date: string; name: string }> | null) ?? [];

  const out: VenueMarketState[] = ((venues as Array<{ code: string; timezone: string | null; trading_days: number[] | null; is_active: boolean }> | null) ?? [])
    .map((v) => {
      const tz = v.timezone;
      const sess = sessionByVenue.get(v.code);
      const openMin = parseHm(sess?.open_local ?? null);
      const closeMin = parseHm(sess?.close_local ?? null);

      let isOpen = false;
      let isHoliday = false;
      let holidayName: string | null = null;

      if (tz) {
        const { dow, minutes, date } = localParts(tz, now);
        const hit = holidayRows.find((h) => h.venue_code === v.code && h.holiday_date === date);
        isHoliday = Boolean(hit);
        holidayName = hit?.name ?? null;
        const tradingDay = (v.trading_days ?? []).includes(dow);
        if (tradingDay && !isHoliday && openMin != null && closeMin != null) {
          isOpen = minutes >= openMin && minutes < closeMin;
        }
      }

      return {
        venueCode: v.code,
        timezone: tz,
        isOpen,
        isHoliday,
        holidayName,
        opensLocal: hm(openMin),
        closesLocal: hm(closeMin),
      };
    });

  return { venues: out, anyOpen: out.some((v) => v.isOpen), asOf: now.toISOString() };
}

// ── Sector heatmap (public: securities × quotes_latest × sectors) ────────────

export interface SectorHeatmapCell {
  key: string;
  name: string;
  /** Securities in the sector (public universe) — the tile weight. */
  count: number;
  /** How many of those carry a live-ish (delayed) change%. */
  quoted: number;
  advancers: number;
  decliners: number;
  unchanged: number;
  /** Mean change% across quoted names, or null when none are quoted. */
  avgChangePct: number | null;
  sortOrder: number;
}

/**
 * Breadth by sector for the Markets heatmap: average change% (equal-weighted
 * across quoted names) plus advancer/decliner breadth and a `count` that sizes
 * the tile. Reads only anon-RLS tables (securities, quotes_latest, sectors) and
 * NEVER any premium/financial column. Cached ~60s, tagged `heatmap` +
 * `freshness` so a quotes sweep can refresh it. Degrades to per-sector null
 * averages if quotes are absent — the grid still renders the sector skeleton.
 */
export async function getSectorHeatmap(): Promise<SectorHeatmapCell[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("heatmap");
  cacheTag("freshness");

  const sb = createAnonClient();
  const [{ data: secs }, { data: quotes }, { data: sectors }] = await Promise.all([
    sb.from("securities").select("id,sector,status").in("status", ["listed", "suspended"]),
    sb.from("quotes_latest").select("security_id,change_pct"),
    sb.from("sectors").select("key,name,sort_order"),
  ]);

  const changeById = new Map<number, number | null>();
  for (const q of (quotes as Array<{ security_id: number; change_pct: unknown }> | null) ?? []) {
    changeById.set(q.security_id, toNum(q.change_pct));
  }
  const sectorMeta = new Map<string, { name: string; sortOrder: number }>();
  for (const s of (sectors as Array<{ key: string; name: string; sort_order: number | null }> | null) ?? []) {
    sectorMeta.set(s.key, { name: s.name, sortOrder: s.sort_order ?? 999 });
  }

  interface Agg {
    key: string; count: number; advancers: number; decliners: number; unchanged: number; sum: number; n: number;
  }
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

  return [...aggByKey.values()]
    .map((a) => {
      const meta = sectorMeta.get(a.key);
      return {
        key: a.key,
        name: meta?.name ?? a.key,
        count: a.count,
        quoted: a.n,
        advancers: a.advancers,
        decliners: a.decliners,
        unchanged: a.unchanged,
        avgChangePct: a.n > 0 ? a.sum / a.n : null,
        sortOrder: meta?.sortOrder ?? 999,
      };
    })
    .sort((x, y) => x.sortOrder - y.sortOrder);
}

// ── Top movers (public quotes_latest) ────────────────────────────────────────

export interface Mover {
  securityId: number;
  venueCode: string;
  ticker: string;
  name: string;
  last: number | null;
  changePct: number | null;
  tickDir: number | null;
}

export interface TopMovers {
  gainers: Mover[];
  losers: Mover[];
  /** Count of quoted public names the ranking was drawn from. */
  universe: number;
}

/**
 * Biggest ± change% across the public universe. Ranks `quotes_latest.change_pct`
 * (coerced — PostgREST serializes numeric as a string) joined to public
 * `securities` identity; no premium columns are read. Both directions are
 * pulled in one pass and split, so an all-red or all-green tape degrades to an
 * empty column rather than fabricating movers. Cached ~30s, tagged `movers`.
 */
export async function getTopMovers(limit = 6): Promise<TopMovers> {
  "use cache";
  cacheLife({ stale: 20, revalidate: 30, expire: 3600 });
  cacheTag("movers");

  const take = Math.min(Math.max(limit, 1), 25);
  const sb = createAnonClient();
  const [{ data: secs }, { data: quotes }] = await Promise.all([
    sb.from("securities").select("id,venue_code,ticker,name_en,status").in("status", ["listed", "suspended"]),
    sb.from("quotes_latest").select("security_id,last,change_pct,tick_dir"),
  ]);

  const secById = new Map<number, { venue_code: string; ticker: string; name_en: string }>();
  for (const s of (secs as Array<{ id: number; venue_code: string; ticker: string; name_en: string }> | null) ?? []) {
    secById.set(s.id, { venue_code: s.venue_code, ticker: s.ticker, name_en: s.name_en });
  }

  const rows: Mover[] = [];
  for (const q of (quotes as Array<{ security_id: number; last: unknown; change_pct: unknown; tick_dir: number | null }> | null) ?? []) {
    const sec = secById.get(q.security_id);
    const chg = toNum(q.change_pct);
    if (!sec || chg == null) continue; // only public + quoted names
    rows.push({
      securityId: q.security_id,
      venueCode: sec.venue_code,
      ticker: sec.ticker,
      name: sec.name_en,
      last: toNum(q.last),
      changePct: chg,
      tickDir: toInt(q.tick_dir),
    });
  }

  const gainers = rows
    .filter((r) => (r.changePct ?? 0) > 0)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, take);
  const losers = rows
    .filter((r) => (r.changePct ?? 0) < 0)
    .sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0))
    .slice(0, take);

  return { gainers, losers, universe: rows.length };
}

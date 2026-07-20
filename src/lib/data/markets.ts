import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import type { FreshnessBlock } from "@/lib/market/freshness";
import { toFreshnessBlock, toNum, type VenueFeedRow } from "./util";

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
 * `public.index_levels` is EMPTY today, so levels come back null and the tape
 * renders index names with placeholder values — degrades gracefully, never
 * fabricates a level. ~60s.
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
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag("market-calendar");

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

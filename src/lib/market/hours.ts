/**
 * Client-safe venue trading-hours projection.
 *
 * SOURCE OF TRUTH is the database: `public.market_sessions` (open/close per
 * venue), `public.venues` (timezone + trading_days), and
 * `public.market_holidays` (54 rows). This module is a small, dependency-free
 * mirror of the *regular-session* schedule so the `usePulse` hook can decide
 * whether to keep polling WITHOUT a server round-trip. It deliberately does NOT
 * encode holidays — the authoritative, holiday-aware answer is the server helper
 * `getMarketState()` in `src/lib/data/markets.ts`, which a layout reads and
 * passes down. On a holiday this mirror may report "open"; that is safe because
 * the pulse payload's own `freshness` block will read `closed`/`offline`, and
 * `usePulse` also self-gates on that (see `anyVenueTrading`).
 *
 * If `market_sessions` / `venues` change, update this table in the same change
 * (per the repo's documentation-discipline rule).
 *
 * Day-of-week uses JS `Date.getDay()` semantics (0 = Sunday … 6 = Saturday),
 * matching `venues.trading_days`.
 */

export interface VenueHours {
  venue: string;
  timezone: string;
  /** JS getDay() indices the venue trades. */
  tradingDays: number[];
  /** Local open time, minutes past midnight. */
  openMin: number;
  /** Local close time, minutes past midnight. */
  closeMin: number;
  active: boolean;
}

const hm = (h: number, m: number) => h * 60 + m;

/** Mirror of public.market_sessions ⨝ public.venues (regular session). */
export const VENUE_HOURS: Record<string, VenueHours> = {
  TDWL: { venue: "TDWL", timezone: "Asia/Riyadh", tradingDays: [0, 1, 2, 3, 4], openMin: hm(10, 0), closeMin: hm(15, 0), active: true },
  DFM: { venue: "DFM", timezone: "Asia/Dubai", tradingDays: [1, 2, 3, 4, 5], openMin: hm(10, 0), closeMin: hm(15, 0), active: true },
  ADX: { venue: "ADX", timezone: "Asia/Dubai", tradingDays: [1, 2, 3, 4, 5], openMin: hm(10, 0), closeMin: hm(15, 0), active: true },
  QE: { venue: "QE", timezone: "Asia/Qatar", tradingDays: [0, 1, 2, 3, 4], openMin: hm(9, 30), closeMin: hm(13, 15), active: true },
  MSX: { venue: "MSX", timezone: "Asia/Muscat", tradingDays: [0, 1, 2, 3, 4], openMin: hm(9, 0), closeMin: hm(13, 10), active: true },
  BHB: { venue: "BHB", timezone: "Asia/Bahrain", tradingDays: [0, 1, 2, 3, 4], openMin: hm(9, 30), closeMin: hm(13, 0), active: true },
  // Boursa Kuwait — "coming soon", not yet ingested (venues.is_active = false).
  BK: { venue: "BK", timezone: "Asia/Kuwait", tradingDays: [0, 1, 2, 3, 4], openMin: hm(9, 0), closeMin: hm(12, 30), active: false },
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Local weekday index + minutes-past-midnight for a venue at instant `at`. */
function venueLocalParts(timezone: string, at: Date): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  let dow = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = WEEKDAY_INDEX[p.value] ?? 0;
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return { dow, minutes: hour * 60 + minute };
}

/**
 * Is `venue` inside its regular trading session right now (holidays ignored —
 * see module note). Unknown/inactive venues return false.
 */
export function isVenueOpen(venue: string, at: Date = new Date()): boolean {
  const h = VENUE_HOURS[venue?.toUpperCase?.() ?? venue];
  if (!h || !h.active) return false;
  const { dow, minutes } = venueLocalParts(h.timezone, at);
  if (!h.tradingDays.includes(dow)) return false;
  return minutes >= h.openMin && minutes < h.closeMin;
}

/** Is ANY of the given venues (default: all active venues) currently open? */
export function isAnyVenueOpen(venues?: string[], at: Date = new Date()): boolean {
  const list = venues?.length
    ? venues
    : Object.values(VENUE_HOURS).filter((v) => v.active).map((v) => v.venue);
  return list.some((v) => isVenueOpen(v, at));
}

/**
 * Reopen hint for the market-closed masthead (design 16c) — e.g.
 * "opens Sun 10:00" for a reference venue (default TDWL, the flagship the index
 * strip leads with). Coarse 15-minute forward scan (≤ 8 days) reusing the
 * timezone-correct `isVenueOpen`; the weekday comes from the found instant, the
 * time from the venue's regular open (so the label is exact even if the scan
 * grid lands a step past the bell). Holidays are NOT encoded here (same caveat
 * as the rest of this mirror — the server `getMarketState()` is authoritative);
 * on a holiday this may name the next regular session rather than the true one.
 * Returns "" if no open is found within the window.
 */
export function nextOpenLabel(venue = "TDWL", at: Date = new Date()): string {
  const h = VENUE_HOURS[venue?.toUpperCase?.() ?? venue];
  if (!h || !h.active) return "";
  const STEP_MS = 15 * 60 * 1000;
  for (let step = 1; step <= 8 * 24 * 4; step++) {
    const t = new Date(at.getTime() + step * STEP_MS);
    if (isVenueOpen(venue, t)) {
      const wd = new Intl.DateTimeFormat("en-US", { timeZone: h.timezone, weekday: "short" }).format(t);
      const hh = String(Math.floor(h.openMin / 60)).padStart(2, "0");
      const mm = String(h.openMin % 60).padStart(2, "0");
      return `opens ${wd} ${hh}:${mm}`;
    }
  }
  return "";
}

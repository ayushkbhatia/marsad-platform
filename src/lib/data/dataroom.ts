import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { sectorLabel, venueName } from "@/lib/reader/format";
import { toNum, toInt } from "./util";
import { getSectorHeatmap, type SectorHeatmapCell } from "./markets";
import { getScreenerUniverse, type ScreenerRow } from "./screener";

/**
 * Data-room slice reads (heatmap drilldown + the curated preset-screen
 * catalog). Two owning tables only, both anon-RLS, no premium column ever
 * touched here:
 *   - `getHeatmapConstituents` is the one genuinely NEW `use cache` DB read
 *     this slice adds (securities × quotes_latest, scoped to one sector and
 *     optionally one venue) — the per-tile data the heatmap drilldown needs.
 *   - Everything else below is DERIVED from already-cached reads owned by
 *     other slices (`getSectorHeatmap` from `./markets`, `getScreenerUniverse`
 *     from `./screener`) rather than duplicating a second broad query — the
 *     venue-scoped sector grid and the whole preset-screen catalog cost zero
 *     additional Supabase round-trips beyond what those two reads already do.
 */

// ── Heatmap: per-sector constituents (the drilldown) ─────────────────────────

export interface HeatmapConstituent {
  securityId: number;
  ticker: string;
  name: string;
  venueCode: string;
  last: number | null;
  changePct: number | null;
  tickDir: number | null;
}

/**
 * Every listed/suspended name in one sector (optionally scoped to one venue),
 * joined to its latest delayed quote. Same public columns as `getSectorHeatmap`
 * — no premium field is ever read. Sorted by change% (best movers first) so the
 * drilldown reads like a mini leaderboard. Cached ~60s per (sector, venue) pair,
 * tagged `heatmap` + `freshness` so a quotes sweep can invalidate it.
 */
export async function getHeatmapConstituents(
  sectorKey: string,
  venueCode: string | null = null,
): Promise<HeatmapConstituent[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("heatmap");
  cacheTag("freshness");

  const sb = createAnonClient();
  const { data: secs } = venueCode
    ? await sb
        .from("securities")
        .select("id,venue_code,ticker,name_en,status")
        .eq("sector", sectorKey)
        .eq("venue_code", venueCode)
        .in("status", ["listed", "suspended"])
    : await sb
        .from("securities")
        .select("id,venue_code,ticker,name_en,status")
        .eq("sector", sectorKey)
        .in("status", ["listed", "suspended"]);

  const secRows = (secs as Array<{ id: number; venue_code: string; ticker: string; name_en: string }> | null) ?? [];
  const ids = secRows.map((s) => s.id);

  const quoteById = new Map<number, { last: unknown; change_pct: unknown; tick_dir: number | null }>();
  if (ids.length > 0) {
    const { data: quotes } = await sb
      .from("quotes_latest")
      .select("security_id,last,change_pct,tick_dir")
      .in("security_id", ids);
    for (const q of (quotes as Array<{ security_id: number; last: unknown; change_pct: unknown; tick_dir: number | null }> | null) ?? []) {
      quoteById.set(q.security_id, q);
    }
  }

  return secRows
    .map((s) => {
      const q = quoteById.get(s.id);
      return {
        securityId: s.id,
        ticker: s.ticker,
        name: s.name_en,
        venueCode: s.venue_code,
        last: toNum(q?.last),
        changePct: toNum(q?.change_pct),
        tickDir: toInt(q?.tick_dir ?? null),
      };
    })
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
}

// ── Heatmap: venue-scoped sector breadth (derived, no new read) ──────────────

/**
 * Same shape as `getSectorHeatmap()` but scoped to one venue — re-aggregates
 * the already-cached `getScreenerUniverse()` rows (which carry venueCode) and
 * borrows sector name/sort order from `getSectorHeatmap()`, so a venue tab
 * costs zero additional Supabase queries.
 */
export async function getSectorBreadthForVenue(venueCode: string): Promise<SectorHeatmapCell[]> {
  const [universe, allGcc] = await Promise.all([getScreenerUniverse(), getSectorHeatmap()]);
  const sortByKey = new Map(allGcc.map((c) => [c.key, c.sortOrder]));
  const nameByKey = new Map(allGcc.map((c) => [c.key, c.name]));

  interface Agg { count: number; advancers: number; decliners: number; unchanged: number; sum: number; n: number }
  const aggByKey = new Map<string, Agg>();
  for (const r of universe) {
    if (r.venueCode !== venueCode) continue;
    let a = aggByKey.get(r.sector);
    if (!a) { a = { count: 0, advancers: 0, decliners: 0, unchanged: 0, sum: 0, n: 0 }; aggByKey.set(r.sector, a); }
    a.count += 1;
    if (r.changePct != null) {
      a.sum += r.changePct;
      a.n += 1;
      if (r.changePct > 0) a.advancers += 1;
      else if (r.changePct < 0) a.decliners += 1;
      else a.unchanged += 1;
    }
  }

  return [...aggByKey.entries()]
    .map(([key, a]) => ({
      key,
      name: nameByKey.get(key) ?? key,
      count: a.count,
      quoted: a.n,
      advancers: a.advancers,
      decliners: a.decliners,
      unchanged: a.unchanged,
      avgChangePct: a.n > 0 ? a.sum / a.n : null,
      sortOrder: sortByKey.get(key) ?? 999,
    }))
    .sort((x, y) => x.sortOrder - y.sortOrder);
}

// ── Preset screens: the curated catalog (no `screen_catalog` table yet) ──────

export type ScreenerSortField = "ticker" | "price" | "change" | "score" | "volume";
export type ScreenerSortDir = "asc" | "desc";

/** The exact allowlisted shape `/api/screener/run` accepts as a querystring. */
export interface ScreenerCriteria {
  venue?: string[];
  sector?: string[];
  rating?: string[];
  priceMin?: number;
  priceMax?: number;
  changeMin?: number;
  changeMax?: number;
  scoreMin?: number;
  scoreMax?: number;
  sort?: ScreenerSortField;
  dir?: ScreenerSortDir;
}

export interface PresetScreen {
  id: string;
  name: string;
  /** Mono kicker, e.g. "MOMENTUM · 1D". */
  tag: string;
  description: string;
  criteria: ScreenerCriteria;
}

/**
 * Curated static screens (owner call: `screen_catalog` has no producer yet, see
 * BUILD-STATUS §7). Every criterion below maps 1:1 onto a public `ScreenerRow`
 * column and the `/api/screener/run` allowlist — nothing here can reference a
 * premium ratio (P/E, P/B, ROE, yield), because those columns don't exist on
 * `getScreenerUniverse()` in the first place.
 */
export const PRESET_SCREENS: readonly PresetScreen[] = [
  {
    id: "score-leaders",
    name: "Score Leaders",
    tag: "QUALITY · GCC-WIDE",
    description: "The highest Marsad Score names across the whole public universe, led by score.",
    criteria: { scoreMin: 70, sort: "score", dir: "desc" },
  },
  {
    id: "buy-rated",
    name: "Buy & Overweight",
    tag: "RATING · GCC-WIDE",
    description: "Every name currently carrying a Buy or Overweight headline rating.",
    criteria: { rating: ["BUY", "OVERWEIGHT"], sort: "score", dir: "desc" },
  },
  {
    id: "momentum-gainers",
    name: "Momentum — Gainers",
    tag: "MOMENTUM · 1D",
    description: "Up 2% or more on the session, ranked by the size of the move.",
    criteria: { changeMin: 2, sort: "change", dir: "desc" },
  },
  {
    id: "momentum-decliners",
    name: "Momentum — Decliners",
    tag: "MOMENTUM · 1D",
    description: "Down 2% or more on the session — research starting points, not a call.",
    criteria: { changeMax: -2, sort: "change", dir: "asc" },
  },
  {
    id: "most-active",
    name: "Most Active",
    tag: "ACTIVITY · 1D",
    description: "The busiest tapes by traded volume across all seven venues.",
    criteria: { sort: "volume", dir: "desc" },
  },
  {
    id: "tadawul-leaders",
    name: "Tadawul Leaders",
    tag: "VENUE · TADAWUL",
    description: "Every listed Saudi Exchange name, ranked by the headline Marsad Score.",
    criteria: { venue: ["TDWL"], sort: "score", dir: "desc" },
  },
  // NOTE: a `sector`-filtered preset (e.g. "Banks Board") is deliberately NOT
  // included yet — `/api/screener/run`'s `csvAllowed()` upper-cases the client
  // value before matching it against `sectorMap.keys()`, but sector keys are
  // stored lowercase (`banks`, `energy`, …), so `?sector=` never matches
  // anything there today. This also breaks the existing `/screener` page's own
  // sector filter chips, not just a hypothetical preset link. Flagged to the
  // lead; not fixed here — `src/app/api/screener/run/route.ts` is out of this
  // slice's ownership (see FRONTEND CONVENTIONS §1). Add a sector preset once
  // that's patched.
] as const;

export function findPresetScreen(id: string): PresetScreen | undefined {
  return PRESET_SCREENS.find((s) => s.id === id);
}

/** Build the exact `/screener?...` querystring `/api/screener/run` understands. */
export function screenerQueryString(c: ScreenerCriteria): string {
  const p = new URLSearchParams();
  if (c.venue?.length) p.set("venue", c.venue.join(","));
  if (c.sector?.length) p.set("sector", c.sector.join(","));
  if (c.rating?.length) p.set("rating", c.rating.join(","));
  if (c.priceMin != null) p.set("priceMin", String(c.priceMin));
  if (c.priceMax != null) p.set("priceMax", String(c.priceMax));
  if (c.changeMin != null) p.set("changeMin", String(c.changeMin));
  if (c.changeMax != null) p.set("changeMax", String(c.changeMax));
  if (c.scoreMin != null) p.set("scoreMin", String(c.scoreMin));
  if (c.scoreMax != null) p.set("scoreMax", String(c.scoreMax));
  if (c.sort) p.set("sort", c.sort);
  if (c.dir) p.set("dir", c.dir);
  return p.toString();
}

export function screenerHref(c: ScreenerCriteria): string {
  const qs = screenerQueryString(c);
  return qs ? `/screener?${qs}` : "/screener";
}

/** Human-readable AND-joined criteria lines for the preview's "CRITERIA" box. */
export function criteriaLines(c: ScreenerCriteria): string[] {
  const lines: string[] = [];
  if (c.venue?.length) lines.push(`Venue = ${c.venue.map((v) => venueName(v)).join(" or ")}`);
  if (c.sector?.length) lines.push(`Sector = ${c.sector.map((s) => sectorLabel(s)).join(" or ")}`);
  if (c.rating?.length) {
    lines.push(`Rating = ${c.rating.map((r) => r.charAt(0) + r.slice(1).toLowerCase()).join(" or ")}`);
  }
  if (c.priceMin != null) lines.push(`Price ≥ ${c.priceMin}`);
  if (c.priceMax != null) lines.push(`Price ≤ ${c.priceMax}`);
  if (c.changeMin != null) lines.push(`Change % ≥ ${c.changeMin > 0 ? "+" : ""}${c.changeMin}%`);
  if (c.changeMax != null) lines.push(`Change % ≤ ${c.changeMax > 0 ? "+" : ""}${c.changeMax}%`);
  if (c.scoreMin != null) lines.push(`Marsad Score ≥ ${c.scoreMin}`);
  if (c.scoreMax != null) lines.push(`Marsad Score ≤ ${c.scoreMax}`);
  return lines;
}

/** Mirrors `/api/screener/run`'s filter predicate exactly (in-memory, same fields). */
export function matchesScreenerCriteria(r: ScreenerRow, c: ScreenerCriteria): boolean {
  if (c.venue?.length && !c.venue.includes(r.venueCode)) return false;
  if (c.sector?.length && !c.sector.includes(r.sector)) return false;
  if (c.rating?.length && !(r.rating && c.rating.includes(r.rating.toUpperCase()))) return false;
  if (c.priceMin != null && (r.last == null || r.last < c.priceMin)) return false;
  if (c.priceMax != null && (r.last == null || r.last > c.priceMax)) return false;
  if (c.changeMin != null && (r.changePct == null || r.changePct < c.changeMin)) return false;
  if (c.changeMax != null && (r.changePct == null || r.changePct > c.changeMax)) return false;
  if (c.scoreMin != null && (r.score == null || r.score < c.scoreMin)) return false;
  if (c.scoreMax != null && (r.score == null || r.score > c.scoreMax)) return false;
  return true;
}

function byNumber(sel: (r: ScreenerRow) => number | null, dir: 1 | -1) {
  return (a: ScreenerRow, b: ScreenerRow) => {
    const av = sel(a);
    const bv = sel(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  };
}

/** Mirrors `/api/screener/run`'s sort — same five fields, nulls always sink. */
function sortScreenerRows(rows: ScreenerRow[], c: ScreenerCriteria): ScreenerRow[] {
  const sort = c.sort ?? "change";
  const dir: 1 | -1 = c.dir === "asc" ? 1 : -1;
  const cmp =
    sort === "ticker"
      ? (a: ScreenerRow, b: ScreenerRow) => a.ticker.localeCompare(b.ticker) * dir
      : sort === "price"
        ? byNumber((r) => r.last, dir)
        : sort === "score"
          ? byNumber((r) => r.score, dir)
          : sort === "volume"
            ? byNumber((r) => r.volume, dir)
            : byNumber((r) => r.changePct, dir);
  return rows.slice().sort(cmp);
}

export interface PresetScreenSummary {
  screen: PresetScreen;
  count: number;
}

/** Live match count for every preset in ONE pass over the (already-cached) universe. */
export async function getPresetScreenSummaries(): Promise<{
  summaries: PresetScreenSummary[];
  universe: number;
}> {
  const universe = await getScreenerUniverse();
  const summaries = PRESET_SCREENS.map((screen) => ({
    screen,
    count: universe.reduce((n, r) => n + (matchesScreenerCriteria(r, screen.criteria) ? 1 : 0), 0),
  }));
  return { summaries, universe: universe.length };
}

export interface PresetScreenResult {
  screen: PresetScreen;
  /** Full matched + sorted set — the caller slices the free preview (e.g. 3 rows). */
  matches: ScreenerRow[];
  total: number;
  universe: number;
}

/** Run one preset screen against the live (cached) universe, or null if the id is unknown. */
export async function runPresetScreen(id: string): Promise<PresetScreenResult | null> {
  const screen = findPresetScreen(id);
  if (!screen) return null;
  const universe = await getScreenerUniverse();
  const matched = sortScreenerRows(
    universe.filter((r) => matchesScreenerCriteria(r, screen.criteria)),
    screen.criteria,
  );
  return { screen, matches: matched, total: matched.length, universe: universe.length };
}

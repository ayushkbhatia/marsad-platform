import { getScreenerUniverse, type ScreenerRow } from "@/lib/data/screener";

/**
 * GET /api/screener/run — public equity screener.
 *
 * Filters/sorts/paginates the cached `getScreenerUniverse()` set (identity +
 * latest quote + HEADLINE Marsad Score). Everything the client can steer is
 * ALLOWLISTED: only the fields/values below are honored, so a client cannot
 * project a premium column or sort by one — the valuation ratios (P/E, P/B, ROE,
 * yield) live in premium tables that this route never reads and never returns.
 *
 * CDN-cacheable per query string (createAnonClient underneath, no Set-Cookie).
 */

// ── Allowlists (the entire public contract of this endpoint) ──────────────────
const SORT_FIELDS = ["ticker", "price", "change", "score", "volume"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const RATINGS = ["BUY", "OVERWEIGHT", "HOLD", "UNDERWEIGHT", "SELL"] as const;

const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? CACHE : "no-store",
    },
  });
}

/** Parse a bounded float; returns null on empty/NaN. */
function num(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a comma list and intersect it with an allowed set **case-insensitively**,
 * returning the allowed set's canonical casing. Venue/rating keys are stored
 * upper-case (TDWL, BUY) but sector keys are lower-case (banks, energy) — a blanket
 * `.toUpperCase()` here silently dropped every `?sector=` filter (and the live
 * screener's own sector chips). Matching on a case-folded key fixes all three.
 */
function csvAllowed(v: string | null, allowed: Set<string>): string[] {
  if (!v) return [];
  const canon = new Map([...allowed].map((a) => [a.toUpperCase(), a]));
  const out = new Set<string>();
  for (const s of v.split(",").map((x) => x.trim()).filter(Boolean)) {
    const hit = canon.get(s.toUpperCase());
    if (hit) out.add(hit);
  }
  return [...out];
}

/** The public row shape sent to clients — no premium fields exist on it. */
function publicRow(r: ScreenerRow) {
  return {
    securityId: r.securityId,
    venueCode: r.venueCode,
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    sectorName: r.sectorName,
    currency: r.currency,
    last: r.last,
    changePct: r.changePct,
    volume: r.volume,
    tickDir: r.tickDir,
    score: r.score,
    rating: r.rating,
  };
}

/** Comparator that always sinks nulls to the bottom, then applies `dir`. */
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

export async function GET(request: Request): Promise<Response> {
  const universe = await getScreenerUniverse();

  // Facet domains derived from the universe (also validates client input).
  const venueSet = new Set(universe.map((r) => r.venueCode));
  const sectorMap = new Map(universe.map((r) => [r.sector, r.sectorName]));

  const sp = new URL(request.url).searchParams;

  const venues = csvAllowed(sp.get("venue"), venueSet);
  const sectors = csvAllowed(sp.get("sector"), new Set(sectorMap.keys()));
  const ratings = csvAllowed(sp.get("rating"), new Set(RATINGS));

  const priceMin = num(sp.get("priceMin"));
  const priceMax = num(sp.get("priceMax"));
  const changeMin = num(sp.get("changeMin"));
  const changeMax = num(sp.get("changeMax"));
  const scoreMin = num(sp.get("scoreMin"));
  const scoreMax = num(sp.get("scoreMax"));

  const sortRaw = (sp.get("sort") ?? "change").toLowerCase();
  const sort: SortField = (SORT_FIELDS as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortField)
    : "change";
  const dir: 1 | -1 = (sp.get("dir") ?? "desc").toLowerCase() === "asc" ? 1 : -1;

  const limit = Math.min(Math.max(Math.trunc(num(sp.get("limit")) ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(num(sp.get("offset")) ?? 0), 0);

  const venueFilter = new Set(venues);
  const sectorFilter = new Set(sectors);
  const ratingFilter = new Set(ratings);

  const matched = universe.filter((r) => {
    if (venueFilter.size && !venueFilter.has(r.venueCode)) return false;
    if (sectorFilter.size && !sectorFilter.has(r.sector)) return false;
    if (ratingFilter.size && !(r.rating && ratingFilter.has(r.rating.toUpperCase()))) return false;
    if (priceMin != null && (r.last == null || r.last < priceMin)) return false;
    if (priceMax != null && (r.last == null || r.last > priceMax)) return false;
    if (changeMin != null && (r.changePct == null || r.changePct < changeMin)) return false;
    if (changeMax != null && (r.changePct == null || r.changePct > changeMax)) return false;
    if (scoreMin != null && (r.score == null || r.score < scoreMin)) return false;
    if (scoreMax != null && (r.score == null || r.score > scoreMax)) return false;
    return true;
  });

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

  const sorted = matched.slice().sort(cmp);
  const page = sorted.slice(offset, offset + limit).map(publicRow);

  return json({
    rows: page,
    total: matched.length,
    universe: universe.length,
    offset,
    limit,
    sort,
    dir: dir === 1 ? "asc" : "desc",
    facets: {
      venues: [...venueSet].sort(),
      sectors: [...sectorMap.entries()]
        .map(([key, name]) => ({ key, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ratings: [...RATINGS],
    },
  });
}

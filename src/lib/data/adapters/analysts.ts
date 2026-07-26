import type {
  AnalystProfile,
  CoverageDeskData,
  CoverageRow,
  DeskArticle,
  LeaderboardAnalyst,
  PerfChart,
  ProfileStat,
  PublishedResearch,
  RatingChange,
  RatingChangeType,
  SectorBar,
} from "@/lib/contracts/analysts";
import type { AnalystCallView, AnalystLeaderboardRow, AnalystProfileDetail } from "@/lib/data/editorial";

/**
 * Coverage Desk (1i) + Analyst Profile (1j) adapter — BRIDGE-BUILD-PLAN P3.5.
 *
 * WHY IT SHIPS BEFORE ITS PRODUCER: `public.analysts` and `public.analyst_calls`
 * are **0 rows** (measured against the live DB 2026-07-27), and the owner ruled
 * on the same day that Marsad will NOT seed fictional analysts — the 1i/1j
 * designs are built around named individuals publishing investment calls on
 * real listed companies, so a placeholder roster is not placeholder copy, it is
 * a fabricated public record. Per Law #2 both surfaces therefore render an
 * honest `EmptyState variant="awaitingFeed"` until real analysts are onboarded.
 *
 * This module is the mapping that makes them light up the moment they are, with
 * no further front-end change: `v_analysts_public` + `getAnalystLeaderboard` +
 * `getCoverageBySector` + `analyst_calls` → the `CoverageDeskData` /
 * `AnalystProfile` contracts. It is proven by a FIXTURE test
 * (`__tests__/analysts.test.ts`) rather than by shipping sample data.
 *
 * Deliberately NOT wrapped in `withSampleFallback`: a known-empty producer is
 * the exact case the fallback must never cover (`adapters/fallback.ts`), and
 * here the sample is a cast of invented people.
 *
 * NO STATIC RUNTIME IMPORTS BY DESIGN. Every top-level import is type-only
 * (erased at build time), so the mapping half of this module is a pure function
 * of its arguments — that is what lets the fixture test load it under
 * `node --test` with native type-stripping, with no test dependency and no
 * bundler. The loaders at the bottom reach for Supabase through a *dynamic*
 * import for the same reason. Formatting therefore lives here rather than in
 * `@/lib/reader/format` (same posture as `adapters/stock-ownership.ts`).
 *
 * KNOWN CONTRACT GAPS (Law #1 — degrade honestly, never bend the view-model):
 *   - `followers` — no follow/subscription producer exists at all → "—".
 *   - `CoverageDeskData.latest` (the "Latest from the desk" strip) — needs a
 *     content→analyst byline join, and `content_items.byline_chain` carries
 *     agent *codes*, not principals (see `editorial.ts` header). Callers pass
 *     `[]` until that gap closes.
 *   - `requestCoverage` — the members' initiation vote has no table → the card
 *     reads "No nominations yet · 0 votes".
 *   - `pinnedCall.quote` — `analyst_calls` has no pull-quote column. We use the
 *     headline of the call's published piece when there is one, otherwise a
 *     factual restatement of the call itself; never invented prose.
 */

// ── shared formatting (local by design — see header) ─────────────────────────

/** The one placeholder used for anything the producer has not supplied. */
const DASH = "—";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTHS_TITLE = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * Split an ISO date/timestamp into its calendar parts without constructing a
 * `Date` for the *label* — a `Date` re-interprets the calendar date in the
 * server's zone and can shift a day (the postgres.js Date trap, applied to
 * formatting). Returns null for anything unparseable.
 */
function ymd(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y: Number(m[1]), m: month, d: day };
}

/** `2026-03-31` → `Mar 26` (the coverage table's "since" column). */
function sinceLabel(iso: string | null | undefined): string {
  const p = ymd(iso);
  return p ? `${MONTHS_TITLE[p.m - 1]} ${String(p.y % 100).padStart(2, "0")}` : DASH;
}

/** `2026-03-31` → `MAR '26` (chart month ticks). */
function monthTick(iso: string | null | undefined): string {
  const p = ymd(iso);
  return p ? `${MONTHS[p.m - 1]} '${String(p.y % 100).padStart(2, "0")}` : DASH;
}

/** `2026-06-28` → `28 JUN` (pinned-call + ratings-change dates). */
function dayMonth(iso: string | null | undefined): string {
  const p = ymd(iso);
  return p ? `${p.d} ${MONTHS[p.m - 1]}` : DASH;
}

/** `2026-06-28` → `28 Jun` (published-research meta line). */
function dayMonthTitle(iso: string | null | undefined): string {
  const p = ymd(iso);
  return p ? `${p.d} ${MONTHS_TITLE[p.m - 1]}` : DASH;
}

/** Whole days between two calendar dates, ignoring clock time and zone. */
function daysBetween(fromIso: string | null | undefined, toIso: string): number | null {
  const a = ymd(fromIso);
  const b = ymd(toIso);
  if (!a || !b) return null;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86_400_000);
}

/**
 * The sidebar's date chip: `TODAY` for same-day, the weekday for anything in
 * the past week (matching the 1i design), an absolute date beyond that.
 */
function recencyLabel(iso: string | null | undefined, nowIso: string): string {
  const days = daysBetween(iso, nowIso);
  const p = ymd(iso);
  if (!p) return DASH;
  if (days === 0) return "TODAY";
  if (days !== null && days > 0 && days < 7) {
    return WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  }
  return dayMonth(iso);
}

function signedPct(n: number, dp = 1): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

/** `SAR 112.00` — currency omitted rather than guessed when it is unknown. */
function money(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return currency ? `${currency} ${value.toFixed(2)}` : value.toFixed(2);
}

/** "Noor Al-Suwaidi" → "NS"; falls back to the slug when there is no name. */
export function initialsOf(name: string | null, slug: string): string {
  const src = (name ?? "").trim() || slug.replace(/[-_]+/g, " ").trim();
  const parts = src.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "Noor Al-Suwaidi" → "N. Al-Suwaidi" (the ratings-change byline). */
function shortName(name: string | null, slug: string): string {
  const src = (name ?? "").trim();
  if (!src) return slug;
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return src;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

/** `real_estate` / `oil & gas` → `Real estate` / `Oil & gas` (sectors.key is a slug taxonomy). */
function humanizeSector(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Coverage Desk (1i) ───────────────────────────────────────────────────────

/** One roster row as exposed to anon by `public.v_analysts_public`. */
export interface AnalystIdentity {
  slug: string;
  displayName: string | null;
  title: string | null;
  credential: string | null;
  bio: string | null;
  joinedAt: string | null;
  principalId: string;
}

/** One `analyst_calls` row, desk-wide (joined to its security + author). */
export interface DeskCall {
  analystPrincipalId: string;
  securityId: number;
  ticker: string | null;
  rating: string | null;
  priceTarget: number | null;
  currency: string | null;
  publishedAt: string | null;
  closedAt: string | null;
}

export interface CoverageDeskInput {
  /** `v_analysts_public` — identity. Empty until the roster is onboarded. */
  roster: AnalystIdentity[];
  /** `getAnalystLeaderboard()` — the scoreboard, keyed by principal id. */
  stats: AnalystLeaderboardRow[];
  /** `getCoverageBySector()` — open calls grouped by `securities.sector`. */
  sectors: Array<{ sector: string; count: number }>;
  /** Recent desk-wide calls, newest first — feeds "Ratings changes this week". */
  recentCalls: DeskCall[];
  /** "Latest from the desk" — `[]` until the byline join exists (see header). */
  latest: DeskArticle[];
  /** Wall-clock reference (ISO). Injected so the mapping is deterministic. */
  now: string;
}

/** The sidebar bar ramp is design-baked at 170px for the largest sector. */
const MAX_BAR_PX = 170;

/**
 * Rank the desk exactly as `getAnalystLeaderboard` does — by average closed-call
 * return, descending, unranked (no closed calls) last. Exported because the 1j
 * header's "RANK #n" must agree with the 1i table; deriving it twice from the
 * same ordering is what guarantees they cannot disagree.
 */
export function rankRoster(
  roster: AnalystIdentity[],
  stats: AnalystLeaderboardRow[],
): Array<{ identity: AnalystIdentity; stat: AnalystLeaderboardRow | null; rank: number }> {
  const byId = new Map(stats.map((s) => [s.analystPrincipalId, s]));
  return roster
    .map((identity) => ({ identity, stat: byId.get(identity.principalId) ?? null }))
    .sort((a, b) => {
      const av = a.stat?.avgCallReturnPct ?? null;
      const bv = b.stat?.avgCallReturnPct ?? null;
      if (av === null && bv === null) return (a.identity.displayName ?? a.identity.slug).localeCompare(b.identity.displayName ?? b.identity.slug);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Coarse bullishness ordering used to classify an upgrade vs a downgrade. */
const RATING_RANK: Record<string, number> = {
  sell: 1,
  underperform: 2,
  underweight: 2,
  reduce: 2,
  hold: 3,
  neutral: 3,
  "market perform": 3,
  accumulate: 4,
  add: 4,
  outperform: 4,
  overweight: 4,
  buy: 5,
  "strong buy": 6,
};

function ratingRank(rating: string | null): number | null {
  const key = (rating ?? "").trim().toLowerCase();
  return key in RATING_RANK ? RATING_RANK[key] : null;
}

function titleCaseRating(rating: string | null): string {
  const s = (rating ?? "").trim();
  if (!s) return DASH;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * "Ratings changes — this week": derived by comparing each call to the previous
 * call by the SAME analyst on the SAME security. An upgrade/downgrade is a real
 * rating move, a PT raise/cut is a target move at an unchanged rating, and a
 * first-ever call is an initiation. Nothing here is inferred from a single row
 * in isolation — a call with no predecessor and no rating we recognise is
 * dropped rather than labelled.
 */
export function deriveRatingChanges(
  calls: DeskCall[],
  roster: AnalystIdentity[],
  nowIso: string,
  limit = 6,
): RatingChange[] {
  const nameById = new Map(roster.map((r) => [r.principalId, shortName(r.displayName, r.slug)]));

  // Oldest → newest per (analyst, security) so "the previous call" is well defined.
  const history = new Map<string, DeskCall[]>();
  for (const c of calls) {
    const key = `${c.analystPrincipalId}::${c.securityId}`;
    const list = history.get(key);
    if (list) list.push(c);
    else history.set(key, [c]);
  }

  const out: Array<RatingChange & { at: string }> = [];
  for (const list of history.values()) {
    const ordered = [...list].sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
    ordered.forEach((call, i) => {
      const days = daysBetween(call.publishedAt, nowIso);
      if (days === null || days < 0 || days >= 7) return; // "this week" only
      const prev = i > 0 ? ordered[i - 1] : null;
      const ticker = call.ticker ?? DASH;
      const analyst = nameById.get(call.analystPrincipalId) ?? DASH;
      const date = recencyLabel(call.publishedAt, nowIso);
      const pt = money(call.priceTarget, call.currency);

      let type: RatingChangeType | null = null;
      let direction: "up" | "down" = "up";
      let note = "";

      if (!prev) {
        const rank = ratingRank(call.rating);
        if (rank === null) return; // unknown rating on a first call — nothing honest to say
        type = "INITIATION";
        direction = rank >= 4 ? "up" : "down";
        note = pt === DASH ? titleCaseRating(call.rating) : `${titleCaseRating(call.rating)} · PT ${pt}`;
      } else {
        const a = ratingRank(prev.rating);
        const b = ratingRank(call.rating);
        if (a !== null && b !== null && b !== a) {
          type = b > a ? "UPGRADE" : "DOWNGRADE";
          direction = b > a ? "up" : "down";
          note = `${titleCaseRating(prev.rating)} → ${titleCaseRating(call.rating)}`;
          if (pt !== DASH) note += ` · PT ${pt}`;
        } else if (
          prev.priceTarget !== null &&
          call.priceTarget !== null &&
          prev.priceTarget !== call.priceTarget
        ) {
          const up = call.priceTarget > prev.priceTarget;
          type = up ? "PT RAISE" : "PT CUT";
          direction = up ? "up" : "down";
          note = `${titleCaseRating(call.rating)} · PT ${prev.priceTarget.toFixed(2)} → ${call.priceTarget.toFixed(2)}`;
        }
      }

      if (!type) return;
      out.push({ direction, type, ticker, date, note, analyst, at: call.publishedAt ?? "" });
    });
  }

  return out
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((rc): RatingChange => ({
      direction: rc.direction,
      type: rc.type,
      ticker: rc.ticker,
      date: rc.date,
      note: rc.note,
      analyst: rc.analyst,
    }));
}

/**
 * `CoverageDeskInput` → the 1i contract, or **null** when there is no desk to
 * show — which is today's live state (0 analysts) and the signal for the page
 * to render `EmptyState variant="awaitingFeed"`.
 *
 * The leaderboard carries only analysts with at least one CLOSED call: win rate
 * and average call return are undefined without one, and the contract types
 * them as plain numbers, so an analyst with no closed track record would have
 * to be shown as "0% / +0.0%" — a fabricated score. They keep their profile
 * page; they simply are not ranked until a call closes.
 */
export function toCoverageDesk(input: CoverageDeskInput): CoverageDeskData | null {
  const ranked = rankRoster(input.roster, input.stats);

  const analysts: LeaderboardAnalyst[] = ranked
    .filter((r) => (r.stat?.closedCallCount ?? 0) > 0)
    .map((r, i) => {
      const stat = r.stat!;
      return {
        rank: i + 1,
        slug: r.identity.slug,
        initials: initialsOf(r.identity.displayName, r.identity.slug),
        name: r.identity.displayName ?? r.identity.slug,
        focus: r.identity.title ?? stat.title ?? DASH,
        names: stat.namesCovered,
        winRate: Math.round(stat.winRatePct ?? 0),
        avgReturn: stat.avgCallReturnPct ?? 0,
        last5: stat.lastFive,
        // No follow/subscription producer exists — never a plausible number.
        followers: DASH,
      };
    });

  if (analysts.length === 0) return null;

  const maxSector = input.sectors.reduce((m, s) => Math.max(m, s.count), 0);
  const sectors: SectorBar[] = input.sectors.map((s) => ({
    sector: humanizeSector(s.sector),
    count: s.count,
    barWidth: maxSector > 0 ? Math.max(8, Math.round((s.count / maxSector) * MAX_BAR_PX)) : 8,
  }));

  const totalNames = input.sectors.reduce((sum, s) => sum + s.count, 0);
  const subtitle =
    `${analysts.length} ranked analyst${analysts.length === 1 ? "" : "s"} · ` +
    `${totalNames} GCC name${totalNames === 1 ? "" : "s"} under coverage · ` +
    "every call tracked and scored in public";

  return {
    subtitle,
    analysts,
    latest: input.latest,
    ratingsChanges: deriveRatingChanges(input.recentCalls, input.roster, input.now),
    sectors,
    totalNames,
    // No initiation-vote producer — say so rather than invent a leader.
    requestCoverage: { leadName: "No nominations yet", votes: 0 },
  };
}

// ── Analyst Profile (1j) ─────────────────────────────────────────────────────

/** Per-security extras the profile needs that `AnalystCallView` does not carry. */
export interface SecurityMeta {
  currency: string | null;
  /** `quotes_latest.last` — used to mark an OPEN call to market. */
  last: number | null;
}

/** A published piece linked from one of this analyst's calls (`content_id`). */
export interface LinkedContent {
  id: string;
  slug: string | null;
  headline: string;
  isPremium: boolean;
  publishedAt: string | null;
  readMinutes: number | null;
}

export interface AnalystProfileInput {
  detail: AnalystProfileDetail;
  /** 1-based desk position, from `rankRoster` — must match the 1i table. */
  rank: number;
  securityMeta: Record<number, SecurityMeta | undefined>;
  content: LinkedContent[];
}

/** The 1j chart is a fixed 800×190 viewBox with three baked gridlines. */
const CHART_W = 800;
const CHART_H = 190;
const CHART_GRID_Y = [47, 95, 143];
const CHART_PAD = 14;

/** An empty frame — drawn (and labelled) rather than faked when there is no series. */
const EMPTY_CHART: PerfChart = {
  width: CHART_W,
  height: CHART_H,
  gridY: CHART_GRID_Y,
  analystPoints: "",
  venuePoints: "",
  rightLabels: [],
  months: [],
  legendAnalyst: "NO CLOSED CALLS YET",
  legendVenue: "VENUE INDEX —",
};

/**
 * Cumulative closed-call performance vs the venue index. Both series are built
 * from columns Postgres already computed (`call_return_pct`, `vs_index_pct` —
 * frozen at publication by `fn_analyst_call_freeze` and settled on close), so
 * the chart can never disagree with the leaderboard: the index leg is simply
 * `call_return_pct − vs_index_pct`, i.e. what the index did over the same hold.
 * Fewer than two closed calls is not a series — the frame renders empty.
 */
function buildChart(detail: AnalystProfileDetail): PerfChart {
  const closed = detail.calls
    .filter((c) => c.closedAt != null && c.callReturnPct != null)
    .sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""));
  if (closed.length < 2) return EMPTY_CHART;

  const analystCum: number[] = [0];
  const venueCum: number[] = [0];
  for (const c of closed) {
    const r = c.callReturnPct ?? 0;
    const idx = r - (c.vsIndexPct ?? 0);
    analystCum.push(analystCum[analystCum.length - 1] + r);
    venueCum.push(venueCum[venueCum.length - 1] + idx);
  }

  const all = [...analystCum, ...venueCum];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const y = (v: number) => CHART_H - CHART_PAD - ((v - min) / span) * (CHART_H - CHART_PAD * 2);
  const x = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * CHART_W);
  const line = (series: number[]) =>
    series.map((v, i) => `${x(i, series.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  // Right-hand gridline labels: the value each baked gridline actually sits at.
  const valueAt = (py: number) => min + ((CHART_H - CHART_PAD - py) / (CHART_H - CHART_PAD * 2)) * span;

  // Up to seven evenly spaced month ticks across the closed-call timeline.
  const tickCount = Math.min(7, closed.length);
  const months = Array.from({ length: tickCount }, (_, i) =>
    monthTick(closed[Math.round((i / Math.max(tickCount - 1, 1)) * (closed.length - 1))]?.closedAt),
  );

  return {
    width: CHART_W,
    height: CHART_H,
    gridY: CHART_GRID_Y,
    analystPoints: line(analystCum),
    venuePoints: line(venueCum),
    rightLabels: CHART_GRID_Y.map((top) => ({ top, text: signedPct(valueAt(top)) })),
    months,
    legendAnalyst: `${(detail.displayName ?? detail.slug).toUpperCase()} ${signedPct(analystCum[analystCum.length - 1])}`,
    legendVenue: `VENUE INDEX ${signedPct(venueCum[venueCum.length - 1])}`,
  };
}

/**
 * The return to show on an OPEN call. Prefer whatever Postgres recorded; fall
 * back to marking the frozen publication price to the latest quote. A call we
 * can do neither for is omitted from the coverage table (the contract types
 * `callReturn` as a plain number, and 0.0% would be a fabricated flat).
 */
function callReturn(call: AnalystCallView, meta: SecurityMeta | undefined): number | null {
  if (call.callReturnPct !== null) return call.callReturnPct;
  const last = meta?.last ?? null;
  const base = call.priceAtPublication;
  if (last === null || base === null || base === 0) return null;
  return (last / base - 1) * 100;
}

function statsFor(detail: AnalystProfileDetail): ProfileStat[] {
  const win = detail.winRatePct;
  const avg = detail.avgCallReturnPct;
  const joined = ymd(detail.joinedAt);
  return [
    { label: "WIN RATE", value: win === null ? DASH : `${Math.round(win)}%` },
    {
      label: "AVG CALL RETURN",
      value: avg === null ? DASH : signedPct(avg),
      ...(avg === null ? {} : { dir: avg < 0 ? ("down" as const) : ("up" as const) }),
    },
    { label: "CLOSED CALLS", value: String(detail.closedCallCount) },
    {
      label: "UNDER COVERAGE",
      value: `${detail.namesCovered} name${detail.namesCovered === 1 ? "" : "s"}`,
    },
    { label: "PUBLISHING SINCE", value: joined ? String(joined.y) : DASH },
  ];
}

const DISCLOSURE =
  "Marsad analysts may not hold positions in covered names. Every call is timestamped and archived; " +
  "track records cannot be edited retroactively.";

/**
 * `AnalystProfileInput` → the 1j contract. Never returns null: a roster row IS
 * a profile. The caller `notFound()`s when the *lookup* misses — which is every
 * slug today, by data rather than by construction.
 */
export function toAnalystProfile(input: AnalystProfileInput): AnalystProfile {
  const { detail, securityMeta, content } = input;
  const byId = new Map(content.map((c) => [c.id, c]));

  const openCalls = detail.calls.filter((c) => c.closedAt === null);
  const coverage: CoverageRow[] = openCalls.flatMap((c) => {
    const meta = securityMeta[c.securityId];
    const ret = callReturn(c, meta);
    if (ret === null || !c.ticker || !c.venueCode) return [];
    return [
      {
        ticker: c.ticker,
        company: c.name ?? c.ticker,
        rating: titleCaseRating(c.rating),
        target: money(c.priceTarget, meta?.currency ?? null),
        since: sinceLabel(c.publishedAt),
        callReturn: ret,
        venueCode: c.venueCode,
      },
    ];
  });

  // Pinned call = the analyst's best-performing live call, the one the desk
  // would lead with. Quote copy: the linked piece's headline when there is one
  // (the analyst's own published words), else a factual restatement.
  const best = [...openCalls]
    .map((c) => ({ c, ret: callReturn(c, securityMeta[c.securityId]) }))
    .filter((r): r is { c: AnalystCallView; ret: number } => r.ret !== null)
    .sort((a, b) => b.ret - a.ret)[0];

  const pinnedCall = best
    ? {
        date: `PINNED CALL · ${dayMonth(best.c.publishedAt)}`,
        quote:
          (best.c.contentId ? byId.get(best.c.contentId)?.headline : undefined) ??
          `${titleCaseRating(best.c.rating)} on ${best.c.ticker ?? DASH}` +
            (best.c.priceTarget !== null
              ? `, target ${money(best.c.priceTarget, securityMeta[best.c.securityId]?.currency ?? null)}`
              : "") +
            `, called ${dayMonth(best.c.publishedAt)}.`,
        ticker: best.c.ticker ?? DASH,
        returnSince: `${signedPct(best.ret)} SINCE CALL`,
      }
    : {
        date: "PINNED CALL",
        quote: "No open call to pin yet.",
        ticker: DASH,
        returnSince: DASH,
      };

  const publishedResearch: PublishedResearch[] = content
    .filter((c) => c.slug != null)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, 6)
    .map((c) => ({
      slug: c.slug!,
      tag: c.isPremium ? "PREMIUM" : "FREE",
      headline: c.headline,
      meta: [dayMonthTitle(c.publishedAt), c.readMinutes ? `${c.readMinutes} min` : null]
        .filter(Boolean)
        .join(" · "),
    }));

  const credential = [detail.title, detail.credential].filter((s) => s && s.trim()).join(" · ");

  return {
    slug: detail.slug,
    initials: initialsOf(detail.displayName, detail.slug),
    name: detail.displayName ?? detail.slug,
    rank: input.rank,
    credential: credential || DASH,
    bio: detail.bio ?? "",
    // No follow/subscription producer exists — never a plausible number.
    followers: DASH,
    stats: statsFor(detail),
    chart: buildChart(detail),
    coverage,
    pinnedCall,
    publishedResearch,
    publishedCount: content.length > 0 ? `${content.length} PIECE${content.length === 1 ? "" : "S"}` : DASH,
    disclosure: DISCLOSURE,
  };
}

// ── loaders ──────────────────────────────────────────────────────────────────
//
// Everything below is I/O. Each runtime dependency is reached through a DYNAMIC
// import so the module above stays statically dependency-free and testable (see
// the header). `"use cache"` with the default profile keeps these reads inside
// the cached, cookieless anon scope used by the rest of `src/lib/data`.

/**
 * The desk roster — `public.v_analysts_public` (the `security_invoker = false`
 * wrapper added by `20260726190625_v_analysts_public.sql`; `iam.principals` is
 * worker-read-only, so this view is the ONLY public identity path). 0 rows
 * today.
 */
async function listAnalystRoster(limit = 200): Promise<AnalystIdentity[]> {
  "use cache";
  const { createAnonClient } = await import("@/lib/supabase/public");
  const sb = createAnonClient();
  const { data } = await sb
    .from("v_analysts_public")
    .select("slug,display_name,title,credential,bio,joined_at,principal_id")
    .limit(limit);

  type Row = {
    slug: string | null;
    display_name: string | null;
    title: string | null;
    credential: string | null;
    bio: string | null;
    joined_at: string | null;
    principal_id: string | null;
  };

  return ((data as Row[] | null) ?? [])
    .filter((r): r is Row & { slug: string; principal_id: string } => r.slug != null && r.principal_id != null)
    .map((r) => ({
      slug: r.slug,
      displayName: r.display_name,
      title: r.title,
      credential: r.credential,
      bio: r.bio,
      joinedAt: r.joined_at,
      principalId: r.principal_id,
    }));
}

/** Desk-wide recent calls (+ their security identity) for the ratings-change rail. */
async function listRecentDeskCalls(limit = 200): Promise<DeskCall[]> {
  "use cache";
  const { createAnonClient } = await import("@/lib/supabase/public");
  const { toNum } = await import("@/lib/data/util");
  const sb = createAnonClient();

  const { data } = await sb
    .from("analyst_calls")
    .select("analyst_id,security_id,rating,price_target,published_at,closed_at")
    .order("published_at", { ascending: false })
    .limit(limit);

  type Row = {
    analyst_id: string;
    security_id: number;
    rating: string | null;
    price_target: unknown;
    published_at: string | null;
    closed_at: string | null;
  };
  const rows = (data as Row[] | null) ?? [];
  if (rows.length === 0) return [];

  const { data: secs } = await sb
    .from("securities")
    .select("id,ticker,currency")
    .in("id", [...new Set(rows.map((r) => r.security_id))]);
  const secById = new Map(
    ((secs as Array<{ id: number; ticker: string | null; currency: string | null }> | null) ?? []).map((s) => [s.id, s]),
  );

  return rows.map((r) => ({
    analystPrincipalId: r.analyst_id,
    securityId: r.security_id,
    ticker: secById.get(r.security_id)?.ticker ?? null,
    rating: r.rating,
    priceTarget: toNum(r.price_target),
    currency: secById.get(r.security_id)?.currency ?? null,
    publishedAt: r.published_at,
    closedAt: r.closed_at,
  }));
}

/** Per-security currency + latest quote, for marking open calls to market. */
async function loadSecurityMeta(ids: number[]): Promise<Record<number, SecurityMeta | undefined>> {
  "use cache";
  if (ids.length === 0) return {};
  const { createAnonClient } = await import("@/lib/supabase/public");
  const { toNum } = await import("@/lib/data/util");
  const sb = createAnonClient();
  const unique = [...new Set(ids)];

  const [{ data: secs }, { data: quotes }] = await Promise.all([
    sb.from("securities").select("id,currency").in("id", unique),
    sb.from("quotes_latest").select("security_id,last").in("security_id", unique),
  ]);

  const lastById = new Map(
    ((quotes as Array<{ security_id: number; last: unknown }> | null) ?? []).map((q) => [
      q.security_id,
      toNum(q.last),
    ]),
  );
  const out: Record<number, SecurityMeta | undefined> = {};
  for (const s of ((secs as Array<{ id: number; currency: string | null }> | null) ?? [])) {
    out[s.id] = { currency: s.currency, last: lastById.get(s.id) ?? null };
  }
  return out;
}

/**
 * Published pieces linked from a set of calls (`analyst_calls.content_id`).
 * Read through the anon client, so RLS withholds anything not published — a
 * draft can never surface on a profile.
 */
async function loadLinkedContent(ids: string[]): Promise<LinkedContent[]> {
  "use cache";
  if (ids.length === 0) return [];
  const { createAnonClient } = await import("@/lib/supabase/public");
  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select("id,slug,headline,is_premium,published_at,read_minutes")
    .in("id", [...new Set(ids)]);

  type Row = {
    id: string;
    slug: string | null;
    headline: string;
    is_premium: boolean | null;
    published_at: string | null;
    read_minutes: number | null;
  };
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    slug: r.slug,
    headline: r.headline,
    isPremium: r.is_premium ?? false,
    publishedAt: r.published_at,
    readMinutes: r.read_minutes,
  }));
}

/**
 * The 1i surface. `null` = there is no desk to show yet (today's live state) →
 * the page renders `EmptyState variant="awaitingFeed"`, never a sample desk.
 */
export async function loadCoverageDesk(nowIso: string): Promise<CoverageDeskData | null> {
  // Cached at the surface, not just per read: without this the route counts as
  // "uncached data outside <Suspense>" and blocks its own shell (the dev-time
  // `blocking-route` error). `nowIso` is an argument, so it is part of the cache
  // key — one caller's clock can never freeze into another's entry.
  "use cache";
  const { getAnalystLeaderboard, getCoverageBySector } = await import("@/lib/data/editorial");
  const [roster, stats, sectors] = await Promise.all([
    listAnalystRoster(),
    getAnalystLeaderboard(),
    getCoverageBySector(),
  ]);
  if (roster.length === 0) return null;

  const recentCalls = await listRecentDeskCalls();
  return toCoverageDesk({
    roster,
    stats,
    sectors,
    recentCalls,
    // "Latest from the desk" needs a content→analyst byline join that does not
    // exist yet (`content_items.byline_chain` carries agent codes) — an empty
    // strip is the honest state, not three invented headlines.
    latest: [],
    now: nowIso,
  });
}

/**
 * The 1j surface. `null` = no such analyst → the route must `notFound()`.
 * Needs no wall-clock: every date it renders comes from a row.
 */
export async function loadAnalystProfile(slug: string): Promise<AnalystProfile | null> {
  "use cache";
  const { getAnalystLeaderboard, getAnalystProfileBySlug } = await import("@/lib/data/editorial");
  const detail = await getAnalystProfileBySlug(slug);
  if (!detail) return null;

  const [roster, stats, securityMeta, content] = await Promise.all([
    listAnalystRoster(),
    getAnalystLeaderboard(),
    loadSecurityMeta(detail.calls.map((c) => c.securityId)),
    loadLinkedContent(detail.calls.map((c) => c.contentId).filter((id): id is string => id != null)),
  ]);

  const rank = rankRoster(roster, stats).find((r) => r.identity.slug === detail.slug)?.rank ?? 1;
  return toAnalystProfile({ detail, rank, securityMeta, content });
}

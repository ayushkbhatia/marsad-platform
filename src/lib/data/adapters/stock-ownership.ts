import type { Ownership, ShareholdingRow, TopHolder, BoardMember, Manager } from "@/lib/contracts/stock";
import type {
  OwnershipBundle,
  OwnershipSnapshot,
  HolderPosition,
  CompanyPerson,
} from "@/lib/data/stock-events";

/**
 * Ownership & People adapter (design 3d) — `OwnershipBundle` → the `Ownership`
 * contract.
 *
 * WHY IT SHIPS BEFORE ITS PRODUCER: `holders`, `holder_positions`,
 * `ownership_snapshots` and `company_people` are **all 0 rows** today
 * (measured 2026-07-26; producer-pending, DEF-SECTOR-DATA / BRIDGE-BUILD-PLAN
 * P7.5). Per Law #2 the tab must NOT render sample ownership dressed up as
 * real — so this adapter returns `null` for an empty bundle and the page ships
 * `EmptyState variant="awaitingFeed"`. The mapping is written, typed and
 * fixture-tested now so the tab lights up the moment the producer lands, with
 * no further front-end change. Deliberately NOT wrapped in
 * `withSampleFallback`: a known-empty producer is the exact case the fallback
 * must never cover (see `adapters/fallback.ts`).
 *
 * NO RUNTIME IMPORTS BY DESIGN. Every import above is type-only (erased at
 * build time), so this module is a pure function of its argument: no Supabase
 * client, no `server-only`, no `@/` runtime resolution. That is what makes the
 * fixture test (`__tests__/stock-ownership.test.ts`) able to prove the wiring
 * without a live producer and without a bundler. Formatting therefore lives
 * here rather than in `@/lib/reader/format` — the contract's fields are
 * pre-formatted strings, and keeping them local keeps the module dependency
 * -free.
 */

/** The shareholding matrix is a fixed 8-column grid in `StockOwnership`. */
const PERIOD_SLOTS = 8;

/** The one placeholder used for a period/value the producer has not supplied. */
const DASH = "—";

/** U+2212 minus, matching the design's numerals. */
const MINUS = "−";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Split a `YYYY-MM-DD` (or ISO timestamp) date string without constructing a
 * `Date` — a `Date` would re-interpret the calendar date in the server's zone
 * and can shift a quarter-end back a day (the postgres.js Date trap, applied
 * to formatting). Returns null for anything unparseable.
 */
function ymd(iso: string | null | undefined): { y: number; m: number } | null {
  const m = /^(\d{4})-(\d{2})/.exec((iso ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { y: Number(m[1]), m: month };
}

/** `2026-03-31` → `Mar '26` (shareholding-matrix column head). */
function periodLabel(iso: string | null | undefined): string {
  const d = ymd(iso);
  if (!d) return DASH;
  const mon = MONTHS[d.m - 1];
  return `${mon.charAt(0)}${mon.slice(1).toLowerCase()} '${String(d.y % 100).padStart(2, "0")}`;
}

/** `2026-03-31` → `MAR '26 DISCLOSURES` (top-holders as-of stamp). */
function disclosureLabel(iso: string | null | undefined): string {
  const d = ymd(iso);
  if (!d) return "AS-OF DATE PENDING";
  return `${MONTHS[d.m - 1]} '${String(d.y % 100).padStart(2, "0")} DISCLOSURES`;
}

function pct2(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(2)}%`;
}

/** `foreign_institutions` / `foreign institutions` → `Foreign institutions`. */
function humanize(raw: string): string {
  const s = raw.replace(/[_-]+/g, " ").trim();
  if (!s) return DASH;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Left-pad a series to the fixed 8 columns so short histories stay aligned. */
function padStart8(values: string[]): string[] {
  if (values.length >= PERIOD_SLOTS) return values.slice(values.length - PERIOD_SLOTS);
  return [...Array<string>(PERIOD_SLOTS - values.length).fill(DASH), ...values];
}

function buildPeriods(snapshots: OwnershipSnapshot[]): string[] {
  return padStart8(snapshots.map((s) => periodLabel(s.asOf)));
}

/**
 * One row per ownership category, ordered by the newest snapshot's stake
 * (largest first); categories that only appear in older snapshots follow,
 * alphabetically. Category keys are producer-defined and not yet fixed, so the
 * union across snapshots is taken rather than a hardcoded taxonomy.
 */
function buildRows(snapshots: OwnershipSnapshot[]): ShareholdingRow[] {
  const latest = snapshots[snapshots.length - 1];
  const keys = new Set<string>();
  for (const s of snapshots) for (const k of Object.keys(s.categories)) keys.add(k);
  if (keys.size === 0) return [];

  const ordered = [...keys].sort((a, b) => {
    const av = latest?.categories[a];
    const bv = latest?.categories[b];
    if (av != null && bv != null && av !== bv) return bv - av;
    if (av != null && bv == null) return -1;
    if (av == null && bv != null) return 1;
    return a.localeCompare(b);
  });

  return ordered.map((key) => ({
    label: humanize(key),
    values: padStart8(snapshots.map((s) => pct2(s.categories[key] ?? null))),
  }));
}

function foreignAtRecord(latest: OwnershipSnapshot | null): string {
  if (!latest || latest.foreignOwnershipPct == null) return "FOREIGN OWNERSHIP NOT DISCLOSED";
  const value = pct2(latest.foreignOwnershipPct);
  return latest.isFolRecord ? `FOREIGN OWNERSHIP AT RECORD ${value}` : `FOREIGN OWNERSHIP ${value}`;
}

function toTopHolder(h: HolderPosition): TopHolder {
  const base = { name: h.name, type: humanize(h.holderType), pct: pct2(h.stakePct) };
  const qoq = h.qoqChangePp;
  if (qoq == null || !Number.isFinite(qoq)) return { ...base, change: DASH };
  if (qoq === 0) return { ...base, change: "unchanged" };
  return {
    ...base,
    change: `${qoq > 0 ? "+" : MINUS}${Math.abs(qoq).toFixed(2)}`,
    changeDir: qoq > 0 ? "up" : "down",
  };
}

function toBoardMember(p: CompanyPerson): BoardMember {
  const d = ymd(p.asOf);
  return {
    name: p.name,
    role: p.title ?? (p.isIndependent === true ? "Independent director" : "Director"),
    since: d ? String(d.y) : DASH,
  };
}

function toManager(p: CompanyPerson): Manager {
  return {
    name: p.name,
    role: p.title ?? "Management",
    // No biography column exists on `company_people` — left empty rather than
    // invented. Fills in when the producer supplies one (Law #2).
    bio: "",
  };
}

function boardMeta(board: CompanyPerson[]): string {
  if (board.length === 0) return "";
  // `seat_count` is the disclosed board size when the producer supplies it;
  // otherwise the number of disclosed directors is the honest floor.
  const seats = board.reduce((max, p) => Math.max(max, p.seatCount ?? 0), 0) || board.length;
  const independent = board.filter((p) => p.isIndependent === true).length;
  const seatPart = `${seats} SEATS`;
  return independent > 0 ? `${seatPart} · ${independent} INDEPENDENT` : seatPart;
}

/**
 * Free-float / overhang commentary has no producer at all (it is not a column
 * on any of the four ownership tables). Stated as absent rather than filled
 * with a plausible sentence.
 */
const FLOAT_WATCH_PENDING =
  "Free-float and overhang analysis appears here once the ownership producer supplies " +
  "share-class, lock-up and free-float detail. No float figure is published for this security yet.";

/**
 * Map an `OwnershipBundle` to the `Ownership` view-model contract.
 *
 * Returns `null` when the bundle is genuinely empty — no holders, no
 * snapshots, no people. That `null` is the signal for the route to render
 * `EmptyState variant="awaitingFeed"`, which is what every security resolves
 * to today. A partially-populated bundle still renders: missing pieces degrade
 * to `—` rather than hiding the sections that do have rows.
 */
export function toOwnership(bundle: OwnershipBundle): Ownership | null {
  const { holders, snapshots, latestSnapshot, board, management } = bundle;

  if (
    holders.length === 0 &&
    snapshots.length === 0 &&
    board.length === 0 &&
    management.length === 0
  ) {
    return null;
  }

  const periods = buildPeriods(snapshots);

  return {
    periods,
    foreignAtRecord: foreignAtRecord(latestSnapshot),
    rows: buildRows(snapshots),
    // `ownership_snapshots` carries no shareholder headcount column; the row
    // stays in the matrix (the design's 8-column grid) but reads "—".
    shareholderCount: padStart8([]),
    topHolders: holders.map(toTopHolder),
    topHoldersAsOf: disclosureLabel(holders[0]?.asOf ?? latestSnapshot?.asOf ?? null),
    floatWatchHtml: FLOAT_WATCH_PENDING,
    board: board.map(toBoardMember),
    boardMeta: boardMeta(board),
    management: management.map(toManager),
  };
}

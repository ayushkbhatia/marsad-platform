import "server-only";
import type {
  CorporateAction,
  ExchangeFiling,
  FeedConnection,
  MostReadItem,
  NewswireData,
  WireCategory,
  WireFeedItem,
  WireTicker,
  WireVenue,
} from "@/lib/contracts/newswire";
import { getWireFilings, getFilingTypeFacets, type FilingItem } from "@/lib/data/filings";
import { getWireVenueFacets, getFilingsTodayCount, getQuotesForSecurities, WIRE_VENUE_CODES } from "@/lib/data/wire";
import { getVenueFreshness } from "@/lib/data/markets";
import { isVenueTrading } from "@/lib/market/freshness";
import {
  filingToWireItem,
  sortWireFeed,
  groupWireFeedByDay,
  fmtSyncClock,
  type WireFeedItem as ShapedFeedItem,
} from "@/components/reader/wire/feed";

/**
 * ADAPTER — Newswire (design 1d, step P2.2).
 *
 * **This is the CANONICAL REFERENCE ADAPTER** (`BRIDGE-PLAN.md` §4). Every
 * later adapter is expected to copy its shape, so the shape is stated once
 * here:
 *
 *   1. `import "server-only"` — an adapter is a server module; it may import
 *      the `use cache` reads, which are all `server-only` themselves.
 *   2. It imports READS, never a Supabase client. No adapter opens its own
 *      connection: the read layer owns caching (`cacheLife`/`cacheTag`) and
 *      RLS posture. This adapter adds zero new queries.
 *   3. It NEVER edits the contract to fit a column (Law #1). Where the DB
 *      cannot serve a section, the section comes back EMPTY and the page shows
 *      the honest empty state (Law #2). New *optional* contract fields are a
 *      legal extension; changing an existing one is not.
 *   4. Every wall-clock read is a PARAMETER (`todayISO`), never `new Date()`
 *      inside a cached read — the caller does the clock read behind
 *      `await connection()` (P0.7).
 *   5. It reports its own provenance (`NewswireResult.provenance`) so the page
 *      and the reviewer can see which sections are real without reading SQL.
 *
 * **No sample fallback, deliberately.** `withSampleFallback` is only correct
 * when the sample stands in for content that genuinely exists upstream. Here
 * the sample carries invented tickers, invented venues and invented headlines
 * ("Maaden completes phosphate debottlenecking…"); serving those as the GCC
 * wire would be fabrication, not a placeholder — the same reasoning as
 * `stock-filings.ts`. An empty/failed read yields an empty feed and the page
 * renders `EmptyState awaitingFeed`.
 *
 * ── What is REAL, measured against the live DB on 2026-07-26 ────────────────
 *
 * | contract section  | source                                    | state          |
 * |-------------------|-------------------------------------------|----------------|
 * | `feed`            | `public.filings` (14,632 rows)             | REAL           |
 * | `filings` (rail)  | `public.filings` ⋈ `securities`            | REAL           |
 * | `categories`      | `getFilingTypeFacets()` (bounded 4k scan)  | REAL           |
 * | `venues`          | `getWireVenueFacets()` (bounded 4k scan)   | REAL           |
 * | `todayCount`      | `getFilingsTodayCount({todayISO,…})`       | REAL           |
 * | `connection`      | `public.venue_feed_status` (6 rows)        | REAL           |
 * | `corporateActions`| `dividends` — 1,229 rows, **0 anon-visible** (all `pending_confirm`, NULL `ex_date`) | EMPTY → DEF-WIRE-CORPACTIONS |
 * | `mostRead`        | no analytics store anywhere in the schema  | EMPTY → DEF-WIRE-MOSTREAD |
 *
 * ── Two live data-quality facts this adapter degrades around ────────────────
 *
 * 1. **`filed_at` is an ingest stamp, not the publication date, on 3,437 of
 *    7,120 TDWL rows** (DEF-TDWL-FILED-AT). Measured: of the newest 60 rows by
 *    `filed_at`, the 29 TDWL ones carry true publication dates spanning
 *    **2016-03-03 → 2026-05-04**. Dating those "today" — which is what a naive
 *    `order by filed_at` wire does — would mis-date half of Tadawul. The true
 *    timestamp is in the machine ref (`…_2022-05-10_16-54-02_Eng`), so it is
 *    parsed out with a strict regex (never inferred) and drives BOTH the
 *    displayed clock and the ordering. Rows with no ref stamp keep `filed_at`.
 *    Pagination stays keyed on `filed_at` because that is what the DB indexes
 *    and what `getWireFilings` cursors on — so a page is ingest-bounded but
 *    internally ordered by true date, which is the honest combination.
 * 2. **Machine titles.** TDWL 3,436 + DFM 747 rows have an unreadable source
 *    ref where the headline should be. A readable label is derived from real
 *    columns only (`securities.name_en` + `filing_type`, else `filing_type` +
 *    the parsed date) — never invented prose.
 *
 * Both rules mirror `adapters/stock-filings.ts`, which solved them first for
 * design 3c. They are duplicated rather than shared because the two adapters
 * are the only consumers today and `stock-filings.ts` is outside this step's
 * file boundary; **TODO(P8): extract `parseRefTimestamp`/`isMachineRef`/
 * `typeLabel` into `src/lib/data/adapters/filing-label.ts` and have both import
 * it.**
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────
// The live `filing_type` set (whole corpus): RESULTS 14,098 · OTHER 307 ·
// GOVERNANCE 143 · OPS 61 · CAPEX 11 · DIVIDEND 6 · CONTRACT 3 · RATING 3.

/** Rail label (plural, human) for a `filing_type`. */
const CATEGORY_LABEL: Record<string, string> = {
  RESULTS: "Results & statements",
  OTHER: "Other disclosures",
  GOVERNANCE: "Governance",
  OPS: "Operational updates",
  CAPEX: "Capital expenditure",
  DIVIDEND: "Dividends & actions",
  CONTRACT: "Contract awards",
  RATING: "Ratings changes",
};

/** Singular label used when a filing has no readable title of its own. */
const TYPE_LABEL: Record<string, string> = {
  RESULTS: "Results filing",
  DIVIDEND: "Dividend announcement",
  GOVERNANCE: "Governance disclosure",
  OPS: "Operational update",
  CAPEX: "Capital expenditure announcement",
  CONTRACT: "Contract award",
  RATING: "Credit rating action",
  OTHER: "Exchange filing",
};

/**
 * Short venue labels for the 232px rail. `public.venues.name` carries the legal
 * names ("Saudi Exchange (Tadawul)", "Abu Dhabi Securities Exchange") which do
 * not fit the design's rail — this is a LAYOUT concern, so it lives in code
 * (Law #3), keyed on the real venue code from `WIRE_VENUE_CODES`.
 */
const VENUE_LABEL: Record<string, string> = {
  TDWL: "Tadawul",
  DFM: "DFM",
  ADX: "ADX",
  QE: "QE",
  MSX: "MSX",
  BHB: "Bahrain Bourse",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** `10 May 2022` — the date embedded in a derived headline. */
function fmtTitleDate(iso: string | null): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  const m = MONTHS[d.getUTCMonth()];
  return `${d.getUTCDate()} ${m[0]}${m.slice(1).toLowerCase()} ${d.getUTCFullYear()}`;
}

/** `14:21` (UTC) — the feed's time gutter. */
function fmtGutterClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * A title that is a machine reference, not prose: no whitespace at all and long
 * enough that it cannot be a real headline (`TDWL-XBRL-353_1120_2022-05-10_…`).
 * Real titles across every venue contain spaces ("BOD meeting", "Detailed report
 * — 2026-06-30", "Financial Results for the period ended 30 June 2026").
 */
function isMachineRef(title: string): boolean {
  return title.length >= 16 && !/\s/.test(title);
}

/**
 * Pull the publication timestamp out of a source-style ref
 * (`…_2022-05-10_16-54-02_Eng`). Strict: both a date and a time part must be
 * present, and the result must parse. Returns null otherwise — never a guess.
 */
const REF_STAMP = /_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_|$)/;

function parseRefTimestamp(title: string | null): string | null {
  if (!title) return null;
  const m = REF_STAMP.exec(title);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

function typeKey(filingType: string | null): string {
  return (filingType ?? "").trim().toUpperCase();
}

function typeLabel(filingType: string | null): string {
  return TYPE_LABEL[typeKey(filingType)] ?? "Exchange filing";
}

function collapse(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** The filing's TRUE date: parsed from the machine ref when present, else `filed_at`. */
function effectiveAt(f: FilingItem): string | null {
  return parseRefTimestamp(f.title) ?? f.filedAt;
}

/**
 * A readable headline built only from real columns. Order of preference:
 * the filing's own title (when it is prose), then `company — type`, then
 * `type — date`. Nothing is invented at any step.
 */
function headlineOf(f: FilingItem, at: string | null): string {
  const raw = collapse(f.title);
  if (raw && !isMachineRef(raw)) return raw;
  const name = collapse(f.name);
  return name ? `${name} — ${typeLabel(f.filingType)}` : `${typeLabel(f.filingType)} — ${fmtTitleDate(at)}`;
}

// ── URL helpers (the filter/pagination seam) ─────────────────────────────────

export interface WireFilter {
  venue?: string;
  type?: string;
  cursor?: string;
}

function wireHref(next: WireFilter): string {
  const qs = new URLSearchParams();
  if (next.venue) qs.set("venue", next.venue);
  if (next.type) qs.set("type", next.type);
  if (next.cursor) qs.set("cursor", next.cursor);
  const s = qs.toString();
  return s ? `/wire?${s}` : "/wire";
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildCategories(
  facets: Array<{ type: string; count: number }>,
  filter: WireFilter,
): WireCategory[] {
  const total = facets.reduce((n, f) => n + f.count, 0);
  const active = typeKey(filter.type ?? null);

  const all: WireCategory = {
    name: "All items",
    count: total,
    selected: active === "",
    // "All items" clears the type but KEEPS the venue — the two rails are
    // independent filters, and dropping the venue on a category click would
    // silently widen the query the reader asked for.
    href: wireHref({ venue: filter.venue }),
  };

  return [
    all,
    ...facets.map((f) => ({
      name: CATEGORY_LABEL[f.type] ?? f.type,
      count: f.count,
      selected: active === f.type,
      href: wireHref({ venue: filter.venue, type: active === f.type ? undefined : f.type }),
    })),
  ];
}

function buildVenues(
  facets: Array<{ venue: string; count: number }>,
  filter: WireFilter,
): WireVenue[] {
  const byCode = new Map(facets.map((f) => [f.venue, f.count]));
  const active = (filter.venue ?? "").trim().toUpperCase();

  // FIXED order (never sorted by count) — the rail must not reflow as counts
  // move. `WIRE_VENUE_CODES` is the read layer's own canonical order.
  return WIRE_VENUE_CODES.map((code) => ({
    code,
    name: VENUE_LABEL[code] ?? code,
    count: byCode.get(code) ?? 0,
    // No venue filter = the whole wire = every venue included, which is what
    // the design's all-pre-checked state means. With a filter, exactly one is.
    checked: active === "" || active === code,
    href: wireHref({ venue: active === code ? undefined : code, type: filter.type }),
  }));
}

/**
 * Aggregate the 6 `venue_feed_status` rows into the single banner the design
 * shows. `venue_feed_status.state` is a 7-value superset of this contract's
 * 4-value union (it also emits `halted`/`auction`/`closed`), so it is folded —
 * and NEVER folded upward: a closed or unknown venue degrades to `delayed`,
 * never to `live` (the same law `toBadgeState` encodes).
 */
function buildConnection(
  rows: Array<{ venue: string; state: string; detail: string | null; lastSync: string | null }>,
): FeedConnection {
  if (rows.length === 0) {
    return { state: "offline", detail: "NO FEED STATUS", message: "Feed status is unavailable." };
  }

  const open = rows.filter((r) => isVenueTrading(r.state)).length;
  const lastSync = rows
    .map((r) => r.lastSync)
    .filter((s): s is string => !!s)
    .sort()
    .at(-1) ?? null;

  const state: FeedConnection["state"] =
    open === rows.length ? "live"
      : rows.some((r) => r.state === "reconnecting") ? "reconnecting"
        : rows.every((r) => r.state === "offline") ? "offline"
          : "delayed";

  const scope = open > 0 ? `${open}/${rows.length} VENUES OPEN` : `ALL ${rows.length} VENUES CLOSED`;
  const detail = `LAST SYNC ${fmtSyncClock(lastSync)} · ${scope}`;

  // A row-level `detail` is used verbatim when the venue supplied one (all 6
  // are NULL live today), so an operator note reaches the reader unchanged.
  const noted = rows.map((r) => collapse(r.detail)).filter(Boolean);

  const message =
    state === "live"
      ? undefined
      : noted.length > 0
        ? noted.join(" · ")
        : state === "reconnecting"
          ? "Reconnecting to the exchange feed — items may be delayed a few seconds."
          : state === "offline"
            ? "The exchange feed is offline. Items below are the last received."
            : open > 0
              ? "Some venues are outside trading hours — their items are delayed."
              : "All six venues are outside trading hours. The wire shows the last items received from each.";

  return { state, detail, message };
}

function toTicker(f: FilingItem, changePct: number | null): WireTicker | null {
  // No ticker without a resolved security, and no chip without a REAL quote:
  // `WireTicker.changePct` is a required number, and printing 0.0% for an
  // unquoted name would be a fabricated price move. 705 of 762 securities are
  // quoted, so the chip is present wherever the number exists.
  if (!f.ticker || changePct == null) return null;
  return { symbol: f.ticker.toUpperCase(), changePct };
}

/**
 * Map the shaped feed (`components/reader/wire/feed.ts`) onto the contract.
 * `filingToWireItem` owns the row→shape mapping and `href` (`/filings/{id}`,
 * a live route — every feed item therefore has a WORKING link, never `"#"`);
 * this function only formats it for the 1d component.
 */
function toContractFeed(
  shaped: ShapedFeedItem[],
  byId: Map<string, { filing: FilingItem; at: string | null; changePct: number | null }>,
): { items: WireFeedItem[]; dateLabel: string } {
  const groups = groupWireFeedByDay(shaped);
  const items: WireFeedItem[] = [];

  groups.forEach((g, gi) => {
    g.items.forEach((s, si) => {
      const src = byId.get(s.id);
      if (!src) return;
      const { filing, at, changePct } = src;
      const ticker = toTicker(filing, changePct);
      items.push({
        id: s.id,
        time: fmtGutterClock(at),
        venue: (filing.venueCode ?? "—").toUpperCase(),
        category: typeKey(filing.filingType) || "FILING",
        headline: headlineOf(filing, at),
        // Only 351 of the newest 4,000 rows carry an `ai_summary`. No summary →
        // no line (the component omits it), never a placeholder sentence.
        summary: collapse(filing.aiSummary),
        tickers: ticker ? [ticker] : undefined,
        // `isDeveloping` is the newsroom's own live-updating story treatment.
        // There is no such source on this surface yet (`content_items` has 1
        // published row and P3 owns the editorial half), and `is_market_moving`
        // is NOT the same claim — so no filing is dressed as "DEVELOPING".
        href: s.href,
        // First group is labelled by `dateLabel`; later groups get an inline divider.
        dayLabel: gi > 0 && si === 0 ? g.label : undefined,
      });
    });
  });

  // The day labels are `groupWireFeedByDay`'s own, so the top-of-feed label and
  // every inline divider are formatted by exactly one function.
  return { items, dateLabel: groups[0]?.label ?? "Undated" };
}

function toRailFilings(
  prepared: Array<{ filing: FilingItem; at: string | null }>,
  limit: number,
): ExchangeFiling[] {
  // The rail's primary line IS the company name, so a row whose `security_id`
  // is unresolved (88 of the newest 200 live) is skipped rather than shown
  // under a placeholder company — a filing must never appear under a name that
  // is not its own.
  return prepared
    .filter((p) => collapse(p.filing.name).length > 0)
    .slice(0, limit)
    .map(({ filing: f, at }) => {
      const raw = collapse(f.title);
      return {
        id: `filing-${f.id}`,
        time: fmtGutterClock(at),
        venue: (f.venueCode ?? "—").toUpperCase(),
        company: collapse(f.name),
        filingType: raw && !isMachineRef(raw) ? raw : typeLabel(f.filingType),
        href: `/filings/${f.id}`,
      };
    });
}

// ── Provenance ───────────────────────────────────────────────────────────────

export interface NewswireProvenance {
  /** Rows returned by `getWireFilings` before date re-ordering / trimming. */
  fetched: number;
  /** Rows rendered in the centre feed. */
  shown: number;
  /** How many of the shown rows had their date recovered from the machine ref. */
  dateFromRef: number;
  /** How many of the shown rows had their headline derived (machine/empty title). */
  headlineDerived: number;
  /** How many of the shown rows carried a real `ai_summary`. */
  withAiSummary: number;
  /** Contract sections with no producer, rendered as honest empty states. */
  emptySections: string[];
}

export interface NewswireResult {
  data: NewswireData;
  provenance: NewswireProvenance;
}

/**
 * Build the 1d view-model from live reads.
 *
 * `todayISO` is a PARAMETER for the reason in the module docblock: the caller
 * reads the clock behind `await connection()` so no cached read ever contains
 * a wall-clock value.
 */
export async function getNewswire(opts: {
  todayISO: string;
  venue?: string;
  type?: string;
  cursor?: string;
  /** Rows rendered in the centre feed. */
  limit?: number;
}): Promise<NewswireResult> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const filter: WireFilter = { venue: opts.venue, type: opts.type, cursor: opts.cursor };

  const [page, typeFacets, venueFacets, todayCount, freshness] = await Promise.all([
    // A WIDER window than we render: the page must be re-ordered by the true
    // publication date (see docblock fact #1) and trimmed afterwards, or a 2016
    // Tadawul filing would sit at the top of today's wire.
    getWireFilings({ venue: opts.venue, type: opts.type, cursor: opts.cursor, limit: 100 }),
    getFilingTypeFacets(),
    getWireVenueFacets(),
    getFilingsTodayCount({ todayISO: opts.todayISO, venue: opts.venue, type: opts.type }),
    getVenueFreshness(),
  ]);

  const prepared = page.items
    .map((filing) => ({ filing, at: effectiveAt(filing) }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  const shownSource = prepared.slice(0, limit);

  const quotes = await getQuotesForSecurities(
    shownSource.map((p) => p.filing.securityId).filter((n): n is number => n != null),
  );

  const byId = new Map(
    shownSource.map((p) => [
      `filing-${p.filing.id}`,
      {
        filing: p.filing,
        at: p.at,
        changePct: p.filing.securityId != null ? quotes.get(p.filing.securityId)?.changePct ?? null : null,
      },
    ]),
  );

  // REUSE the orphaned shaping layer rather than re-deriving it: `filingToWireItem`
  // owns the row→item mapping and the `/filings/{id}` href, `sortWireFeed` the
  // newest-first order, `groupWireFeedByDay` the day buckets. They are fed the
  // ref-corrected timestamp so their ordering and grouping use the TRUE date.
  const shaped = sortWireFeed(
    shownSource.map((p) => ({ ...filingToWireItem(p.filing), filedAt: p.at })),
  );

  const { items: feed, dateLabel } = toContractFeed(shaped, byId);

  const data: NewswireData = {
    categories: buildCategories(typeFacets, filter),
    venues: buildVenues(venueFacets, filter),
    todayCount,
    dateLabel,
    connection: buildConnection(freshness),
    feed,
    filings: toRailFilings(prepared, 6),
    // `public.dividends` = 1,229 rows, ALL at `state='pending_confirm'` with a
    // NULL `ex_date` → **0 rows are visible to anon**. There is nothing to show,
    // and the sample's five ex-dividend lines are invented. Honest empty state.
    // → DEF-WIRE-CORPACTIONS, trigger: P7.1 (the dividend confirmation producer).
    corporateActions: [] as CorporateAction[],
    // There is NO analytics store in the schema — no page-view, no read-count,
    // no ranking table anywhere. "Most read" cannot be computed from anything
    // that exists. → DEF-WIRE-MOSTREAD, trigger: an analytics producer.
    mostRead: [] as MostReadItem[],
    olderHref: page.nextCursor ? wireHref({ ...filter, cursor: page.nextCursor }) : null,
  };

  return {
    data,
    provenance: {
      fetched: page.items.length,
      shown: feed.length,
      dateFromRef: shownSource.filter((p) => parseRefTimestamp(p.filing.title) != null).length,
      headlineDerived: shownSource.filter((p) => {
        const raw = collapse(p.filing.title);
        return !raw || isMachineRef(raw);
      }).length,
      withAiSummary: feed.filter((i) => i.summary.length > 0).length,
      emptySections: ["corporateActions", "mostRead"],
    },
  };
}

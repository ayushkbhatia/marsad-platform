import "server-only";
import type { Announcement, FilingsConcalls } from "@/lib/contracts/stock";
import { getFilingsForSecurity, getFilingsCountForSecurity, type FilingItem } from "@/lib/data/filings";

/**
 * ADAPTER — stock "Filings & Concalls" tab (design 3c, step P1.5).
 *
 * Maps the two previously-dead reads in `src/lib/data/filings.ts`
 * (`getFilingsForSecurity` + `getFilingsCountForSecurity`) onto the frozen
 * `FilingsConcalls` contract. Law #1: the contract is never edited to fit the
 * DB — sections the DB cannot serve return EMPTY, and the page renders the
 * honest empty state (Law #2). Nothing here is sample-fed: serving Aramco's
 * announcements on another company's page would be fabrication, so this adapter
 * deliberately does NOT use `withSampleFallback` (see the helper's own docblock:
 * the fallback is for a transient read failure on a live producer, never for a
 * per-entity surface where the sample belongs to a different entity).
 *
 * Measured against the live DB on 2026-07-26:
 *
 * | contract section  | source                                   | state           |
 * |-------------------|------------------------------------------|-----------------|
 * | `announcements`   | `public.filings` (14,632 rows / 658 secs) | REAL            |
 * | `earningsCalls`   | `public.transcripts`                     | 0 rows → empty  |
 * | `reports`         | no producer (no doc-class column)        | none  → empty   |
 * | `nextEvents`      | no trustworthy producer                  | none  → empty   |
 * | `relatedResearch` | `content_items` (1 row, not sec-linked)  | P3    → empty   |
 * | `phraseAlerts`    | member feature, no store                 | P6    → empty   |
 *
 * Two live data-quality facts this adapter degrades around, rather than hiding:
 *
 * 1. **Only 374 of 14,632 filings carry `ai_summary`** (TDWL 0/7,120, QE 0/2,118,
 *    BHB 0/425; MSX 195, ADX 120, DFM 59). `summary` is therefore `""` when the
 *    row has none — the AI-summary line is omitted, never placeholdered.
 * 2. **TDWL `filed_at` is the ingest stamp, not the filing date**, and the TDWL
 *    `title` is the raw source ref (`TDWL-XBRL-353_1120_2022-05-10_16-54-02_Eng`).
 *    All 38 Al Rajhi filings share a `filed_at` inside one 90-second batch on
 *    2026-07-15. The ref itself carries the real publication timestamp, so it is
 *    parsed out (strict regex, no inference) and used for both the displayed date
 *    and the ordering; the machine ref is then replaced by a readable type label.
 *    Rows whose ref carries no timestamp keep `filed_at` unchanged.
 *    → DEF-TDWL-FILED-AT (report), same family as DEF-EARNINGS-REPORTDATE.
 */

// ── Type vocabulary ──────────────────────────────────────────────────────────
// The live `filing_type` set (whole corpus): RESULTS 14,098 · OTHER 307 ·
// GOVERNANCE 143 · OPS 61 · CAPEX 11 · DIVIDEND 6 · CONTRACT 3 · RATING 3.
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

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Feed date, matching the design's compact stamp: `10 MAY 22`. */
function fmtFeedDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

/** Long date used inside a derived title: `10 May 2022`. */
function fmtTitleDate(iso: string | null): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  const m = MONTHS[d.getUTCMonth()];
  return `${d.getUTCDate()} ${m[0]}${m.slice(1).toLowerCase()} ${d.getUTCFullYear()}`;
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

function typeLabel(filingType: string | null): string {
  const t = (filingType ?? "").trim().toUpperCase();
  return TYPE_LABEL[t] ?? "Exchange filing";
}

function collapse(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

interface Prepared {
  filing: FilingItem;
  /** The filing's real date: parsed from the ref when present, else `filed_at`. */
  effectiveAt: string | null;
}

function prepare(f: FilingItem): Prepared {
  return { filing: f, effectiveAt: parseRefTimestamp(f.title) ?? f.filedAt };
}

function toAnnouncement(p: Prepared): Announcement {
  const { filing: f, effectiveAt } = p;
  const raw = collapse(f.title);
  const title = !raw || isMachineRef(raw) ? `${typeLabel(f.filingType)} — ${fmtTitleDate(effectiveAt)}` : raw;

  return {
    // Stable key + link target. Filing titles repeat heavily across the corpus
    // (872 duplicate (security,title) groups), so the id is the only safe key,
    // and it is also the parameter of the live /filings/[filingId] route.
    id: f.id,
    href: `/filings/${f.id}`,
    date: fmtFeedDate(effectiveAt),
    // The registry reference doubles as the filing's own id, which is the key of
    // the live `/filings/[filingId]` detail route.
    regId: `${(f.venueCode ?? "FILING").toUpperCase()} · #${f.id}`,
    tag: (f.filingType ?? "FILING").trim().toUpperCase() || "FILING",
    title,
    // Only 374 of 14,632 rows have one. No summary → no line, never a placeholder.
    summary: collapse(f.aiSummary),
  };
}

export interface StockFilingsResult {
  /** The view-model handed to `<StockFilingsConcalls />`. */
  filings: FilingsConcalls;
  /** Exact `public.filings` count for this security (`getFilingsCountForSecurity`). */
  totalFilings: number;
  /** How many of them this page is showing. */
  shownFilings: number;
  /** How many of the shown rows carried a real `ai_summary`. */
  withAiSummary: number;
}

/**
 * Build the 3c view-model for one security.
 *
 * `getFilingsForSecurity` orders by `filed_at desc`, which for TDWL is ingest
 * order (see the docblock). A wider window is fetched and re-ordered by the
 * effective date so the feed reads newest-first for every venue, then trimmed
 * to `limit`.
 */
export async function getStockFilingsConcalls(
  securityId: number,
  limit = 24,
): Promise<StockFilingsResult> {
  const take = Math.min(Math.max(limit, 1), 100);
  const [rows, totalFilings] = await Promise.all([
    getFilingsForSecurity(securityId, Math.min(take * 3, 100)),
    getFilingsCountForSecurity(securityId),
  ]);

  // Feed label + alert scope are per-entity (the component used to hardcode
  // "TADAWUL FEED · 2222 ONLY"). Both come off the rows themselves.
  const first = rows[0];
  const venueLabel = (first?.venueCode ?? "").toUpperCase();
  const ticker = (first?.ticker ?? "").toUpperCase();

  const ordered = rows
    .map(prepare)
    .sort((a, b) => (b.effectiveAt ?? "").localeCompare(a.effectiveAt ?? ""))
    .slice(0, take);

  // `StockFilingsConcalls` keys announcement rows on `title`, and real filing
  // titles repeat heavily (872 duplicate (security, title) groups covering 2,503
  // rows live — "BOD meeting", "Daily Net Asset Value / NAV", every derived TDWL
  // label). Disambiguate with the filing's own id so React keys stay unique.
  // TODO(P1.3-owner): the component should key on a filing id and link the row
  // to `/filings/{id}`; the contract has no id/href field yet.
  const seen = new Set<string>();
  const announcements = ordered.map((p) => {
    const a = toAnnouncement(p);
    if (seen.has(a.title)) a.title = `${a.title} · #${p.filing.id}`;
    seen.add(a.title);
    return a;
  });

  const filings: FilingsConcalls = {
    announcements,
    // `public.transcripts` = 0 rows, `transcript_segments` = 0 (verified as anon
    // 2026-07-26). Producer-pending → P7.6. Honest empty state, never sample.
    earningsCalls: [],
    // No document-class producer: `filings` has no annual-report/prospectus
    // classification, only `filing_type` (8 values, none of them a report class).
    reports: [],
    // Member feature with no store — P6 (`alerts` = 0 rows, no auth boundary yet).
    phraseAlerts: {
      active: [],
      suggestions: [],
      note: "PHRASE ALERTS ARRIVE WITH MARSAD MEMBER ACCOUNTS",
    },
    // No trustworthy forward-calendar source for one security: `earnings_events.report_date`
    // is a uniform ingest stamp (DEF-EARNINGS-REPORTDATE) and all 1,229 `dividends`
    // rows sit at `pending_confirm` with a NULL `ex_date` (0 anon-visible).
    nextEvents: [],
    // `content_items` has 1 published row and no security binding — P3 seeds the
    // editorial corpus; this lights up then.
    relatedResearch: [],
    feedLabel: venueLabel ? `${venueLabel} FEED · ${ticker} ONLY` : "",
    alertScope: ticker,
  };

  return {
    filings,
    totalFilings,
    shownFilings: announcements.length,
    withAiSummary: announcements.filter((a) => a.summary.length > 0).length,
  };
}

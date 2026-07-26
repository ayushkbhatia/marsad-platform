import "server-only";
import type { CalendarDay, EarningsRow, Kpi } from "@/lib/contracts/calendars";
import {
  getEarningsAhead,
  getEarningsCalendar,
  getEarningsKpis,
  type EarningsEventItem,
} from "@/lib/data/calendars";
import { fmtDate, fmtInt, fmtPrice } from "@/lib/reader/format";

/**
 * ADAPTER: `public.earnings_events` → the earnings-calendar view-model (design
 * 8a). Build-plan step **P2.3**. Re-wires three reads that already existed and
 * had no caller: `getEarningsCalendar`, `getEarningsAhead`, `getEarningsKpis`.
 *
 * MEASURED GROUND TRUTH (live DB `yjsncnpbjuueaoeejrqj`, 2026-07-26):
 *
 *   rows 9,180 · eps_actual 8,631 · eps_prior 5,898 · revenue_actual 7,986
 *   eps_consensus 0 · eps_marsad 0 · verdict 0 · surprise_pct 0
 *   next_session_reaction_pct 0 · session 0
 *   report_date min 2013-09-30 max 2026-07-21 (228 distinct)
 *
 * WHAT IS REAL: the security identity, `fiscal_period`, `eps_actual` and
 * `eps_prior`. Those — and only those — are rendered as numbers.
 *
 * WHAT IS NOT, AND WHY (Law #1/#2, `docs/BRIDGE-BUILD-PLAN.md` §0.1):
 *
 * - **Street consensus / MARSAD desk estimate.** `eps_consensus` and
 *   `eps_marsad` are NULL on all 9,180 rows and `public.estimates` has 0 rows —
 *   there is no consensus producer at all (DEF-ESTIMATES-AGG, plan step P7.3).
 *   The two columns the design leads on therefore render `—` on every row, and
 *   the surface carries a visible note saying so. They are NOT sample-filled:
 *   the sample's numbers (`SAMPLE_EARNINGS`) are invented, and an invented
 *   consensus next to a real actual is a fabricated beat/miss.
 * - **BEAT/MISS verdict, surprise %, next-session reaction.** All three columns
 *   are 100% NULL, so the design's "already reported" scorecard cannot be
 *   scored. The right rail lists the latest real prints (period + actual EPS)
 *   with no surprise or price-reaction figure.
 * - **PRE/POST session chip.** `session` is NULL on all 9,180 rows, so the
 *   column is dropped rather than guessed.
 * - **The day grouping is an INGEST STAMP, not a reporting calendar**
 *   (DEF-EARNINGS-REPORTDATE). Proof: `report_date = 2026-07-16` carries 1,051
 *   rows and `2026-07-19` carries prints for `Q2 2022` and `Q1 2021`. So the
 *   day bars are labelled "RECORDED <date>" — never "Monday, reporting" — and
 *   the note says the date is when Marsad recorded the print. There is also no
 *   forward calendar: 0 rows carry a `report_date` in the future.
 * - **The confirmed/estimate chip** (`date_state`: 2,170 confirmed / 7,010
 *   estimated) describes a `report_date` that is itself an ingest stamp, so a
 *   green "● CONF" would assert a company-confirmed reporting date that does not
 *   exist. Dropped to one honest surface-level state instead of a per-row chip.
 *
 * CONTRACT NOTE: `EarningsRow` in `src/lib/contracts/calendars.ts` cannot carry
 * this shape today (it has no `actual`, `period` or `eventId`, and types
 * `session`/`confirmed` as non-nullable). That file is owned elsewhere this
 * session, so the row type below is built as `Omit<EarningsRow, …>` + the extra
 * fields — a contract EXTENSION, never an edit-to-fit-the-DB. The exact fields
 * requested are listed in the P2.3 hand-back.
 */

const DASH = "—";

/** EPS values here span 0.0020 → 2.6978, so keep up to 4 decimals. */
function eps(n: number | null): string {
  return n == null ? DASH : fmtPrice(n, 4);
}

/**
 * A ledger row. Everything inherited from `EarningsRow` keeps the contract's
 * meaning; `consensus` and `marsad` are inherited precisely so the two unbacked
 * columns stay visible as `—` rather than quietly disappearing.
 */
export interface EarningsLedgerRow extends Omit<EarningsRow, "session" | "confirmed"> {
  /** `/earnings/[eventId]` — the live detail route. */
  eventId: number;
  /** `fiscal_period`, e.g. "Q2 2026". Real. */
  period: string;
  /** `eps_actual`. Real where present (8,631 of 9,180). */
  actual: string;
}

export interface RecentPrint {
  eventId: number;
  ticker: string;
  company: string;
  period: string;
  /** "0.0080" or "—". */
  actual: string;
  /** "prior 0.0060" or "" when `eps_prior` is NULL. */
  prior: string;
  /** "RECORDED 21 JUL 2026". */
  recordedOn: string;
}

export interface EarningsLedgerView {
  title: string;
  subtitle: string;
  ledgerLabel: string;
  footnote: string;
  /** The visible honesty note rendered above the ledger. */
  dataNote: string;
  /** The one surface-level state that replaced the per-row CONF/EST chip. */
  stateNote: string;
  kpis: Kpi[];
  days: CalendarDay<EarningsLedgerRow>[];
  recent: RecentPrint[];
  /** Forward-dated events. Empty today — 0 rows have a future `report_date`. */
  ahead: EarningsLedgerRow[];
  aheadNote: string;
}

function toLedgerRow(e: EarningsEventItem): EarningsLedgerRow {
  return {
    eventId: e.id,
    ticker: e.ticker,
    company: e.name,
    venue: (e.venueCode ?? "").toUpperCase(),
    venueCode: e.venueCode,
    period: e.fiscalPeriod,
    // Unbacked upstream — see the file header. Never a number.
    consensus: DASH,
    marsad: DASH,
    prior: eps(e.epsPrior),
    actual: eps(e.epsActual),
  };
}

function recordedLabel(iso: string): string {
  return `RECORDED ${fmtDate(iso).toUpperCase()}`;
}

/**
 * Build the earnings surface. Returns `null` when the read yields no rows —
 * the page then renders `EmptyState awaitingFeed`. There is deliberately NO
 * `withSampleFallback` here: the sample's consensus/MARSAD/surprise figures are
 * invented, so falling back to it would print fabricated estimates beside real
 * tickers (`adapters/fallback.ts`, "not a licence to fabricate").
 *
 * `todayISO` / `weekAheadISO` are read from the clock by the CALLER behind
 * `connection()` — the underlying reads are `use cache` and must stay
 * deterministic (`docs/frontend/CONVENTIONS.md` §3).
 */
export async function getEarningsLedger({
  todayISO,
  weekAheadISO,
  limit = 60,
}: {
  todayISO: string;
  weekAheadISO: string;
  limit?: number;
}): Promise<EarningsLedgerView | null> {
  const [page, kpiCounts, ahead] = await Promise.all([
    getEarningsCalendar({ limit }),
    getEarningsKpis({ todayISO, weekAheadISO }),
    getEarningsAhead({ todayISO, limit: 8 }),
  ]);

  if (page.days.length === 0) return null;

  const days: CalendarDay<EarningsLedgerRow>[] = page.days.map((d) => ({
    label: recordedLabel(d.date),
    count: `${fmtInt(d.count)} print${d.count === 1 ? "" : "s"}`,
    rows: d.rows.map(toLedgerRow),
  }));

  const recent: RecentPrint[] = page.days
    .flatMap((d) => d.rows)
    .filter((r) => r.epsActual != null)
    .slice(0, 6)
    .map((r) => ({
      eventId: r.id,
      ticker: r.ticker,
      company: r.name,
      period: r.fiscalPeriod,
      actual: eps(r.epsActual),
      prior: r.epsPrior != null ? `prior ${eps(r.epsPrior)}` : "",
      recordedOn: recordedLabel(r.reportDate),
    }));

  // `date_state` is NOT NULL on every row, so the two counts sum to the table.
  const onFile = kpiCounts.confirmedDates + kpiCounts.estimatedDates;

  const kpis: Kpi[] = [
    { label: "Prints on file", value: fmtInt(onFile) },
    { label: "Forward-dated · next 7 days", value: fmtInt(kpiCounts.aheadThisWeek) },
    { label: "Street consensus", value: DASH },
    { label: "Marsad desk estimate", value: DASH },
  ];

  const newest = page.days[0]?.date;

  return {
    title: "Earnings calendar",
    subtitle: "GCC earnings prints on file — reported EPS from company filings",
    ledgerLabel: `LATEST RECORDED PRINTS${newest ? ` · TO ${fmtDate(newest).toUpperCase()}` : ""}`,
    footnote: "EPS IN LOCAL CURRENCY · CONS. AND MARSAD NOT YET PUBLISHED",
    dataNote:
      "Street consensus and the Marsad desk estimate are not published yet — there is no estimates producer, " +
      "so those two columns read “—” on every row. Nothing in them is a placeholder for a number we hold.",
    stateNote:
      "Day headings are the date Marsad recorded the print, not the company’s reporting date — the stored " +
      "report date is an ingest stamp, so this is a record of results already filed, not a forward schedule.",
    kpis,
    days,
    recent,
    ahead: ahead.map(toLedgerRow),
    aheadNote:
      kpiCounts.aheadThisWeek === 0 && ahead.length === 0
        ? "No forward-dated events are on file. This list fills itself in as soon as a scheduling producer lands."
        : "",
  };
}

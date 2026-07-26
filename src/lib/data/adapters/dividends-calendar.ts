import type {
  CalendarDay,
  DividendRow,
  DividendType,
  DividendWeek,
  Kpi,
  YieldLeader,
} from "@/lib/contracts/calendars";
import type { DividendCalendarPage, DividendItem, DividendKpis } from "@/lib/data/calendars";

/**
 * Dividend calendar adapter (design 23a) — the real `public.dividends` reads →
 * the `DividendWeek` contract.
 *
 * WHY IT SHIPS BEFORE ITS PRODUCER (BRIDGE-BUILD-PLAN P2.4). Measured against
 * the live DB on 2026-07-26:
 *
 *   dividends total .................. 1,229
 *   with ex_date ..................... 0
 *   state = 'live' ................... 0   (all 1,229 sit at 'pending_confirm')
 *   visible to `anon` ................ 0   (world_read RLS filters on state)
 *
 * So the ex-date ledger has literally nothing to show. Per Law #2 the page must
 * NOT dress the sample week (Aramco/Salik/QNBK/Najm) up as real declarations —
 * it renders `EmptyState variant="awaitingFeed"` instead, and this adapter
 * returns `null` to signal that. Deliberately NOT wrapped in
 * `withSampleFallback`: a known-empty producer is the exact case that helper
 * must never cover (see `adapters/fallback.ts`). The mapping is written, typed
 * and fixture-tested now (`__tests__/dividends-calendar.test.ts`) so the
 * calendar lights up with no further front-end change the moment the
 * confirmation producer lands (P7.1 / DEF-DIVIDENDS-CONFIRM).
 *
 * NO RUNTIME IMPORTS BY DESIGN. Both imports above are type-only (erased at
 * build time), so this module is a pure function of its arguments: no Supabase
 * client, no `server-only`, no `@/` runtime resolution. That is what lets the
 * fixture test prove the wiring without a producer and without a bundler.
 * Contract fields are pre-formatted strings, so all formatting lives here.
 *
 * UNIT NOTES (verified against the DDL + `supabase/seed.sql`, not assumed —
 * this is the P4.2 fraction-vs-percent trap):
 * - `yield_at_announce` is a FRACTION: the seed row carries 0.0520 for a 5.2%
 *   yield. Displayed as `(n * 100).toFixed(1)%`.
 * - `payout_ratio` is a FRACTION: seed 0.7100 = 71% payout; the live median is
 *   1.1704 = 117%. The design's ">100% = cut risk" flag is therefore `> 1`.
 * - `DividendKpis.medianYieldPct` is named "...Pct" but carries the raw column
 *   value, i.e. a fraction. Converted here. (Naming gap reported to the lead —
 *   `data/calendars.ts` is another slice's file.)
 */

/** The one placeholder used for a value the producer has not supplied. */
const DASH = "—";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const DIVIDEND_TYPES: readonly string[] = ["FINAL", "INTERIM", "SPECIAL"];

/**
 * Split a `YYYY-MM-DD` date string arithmetically. A local `new Date(iso)`
 * would re-interpret the calendar date in the server's zone and can shift an
 * ex-date back a day (the postgres.js Date trap, applied to formatting).
 */
function ymd(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y: Number(m[1]), m: month, d: day };
}

/** `2026-07-12` → `SUN 12 JUL` (day-group header). UTC-only arithmetic. */
function dayLabel(iso: string | null | undefined): string {
  const p = ymd(iso);
  if (!p) return DASH;
  const dow = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${dow} ${p.d} ${MONTHS[p.m - 1]}`;
}

/** `2026-07-25` → `25 JUL` (pay-date cell). */
function shortDate(iso: string | null | undefined): string {
  const p = ymd(iso);
  if (!p) return DASH;
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** `2026-07-12` → `12 JUL 2026` (ledger header). */
function longDate(iso: string | null | undefined): string {
  const p = ymd(iso);
  if (!p) return DASH;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/**
 * DPS carries up to 6 decimals in the column but reads as money: 2 decimals
 * minimum, trailing noise beyond 4 dropped. `0.2043` → `0.2043`, `0.021` →
 * `0.021`, `1.25` → `1.25`.
 */
function formatDps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const fixed = n.toFixed(4);
  const trimmed = fixed.replace(/(\.\d{2}\d*?)0+$/, "$1");
  return trimmed;
}

/** Fraction → display percent. `0.052` → `5.2%`. */
function fractionPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * `div_type` is constrained by a DB CHECK to FINAL/INTERIM/SPECIAL, so the
 * fallback is unreachable in practice — this is a type guard, not a default.
 */
function dividendType(raw: string): DividendType {
  return (DIVIDEND_TYPES.includes(raw) ? raw : "FINAL") as DividendType;
}

function dps(item: DividendItem): string {
  const value = formatDps(item.dps);
  if (value === DASH) return DASH;
  return item.currency ? `${item.currency} ${value}` : value;
}

function toDividendRow(item: DividendItem): DividendRow {
  return {
    ticker: item.ticker,
    company: item.name,
    // `venue` is the chip next to the company name; the venue CODE is what the
    // six venues are labelled by across the reader, and `venueCode` is what the
    // row href is built from — keep them the same string rather than inventing
    // a long-form name the rest of the calendar doesn't use.
    venue: item.venueCode,
    venueCode: item.venueCode,
    type: dividendType(item.divType),
    dps: dps(item),
    yield: fractionPct(item.yieldAtAnnounce),
    payDate: shortDate(item.payDate),
    // Per-user alerts are auth-gated and `public.alerts` is 0 rows (P6). Never
    // claimed as set for an anonymous reader.
    alertSet: false,
  };
}

/** `3 EX-DATES · 1 SPECIAL` — a count, never a cross-currency payout total. */
function dayCount(rows: DividendItem[]): string {
  const base = `${rows.length} EX-DATE${rows.length === 1 ? "" : "S"}`;
  const specials = rows.filter((r) => r.divType === "SPECIAL").length;
  return specials > 0 ? `${base} · ${specials} SPECIAL${specials === 1 ? "" : "S"}` : base;
}

function toDays(page: DividendCalendarPage): CalendarDay<DividendRow>[] {
  return page.days.map((day) => ({
    label: dayLabel(day.date),
    count: dayCount(day.rows),
    rows: day.rows.map(toDividendRow),
  }));
}

function toKpis(kpis: DividendKpis): Kpi[] {
  return [
    { label: "GOING EX THIS WEEK", value: String(kpis.goingExThisWeek) },
    // A COUNT, not a currency sum: the rows span six currencies and there is no
    // FX table on this path, so the design's single "SAR 41.2B" figure cannot
    // be produced honestly (see `getDividendKpis`).
    { label: "PAYOUTS SETTLING THIS WEEK", value: String(kpis.payoutsThisWeek) },
    { label: "MEDIAN YIELD · GCC", value: fractionPct(kpis.medianYieldPct) },
    { label: "SPECIALS", value: String(kpis.specials) },
  ];
}

function toYieldLeader(item: DividendItem): YieldLeader {
  const payout = item.payoutRatio;
  const hasPayout = payout != null && Number.isFinite(payout);
  const leader: YieldLeader = {
    ticker: item.ticker,
    company: item.name,
    yield: fractionPct(item.yieldAtAnnounce),
    payout: hasPayout ? `PAYOUT ${(payout * 100).toFixed(0)}%` : "PAYOUT —",
  };
  // >100% of earnings distributed — the design's cut-risk flag. `payout_ratio`
  // is a fraction, so the threshold is 1, not 100.
  return hasPayout && payout > 1 ? { ...leader, payoutRisk: true } : leader;
}

const NO_UPCOMING = {
  kicker: "NEXT EX-DATE",
  headline: "No confirmed ex-date ahead",
  body:
    "No dividend on file carries a confirmed ex-date yet. This card fills in as soon as the " +
    "confirmation producer publishes dated declarations.",
};

/** The next ex-date and who trades on it — built from the forward read. */
function toGoesExNext(ahead: DividendItem[]): DividendWeek["goesExTomorrow"] {
  const first = ahead.find((d) => d.exDate);
  if (!first) return NO_UPCOMING;

  const sameDay = ahead.filter((d) => d.exDate === first.exDate);
  const others = sameDay.filter((d) => d.id !== first.id);
  const when = shortDate(first.exDate);
  const amount = dps(first);

  const body =
    others.length > 0
      ? `${sameDay.map((d) => d.ticker).join(", ")} all trade ex on ${when}.`
      : `${first.ticker} is the only name trading ex on ${when}.`;

  return {
    kicker: `NEXT EX-DATE · ${when}`,
    headline:
      amount === DASH
        ? `${first.name} trades ex on ${when}`
        : `Own ${first.name} before the ${when} open to collect ${amount}`,
    body,
  };
}

/** Product chrome, not data — a CTA card with no numbers in it. */
const REMINDERS = {
  kicker: "EX-DATE REMINDERS",
  headline: "Two days' warning, every time",
  body: "Push + email before any watchlist name goes ex-dividend.",
  cta: "Create dividend alert →",
};

const YIELD_LEADERS_NOTE = "PAYOUT > 100% FLAGGED — DISTRIBUTION EXCEEDS EARNINGS; CUT RISK.";

const FOOTNOTE = "OWN BEFORE THE EX-DATE OPEN TO RECEIVE · DPS IN LOCAL CCY";

/**
 * The ledger header. The read is a rolling keyset page ordered newest-ex-date
 * first, NOT a calendar week, so the label states the range it actually covers
 * instead of claiming a week window the query never asked for.
 */
function ledgerLabel(page: DividendCalendarPage): string {
  const dates = page.days.map((d) => d.date).filter(Boolean);
  if (dates.length === 0) return "BY EX-DATE";
  const newest = longDate(dates[0]);
  const oldest = longDate(dates[dates.length - 1]);
  return newest === oldest ? `EX-DATES · ${newest}` : `EX-DATES ${oldest} – ${newest} · NEWEST FIRST`;
}

export interface DividendCalendarInput {
  /** `getDividendCalendar()` — the ex-date day ledger. */
  calendar: DividendCalendarPage;
  /** `getDividendsAhead({ todayISO })` — forward ex-dates for the rail card. */
  ahead: DividendItem[];
  /** `getDividendYieldLeaders()` — highest `yield_at_announce`. */
  yieldLeaders: DividendItem[];
  /** `getDividendKpis({ todayISO, weekAheadISO })` — the KPI strip. */
  kpis: DividendKpis;
}

/**
 * Map the four dividend reads onto the `DividendWeek` view-model contract.
 *
 * Returns `null` when there is genuinely nothing to render — no ex-dated rows
 * in the ledger AND no yield leaders. That `null` is the route's signal to
 * render `EmptyState variant="awaitingFeed"`, which is what `/dividends`
 * resolves to today (0 anon-visible rows). A partially-populated read still
 * renders: missing pieces degrade to `—` rather than blanking sections that do
 * have rows.
 */
export function toDividendWeek(input: DividendCalendarInput): DividendWeek | null {
  const { calendar, ahead, yieldLeaders, kpis } = input;

  const hasLedgerRows = calendar.days.some((d) => d.rows.length > 0);
  if (!hasLedgerRows && yieldLeaders.length === 0) return null;

  return {
    weekLabel: ledgerLabel(calendar),
    footnote: FOOTNOTE,
    kpis: toKpis(kpis),
    days: toDays(calendar).filter((d) => d.rows.length > 0),
    goesExTomorrow: toGoesExNext(ahead),
    yieldLeaders: yieldLeaders.map(toYieldLeader),
    yieldLeadersNote: YIELD_LEADERS_NOTE,
    reminders: REMINDERS,
  };
}

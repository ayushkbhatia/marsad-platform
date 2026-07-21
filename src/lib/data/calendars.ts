import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

/**
 * Public calendars reads (anon-RLS `earnings_events`, `dividends`, `ipo_offers`
 * + `securities` for identity). Every export is a `use cache` fn — see
 * `docs/frontend/CONVENTIONS.md` §2. Slice-owned; nobody else edits this file.
 *
 * IMPORTANT data-reality notes (verified live against the DB before writing this
 * file — not guessed from the design screens):
 *
 * - `earnings_events` (4190 rows) is entirely HISTORICAL: min report_date
 *   2013-09-30, max 2026-07-19, **zero rows with report_date in the future**.
 *   `eps_consensus` / `eps_marsad` / `revenue_consensus` / `verdict` /
 *   `surprise_pct` / `next_session_reaction_pct` / `rvc_table` /
 *   `segment_breakdown` / `desk_take` / `house_rank` are **NULL on every row
 *   today** (no estimates/desk producer yet). Only `eps_actual` (3802/4190),
 *   `eps_prior` (1958/4190), `revenue_actual` (4014/4190), `date_state` and
 *   `results_filing_id` (1808/4190) are populated. The calendar renders "—"
 *   for the unfilled columns rather than fabricating a consensus/verdict.
 *
 * - `dividends` (1147 rows) has a `world_read` RLS policy gated on
 *   `state = 'live'` — every row today is `state = 'pending_confirm'`, so the
 *   anon client sees **zero rows** regardless of query shape. On top of that,
 *   `ex_date` / `record_date` / `pay_date` / `yield_at_announce` are NULL on
 *   ALL 1147 rows (only `dps`, `div_type`, `currency`, `payout_ratio` (746/1147)
 *   and `amount_total`/`period_end` are populated). The dividend calendar is
 *   therefore correctly built but will render fully empty (`EmptyState
 *   awaitingFeed`) until a confirmation job flips rows to `state='live'` AND
 *   backfills `ex_date`. Flagged to the lead — this is a producer/RLS gap, not
 *   a front-end bug.
 *
 * - `ipo_offers` has 0 rows (confirmed empty tier, as briefed) and has no
 *   `currency` or `ticker`/`slug` column. `price_range_low/high`, `final_price`
 *   and `min_lot` are assumed venue-local currency (derived via `VENUE_CCY`
 *   below); `raise_amount`/`implied_mcap` are assumed USD-normalized (the
 *   design prefixes them with "$" while price ranges carry the local ccy code
 *   — e.g. "OMR 0.106–0.111" vs "≈ $660M" on the same screen). `stage` is free
 *   text with no live examples to confirm the vocabulary against, so
 *   `classifyIpoStage` is a best-effort keyword bucketer. Both assumptions are
 *   flagged to the lead for confirmation once the IPO producer lands.
 */

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

interface SecLite {
  id: number;
  ticker: string;
  venue_code: string;
  name_en: string;
  currency: string | null;
}

async function securityMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: Array<number | null | undefined>,
): Promise<Map<number, SecLite>> {
  const map = new Map<number, SecLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb
    .from("securities")
    .select("id,ticker,venue_code,name_en,currency")
    .in("id", unique);
  for (const s of (data as SecLite[] | null) ?? []) map.set(s.id, s);
  return map;
}

/** venue_code → local trading currency. `ipo_offers` carries no currency column
 * of its own (see file header note); this is the same 6-venue vocabulary as
 * `venueName()` in `src/lib/reader/format.ts`. */
const VENUE_CCY: Record<string, string> = {
  TDWL: "SAR",
  DFM: "AED",
  ADX: "AED",
  QE: "QAR",
  MSX: "OMR",
  BHB: "BHD",
  BK: "KWD",
};

/** Composite keyset cursor: "YYYY-MM-DD|id". A bare date column isn't a unique
 * sort key here (one report_date/ex_date can carry 1000+ rows), so pagination
 * must tie-break on `id` — a plain `.lt(dateCol, cursor)` would silently skip
 * every same-date row after the first page. */
function parseDayCursor(cursor: string | undefined): { date: string; id: number } | null {
  if (!cursor) return null;
  const [date, idStr] = cursor.split("|");
  const id = Number(idStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(id)) return null;
  return { date, id };
}

function groupByDate<T>(rows: T[], dateKey: (r: T) => string): Array<{ date: string; count: number; rows: T[] }> {
  const order: string[] = [];
  const byDate = new Map<string, T[]>();
  for (const r of rows) {
    const d = dateKey(r);
    if (!byDate.has(d)) {
      byDate.set(d, []);
      order.push(d);
    }
    byDate.get(d)!.push(r);
  }
  return order.map((d) => ({ date: d, count: byDate.get(d)!.length, rows: byDate.get(d)! }));
}

// ─────────────────────────────────────────────────────────────────────────
// EARNINGS
// ─────────────────────────────────────────────────────────────────────────

export interface EarningsEventItem {
  id: number;
  securityId: number;
  ticker: string;
  venueCode: string;
  name: string;
  currency: string | null;
  fiscalPeriod: string;
  reportDate: string;
  /** "confirmed" | "estimated" */
  dateState: string;
  /** PRE | POST — NULL on every row today (session producer pending). */
  session: string | null;
  epsConsensus: number | null;
  epsMarsad: number | null;
  epsPrior: number | null;
  epsActual: number | null;
  /** Derived (actual − prior) / |prior| × 100 — arithmetic on already-fetched
   * columns, not a new DB read. Null unless both eps_actual and eps_prior exist. */
  epsYoyPct: number | null;
  revenueConsensus: number | null;
  revenueActual: number | null;
  /** BEAT | MISS | INLINE — NULL on every row today. */
  verdict: string | null;
  surprisePct: number | null;
  nextSessionReactionPct: number | null;
  resultsFilingId: number | null;
}

const EARNINGS_COLS =
  "id,security_id,fiscal_period,report_date,date_state,session,eps_consensus,eps_marsad,eps_prior,eps_actual,revenue_consensus,revenue_actual,verdict,surprise_pct,next_session_reaction_pct,results_filing_id";

interface EarningsRow {
  id: number;
  security_id: number;
  fiscal_period: string;
  report_date: string;
  date_state: string;
  session: string | null;
  eps_consensus: unknown;
  eps_marsad: unknown;
  eps_prior: unknown;
  eps_actual: unknown;
  revenue_consensus: unknown;
  revenue_actual: unknown;
  verdict: string | null;
  surprise_pct: unknown;
  next_session_reaction_pct: unknown;
  results_filing_id: number | null;
}

function mapEarnings(r: EarningsRow, sec?: SecLite): EarningsEventItem {
  const epsPrior = toNum(r.eps_prior);
  const epsActual = toNum(r.eps_actual);
  const epsYoyPct =
    epsPrior != null && epsActual != null && epsPrior !== 0
      ? ((epsActual - epsPrior) / Math.abs(epsPrior)) * 100
      : null;
  return {
    id: r.id,
    securityId: r.security_id,
    ticker: sec?.ticker ?? "—",
    venueCode: sec?.venue_code ?? "",
    name: sec?.name_en ?? "—",
    currency: sec?.currency ?? null,
    fiscalPeriod: r.fiscal_period,
    reportDate: r.report_date,
    dateState: r.date_state,
    session: r.session,
    epsConsensus: toNum(r.eps_consensus),
    epsMarsad: toNum(r.eps_marsad),
    epsPrior,
    epsActual,
    epsYoyPct,
    revenueConsensus: toNum(r.revenue_consensus),
    revenueActual: toNum(r.revenue_actual),
    verdict: r.verdict,
    surprisePct: toNum(r.surprise_pct),
    nextSessionReactionPct: toNum(r.next_session_reaction_pct),
    resultsFilingId: r.results_filing_id,
  };
}

export interface EarningsDay {
  date: string;
  count: number;
  rows: EarningsEventItem[];
}

export interface EarningsCalendarPage {
  days: EarningsDay[];
  /** Pass back as `cursor` to page to older report dates. */
  nextCursor: string | null;
}

/**
 * Day-ledger of reported earnings, most-recent `report_date` first. Bounded by
 * a deterministic row LIMIT + composite keyset cursor — no wall-clock read.
 * ~5 min cache.
 */
export async function getEarningsCalendar({
  cursor,
  limit = 60,
}: { cursor?: string; limit?: number } = {}): Promise<EarningsCalendarPage> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 86400 });
  cacheTag("earnings");

  const sb = createAnonClient();
  const take = Math.min(Math.max(limit, 1), 200);
  let q = sb
    .from("earnings_events")
    .select(EARNINGS_COLS)
    .order("report_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(take);

  const c = parseDayCursor(cursor);
  if (c) q = q.or(`report_date.lt.${c.date},and(report_date.eq.${c.date},id.lt.${c.id})`);

  const { data } = await q;
  const rows = (data as EarningsRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  const items = rows.map((r) => mapEarnings(r, secs.get(r.security_id)));

  const days = groupByDate(items, (r) => r.reportDate);
  const last = items[items.length - 1];
  const nextCursor = items.length === take && last ? `${last.reportDate}|${last.id}` : null;

  return { days, nextCursor };
}

/**
 * Report dates from `todayISO` forward, ascending — `todayISO` is computed by a
 * dynamic (`connection()`-gated) caller, never read inside this cached fn (see
 * CONVENTIONS §3). Empty today (no future `report_date` rows exist yet); ready
 * for when a forward-scheduling producer lands.
 */
export async function getEarningsAhead({
  todayISO,
  limit = 12,
}: {
  todayISO: string;
  limit?: number;
}): Promise<EarningsEventItem[]> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 86400 });
  cacheTag("earnings");

  const sb = createAnonClient();
  const { data } = await sb
    .from("earnings_events")
    .select(EARNINGS_COLS)
    .gte("report_date", todayISO)
    .order("report_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));

  const rows = (data as EarningsRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  return rows.map((r) => mapEarnings(r, secs.get(r.security_id)));
}

export interface EarningsKpis {
  confirmedDates: number;
  estimatedDates: number;
  reportingToday: number;
  aheadThisWeek: number;
}

/** Cheap head-counts for the KPI strip. Date bounds are params from a dynamic caller. */
export async function getEarningsKpis({
  todayISO,
  weekAheadISO,
}: {
  todayISO: string;
  weekAheadISO: string;
}): Promise<EarningsKpis> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 86400 });
  cacheTag("earnings");

  const sb = createAnonClient();
  const [
    { count: confirmedDates },
    { count: estimatedDates },
    { count: reportingToday },
    { count: aheadThisWeek },
  ] = await Promise.all([
    sb.from("earnings_events").select("id", { count: "exact", head: true }).eq("date_state", "confirmed"),
    sb.from("earnings_events").select("id", { count: "exact", head: true }).eq("date_state", "estimated"),
    sb.from("earnings_events").select("id", { count: "exact", head: true }).eq("report_date", todayISO),
    sb
      .from("earnings_events")
      .select("id", { count: "exact", head: true })
      .gte("report_date", todayISO)
      .lte("report_date", weekAheadISO),
  ]);

  return {
    confirmedDates: confirmedDates ?? 0,
    estimatedDates: estimatedDates ?? 0,
    reportingToday: reportingToday ?? 0,
    aheadThisWeek: aheadThisWeek ?? 0,
  };
}

export interface EarningsEventDetail extends EarningsEventItem {
  /** Arbitrary jsonb (shape unverified — always NULL today). Render as data, never as code. */
  rvcTable: unknown;
  segmentBreakdown: unknown;
  deskTake: string | null;
  houseRank: number | null;
  /** Headline Marsad Score only (number + rating) — factor grades stay gated,
   * same pattern as `getStockOverview` in `data/stocks.ts`. */
  score: { score: number | null; rating: string | null } | null;
}

/** One earnings print's full record + security identity + the headline score. */
export async function getEarningsEvent(id: number): Promise<EarningsEventDetail | null> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 86400 });
  cacheTag("earnings");

  const sb = createAnonClient();
  const { data: row } = await sb
    .from("earnings_events")
    .select(`${EARNINGS_COLS},rvc_table,segment_breakdown,desk_take,house_rank`)
    .eq("id", id)
    .maybeSingle<
      EarningsRow & {
        rvc_table: unknown;
        segment_breakdown: unknown;
        desk_take: string | null;
        house_rank: unknown;
      }
    >();

  if (!row) return null;

  const [{ data: sec }, { data: scoreRow }] = await Promise.all([
    sb.from("securities").select("id,ticker,venue_code,name_en,currency").eq("id", row.security_id).maybeSingle<SecLite>(),
    sb
      .from("v_scores_public")
      .select("security_id,score,rating")
      .eq("security_id", row.security_id)
      .maybeSingle<{ security_id: number; score: number | null; rating: string | null }>(),
  ]);

  return {
    ...mapEarnings(row, sec ?? undefined),
    rvcTable: row.rvc_table ?? null,
    segmentBreakdown: row.segment_breakdown ?? null,
    deskTake: row.desk_take ?? null,
    houseRank: toInt(row.house_rank),
    score: scoreRow ? { score: toInt(scoreRow.score), rating: scoreRow.rating ?? null } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DIVIDENDS
// ─────────────────────────────────────────────────────────────────────────

export interface DividendItem {
  id: number;
  securityId: number;
  ticker: string;
  venueCode: string;
  name: string;
  currency: string;
  /** FINAL | INTERIM | SPECIAL (free text; SPECIAL has no live example yet). */
  divType: string;
  fiscalRef: string | null;
  dps: number | null;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  yieldAtAnnounce: number | null;
  payoutRatio: number | null;
  amountTotal: number | null;
  periodEnd: string | null;
}

const DIVIDEND_COLS =
  "id,security_id,div_type,fiscal_ref,dps,currency,ex_date,record_date,pay_date,yield_at_announce,payout_ratio,amount_total,period_end";

interface DividendRow {
  id: number;
  security_id: number;
  div_type: string;
  fiscal_ref: string | null;
  dps: unknown;
  currency: string;
  ex_date: string | null;
  record_date: string | null;
  pay_date: string | null;
  yield_at_announce: unknown;
  payout_ratio: unknown;
  amount_total: unknown;
  period_end: string | null;
}

function mapDividend(r: DividendRow, sec?: SecLite): DividendItem {
  return {
    id: r.id,
    securityId: r.security_id,
    ticker: sec?.ticker ?? "—",
    venueCode: sec?.venue_code ?? "",
    name: sec?.name_en ?? "—",
    currency: (r.currency ?? "").trim(),
    divType: (r.div_type ?? "").trim().toUpperCase(),
    fiscalRef: r.fiscal_ref,
    dps: toNum(r.dps),
    exDate: r.ex_date,
    recordDate: r.record_date,
    payDate: r.pay_date,
    yieldAtAnnounce: toNum(r.yield_at_announce),
    payoutRatio: toNum(r.payout_ratio),
    amountTotal: toNum(r.amount_total),
    periodEnd: r.period_end,
  };
}

export interface DividendDay {
  date: string;
  count: number;
  rows: DividendItem[];
}

export interface DividendCalendarPage {
  days: DividendDay[];
  nextCursor: string | null;
}

/**
 * Day-ledger grouped by EX-DATE, most recent first. See the file header: anon
 * RLS only exposes `state='live'` rows (none today) and `ex_date` is NULL on
 * every live-eligible row today, so `.not("ex_date","is",null)` legitimately
 * returns empty until both land — the page renders `EmptyState awaitingFeed`.
 */
export async function getDividendCalendar({
  cursor,
  limit = 60,
}: { cursor?: string; limit?: number } = {}): Promise<DividendCalendarPage> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("dividends");

  const sb = createAnonClient();
  const take = Math.min(Math.max(limit, 1), 200);
  let q = sb
    .from("dividends")
    .select(DIVIDEND_COLS)
    .not("ex_date", "is", null)
    .order("ex_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(take);

  const c = parseDayCursor(cursor);
  if (c) q = q.or(`ex_date.lt.${c.date},and(ex_date.eq.${c.date},id.lt.${c.id})`);

  const { data } = await q;
  const rows = (data as DividendRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  const items = rows.map((r) => mapDividend(r, secs.get(r.security_id)));

  const days = groupByDate(items, (r) => r.exDate ?? "");
  const last = items[items.length - 1];
  const nextCursor = items.length === take && last?.exDate ? `${last.exDate}|${last.id}` : null;

  return { days, nextCursor };
}

/** Ex-dates from `todayISO` forward, ascending. Empty today (see file header). */
export async function getDividendsAhead({
  todayISO,
  limit = 12,
}: {
  todayISO: string;
  limit?: number;
}): Promise<DividendItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("dividends");

  const sb = createAnonClient();
  const { data } = await sb
    .from("dividends")
    .select(DIVIDEND_COLS)
    .gte("ex_date", todayISO)
    .order("ex_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));

  const rows = (data as DividendRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  return rows.map((r) => mapDividend(r, secs.get(r.security_id)));
}

/** Highest-yield names with a known `yield_at_announce`. Empty today (see file header). */
export async function getDividendYieldLeaders(limit = 6): Promise<DividendItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("dividends");

  const sb = createAnonClient();
  const { data } = await sb
    .from("dividends")
    .select(DIVIDEND_COLS)
    .not("yield_at_announce", "is", null)
    .order("yield_at_announce", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));

  const rows = (data as DividendRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  return rows.map((r) => mapDividend(r, secs.get(r.security_id)));
}

export interface DividendKpis {
  goingExThisWeek: number;
  /** Count of payouts settling in the window — NOT a $ sum: rows span 6+
   * currencies with no FX table here, so a cross-currency total would be
   * misleading (the design's single "SAR 41.2B" KPI doesn't generalize). */
  payoutsThisWeek: number;
  specials: number;
  medianYieldPct: number | null;
}

/** Date bounds are params from a dynamic caller — this fn stays deterministic. */
export async function getDividendKpis({
  todayISO,
  weekAheadISO,
}: {
  todayISO: string;
  weekAheadISO: string;
}): Promise<DividendKpis> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("dividends");

  const sb = createAnonClient();
  const [{ count: goingExThisWeek }, { count: payoutsThisWeek }, { count: specials }, { data: yields }] =
    await Promise.all([
      sb
        .from("dividends")
        .select("id", { count: "exact", head: true })
        .gte("ex_date", todayISO)
        .lte("ex_date", weekAheadISO),
      sb
        .from("dividends")
        .select("id", { count: "exact", head: true })
        .gte("pay_date", todayISO)
        .lte("pay_date", weekAheadISO),
      sb.from("dividends").select("id", { count: "exact", head: true }).eq("div_type", "SPECIAL"),
      sb.from("dividends").select("yield_at_announce").not("yield_at_announce", "is", null).limit(2000),
    ]);

  const yieldVals = ((yields as Array<{ yield_at_announce: unknown }> | null) ?? [])
    .map((r) => toNum(r.yield_at_announce))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const mid = yieldVals.length ? Math.floor(yieldVals.length / 2) : 0;
  const medianYieldPct = yieldVals.length
    ? yieldVals.length % 2 === 1
      ? yieldVals[mid]
      : (yieldVals[mid - 1] + yieldVals[mid]) / 2
    : null;

  return {
    goingExThisWeek: goingExThisWeek ?? 0,
    payoutsThisWeek: payoutsThisWeek ?? 0,
    specials: specials ?? 0,
    medianYieldPct,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// IPO
// ─────────────────────────────────────────────────────────────────────────

export interface IpoOfferItem {
  id: number;
  securityId: number | null;
  companyName: string;
  ticker: string | null;
  venueCode: string;
  stage: string;
  /** Assumed venue-local currency — see file header note. */
  localCurrency: string;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  finalPrice: number | null;
  offerSizePct: number | null;
  sharesOffered: number | null;
  /** Assumed USD — see file header note. */
  raiseAmount: number | null;
  impliedMcap: number | null;
  impliedPe: number | null;
  impliedYield: number | null;
  retailTranchePct: number | null;
  minLot: number | null;
  dividendPolicy: string | null;
  useOfProceeds: unknown;
  brokers: unknown;
  refundsBy: string | null;
  retailOpenAt: string | null;
  retailCloseAt: string | null;
  expectedListing: string | null;
  objectState: string;
  prospectusFilingId: number | null;
}

const IPO_COLS =
  "id,security_id,company_name,venue_code,stage,price_range_low,price_range_high,final_price,offer_size_pct,shares_offered,raise_amount,implied_mcap,implied_pe,implied_yield,retail_tranche_pct,min_lot,dividend_policy,use_of_proceeds,brokers,refunds_by,retail_open_at,retail_close_at,expected_listing,object_state,prospectus_filing_id";

interface IpoRow {
  id: number;
  security_id: number | null;
  company_name: string;
  venue_code: string;
  stage: string;
  price_range_low: unknown;
  price_range_high: unknown;
  final_price: unknown;
  offer_size_pct: unknown;
  shares_offered: unknown;
  raise_amount: unknown;
  implied_mcap: unknown;
  implied_pe: unknown;
  implied_yield: unknown;
  retail_tranche_pct: unknown;
  min_lot: unknown;
  dividend_policy: string | null;
  use_of_proceeds: unknown;
  brokers: unknown;
  refunds_by: string | null;
  retail_open_at: string | null;
  retail_close_at: string | null;
  expected_listing: string | null;
  object_state: string;
  prospectus_filing_id: number | null;
}

function mapIpo(r: IpoRow, ticker: string | null): IpoOfferItem {
  return {
    id: r.id,
    securityId: r.security_id,
    companyName: r.company_name,
    ticker,
    venueCode: r.venue_code,
    stage: r.stage,
    localCurrency: VENUE_CCY[r.venue_code?.toUpperCase()] ?? "",
    priceRangeLow: toNum(r.price_range_low),
    priceRangeHigh: toNum(r.price_range_high),
    finalPrice: toNum(r.final_price),
    offerSizePct: toNum(r.offer_size_pct),
    sharesOffered: toNum(r.shares_offered),
    raiseAmount: toNum(r.raise_amount),
    impliedMcap: toNum(r.implied_mcap),
    impliedPe: toNum(r.implied_pe),
    impliedYield: toNum(r.implied_yield),
    retailTranchePct: toNum(r.retail_tranche_pct),
    minLot: toInt(r.min_lot),
    dividendPolicy: r.dividend_policy,
    useOfProceeds: r.use_of_proceeds ?? null,
    brokers: r.brokers ?? null,
    refundsBy: r.refunds_by,
    retailOpenAt: r.retail_open_at,
    retailCloseAt: r.retail_close_at,
    expectedListing: r.expected_listing,
    objectState: r.object_state,
    prospectusFilingId: r.prospectus_filing_id,
  };
}

export type IpoStageBucket = "subscription_open" | "bookbuilding" | "announced" | "listed" | "other";

/**
 * `stage` has no live examples to confirm against (0 rows) — this is a
 * best-effort keyword bucketer so the pipeline groups sensibly however the
 * producer names stages. Confirm the real vocabulary with the lead once
 * `ipo_offers` is seeded and adjust here (single call site for all 3 pages).
 */
export function classifyIpoStage(stage: string | null | undefined): IpoStageBucket {
  const s = (stage ?? "").toLowerCase();
  if (!s) return "other";
  if (s.includes("listed")) return "listed";
  if (s.includes("retail") || s.includes("subscri")) return "subscription_open";
  if (s.includes("book") || s.includes("institution")) return "bookbuilding";
  if (s.includes("announc") || s.includes("filed") || s.includes("draft") || s.includes("intention")) return "announced";
  return "other";
}

/** Full pipeline, most-recently-active first. 0 rows today (confirmed empty tier). */
export async function getIpoPipeline(limit = 100): Promise<IpoOfferItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("ipo");

  const sb = createAnonClient();
  const { data } = await sb
    .from("ipo_offers")
    .select(IPO_COLS)
    .order("retail_open_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));

  const rows = (data as IpoRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  return rows.map((r) => mapIpo(r, r.security_id ? secs.get(r.security_id)?.ticker ?? null : null));
}

/** Offers whose stage buckets to "listed", most recent first. 0 rows today. */
export async function getIpoJustListed(limit = 5): Promise<IpoOfferItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("ipo");

  const sb = createAnonClient();
  // Small table (0 rows today, low hundreds at scale) — filter the stage bucket
  // in JS since the vocabulary isn't fixed enough to push into SQL yet.
  const { data } = await sb
    .from("ipo_offers")
    .select(IPO_COLS)
    .order("expected_listing", { ascending: false, nullsFirst: false })
    .limit(200);

  const rows = ((data as IpoRow[] | null) ?? [])
    .filter((r) => classifyIpoStage(r.stage) === "listed")
    .slice(0, Math.min(Math.max(limit, 1), 50));
  const secs = await securityMap(sb, rows.map((r) => r.security_id));
  return rows.map((r) => mapIpo(r, r.security_id ? secs.get(r.security_id)?.ticker ?? null : null));
}

export interface IpoKpis {
  inPipeline: number;
  subscriptionOpen: number;
  listingThisMonth: number;
  /** Sum of `raise_amount` (assumed USD — see file header) for offers expected
   * to list within the given year-to-date window. */
  raisedYtd: number;
}

/** Date bounds are params from a dynamic caller — this fn stays deterministic. */
export async function getIpoKpis({
  todayISO,
  monthEndISO,
  yearStartISO,
}: {
  todayISO: string;
  monthEndISO: string;
  yearStartISO: string;
}): Promise<IpoKpis> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("ipo");

  const sb = createAnonClient();
  const [{ data: all }, { count: listingThisMonth }, { data: ytdRows }] = await Promise.all([
    sb.from("ipo_offers").select("id,stage"),
    sb
      .from("ipo_offers")
      .select("id", { count: "exact", head: true })
      .gte("expected_listing", todayISO)
      .lte("expected_listing", monthEndISO),
    sb.from("ipo_offers").select("raise_amount").gte("expected_listing", yearStartISO).lte("expected_listing", todayISO),
  ]);

  const allRows = (all as Array<{ id: number; stage: string }> | null) ?? [];
  const subscriptionOpen = allRows.filter((r) => classifyIpoStage(r.stage) === "subscription_open").length;
  const raisedYtd = ((ytdRows as Array<{ raise_amount: unknown }> | null) ?? []).reduce(
    (sum, r) => sum + (toNum(r.raise_amount) ?? 0),
    0,
  );

  return {
    inPipeline: allRows.length,
    subscriptionOpen,
    listingThisMonth: listingThisMonth ?? 0,
    raisedYtd,
  };
}

// ── Slug helpers (pure, no DB) ──────────────────────────────────────────
// `ipo_offers` has no `slug`/`ticker` column, so the URL slug is derived from
// `company_name` with the numeric id suffixed for uniqueness + O(1) lookup
// (`my-company-14`) — the id suffix is authoritative; the name prefix is
// cosmetic and re-derived from the row, so a stale/renamed prefix in an old
// link still resolves correctly.

export function slugifyCompanyName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "offer"
  );
}

export function ipoOfferSlug(offer: { id: number; companyName: string }): string {
  return `${slugifyCompanyName(offer.companyName)}-${offer.id}`;
}

function parseOfferId(slug: string): number | null {
  const m = /-(\d+)$/.exec((slug ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve an offer slug → full record. Returns null for an unknown/malformed
 * slug OR (today, always) because `ipo_offers` has 0 rows — the route renders
 * `EmptyState awaitingFeed` rather than a 404 for this pre-launch tier. */
export async function getIpoOffer(offerSlug: string): Promise<IpoOfferItem | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("ipo");

  const id = parseOfferId(offerSlug);
  if (id == null) return null;

  const sb = createAnonClient();
  const { data: row } = await sb.from("ipo_offers").select(IPO_COLS).eq("id", id).maybeSingle<IpoRow>();
  if (!row) return null;

  let ticker: string | null = null;
  if (row.security_id != null) {
    const { data: sec } = await sb
      .from("securities")
      .select("ticker")
      .eq("id", row.security_id)
      .maybeSingle<{ ticker: string }>();
    ticker = sec?.ticker ?? null;
  }
  return mapIpo(row, ticker);
}

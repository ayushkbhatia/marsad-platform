import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

/**
 * Per-security depth-tab reads: dividends, earnings events, ownership
 * (holders / ownership snapshots / board & management). Every export is a
 * `use cache` fn reading only anon-RLS tables, tagged `stock:{id}` so the
 * ingest/producer jobs that write these tables can `revalidateTag`.
 *
 * DATA-READINESS (verified live 2026-07-21, see report to lead):
 * - `dividends` has 1147 rows but EVERY row is `state = 'pending_confirm'`
 *   today — the RLS `world_read` policy on `public.dividends` only exposes
 *   `state = 'live'` rows to anon, so `getDividendsForSecurity` currently
 *   returns an EMPTY array for every security until the human-confirm gate
 *   (33b) promotes rows to `live`. The dividends tab is built to full depth
 *   and renders real rows the moment any go live — do not "fix" this by
 *   loosening the query; the gate is intentional (33b dividend go-live rule).
 * - `earnings_events` (4190 rows) is publicly readable (no state gate) and IS
 *   data-backed today — `eps_actual`/`eps_prior`/`revenue_actual` are
 *   populated for most rows; `eps_consensus`/`eps_marsad`/`verdict`/
 *   `surprise_pct`/`next_session_reaction_pct`/`desk_take`/`session` are 100%
 *   NULL across every row right now (no desk/consensus producer yet) — every
 *   formatter below degrades those to "—" rather than erroring.
 * - `holders`, `holder_positions`, `ownership_snapshots`, `company_people`
 *   are all 0 rows — the ownership bundle always resolves to empty arrays
 *   today; the page renders `EmptyState awaitingFeed` for each block.
 */

// ── Dividends ──────────────────────────────────────────────────────────────

export interface DividendItem {
  id: number;
  /** FINAL | INTERIM | SPECIAL */
  divType: string;
  fiscalRef: string | null;
  /** Dividend per share, in `currency`. Null when only the cash total is known (equity-projection rows). */
  dps: number | null;
  currency: string | null;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  yieldAtAnnounce: number | null;
  /** Flag when > 1 — distribution exceeds earnings (cut risk). */
  payoutRatio: number | null;
  /** registrar | disclosure */
  verification: string;
  /** pending_confirm | live | cancelled (anon RLS only ever returns 'live'). */
  state: string;
  amountTotal: number | null;
  periodEnd: string | null;
}

interface DividendRow {
  id: number;
  div_type: string;
  fiscal_ref: string | null;
  dps: unknown;
  currency: string | null;
  ex_date: string | null;
  record_date: string | null;
  pay_date: string | null;
  yield_at_announce: unknown;
  payout_ratio: unknown;
  verification: string;
  state: string;
  amount_total: unknown;
  period_end: string | null;
}

const DIVIDEND_COLS =
  "id,div_type,fiscal_ref,dps,currency,ex_date,record_date,pay_date,yield_at_announce,payout_ratio,verification,state,amount_total,period_end";

/** Dividend history for one security, newest-first by ex-date (falls back to period_end for equity-projection rows without an ex-date). */
export async function getDividendsForSecurity(
  securityId: number,
  limit = 80,
): Promise<DividendItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data } = await sb
    .from("dividends")
    .select(DIVIDEND_COLS)
    .eq("security_id", securityId)
    .order("ex_date", { ascending: false, nullsFirst: false })
    .order("period_end", { ascending: false, nullsFirst: false })
    .limit(limit);

  return ((data as DividendRow[] | null) ?? []).map((d) => ({
    id: d.id,
    divType: d.div_type,
    fiscalRef: d.fiscal_ref,
    dps: toNum(d.dps),
    currency: d.currency,
    exDate: d.ex_date,
    recordDate: d.record_date,
    payDate: d.pay_date,
    yieldAtAnnounce: toNum(d.yield_at_announce),
    payoutRatio: toNum(d.payout_ratio),
    verification: d.verification,
    state: d.state,
    amountTotal: toNum(d.amount_total),
    periodEnd: d.period_end,
  }));
}

// ── Earnings events ────────────────────────────────────────────────────────

export interface EarningsEventItem {
  id: number;
  fiscalPeriod: string;
  reportDate: string;
  /** confirmed | estimated */
  dateState: string;
  /** pre | post | null */
  session: string | null;
  epsConsensus: number | null;
  epsMarsad: number | null;
  epsPrior: number | null;
  epsActual: number | null;
  revenueConsensus: number | null;
  revenueActual: number | null;
  /** BEAT | IN_LINE | MISS | HELD | null */
  verdict: string | null;
  surprisePct: number | null;
  nextSessionReactionPct: number | null;
  deskTake: string | null;
  resultsFilingId: number | null;
}

interface EarningsRow {
  id: number;
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
  desk_take: string | null;
  results_filing_id: number | null;
}

const EARNINGS_COLS =
  "id,fiscal_period,report_date,date_state,session,eps_consensus,eps_marsad,eps_prior,eps_actual,revenue_consensus,revenue_actual,verdict,surprise_pct,next_session_reaction_pct,desk_take,results_filing_id";

/** Earnings event history for one security, newest-first by report date. */
export async function getEarningsForSecurity(
  securityId: number,
  limit = 80,
): Promise<EarningsEventItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data } = await sb
    .from("earnings_events")
    .select(EARNINGS_COLS)
    .eq("security_id", securityId)
    .order("report_date", { ascending: false })
    .limit(limit);

  return ((data as EarningsRow[] | null) ?? []).map((e) => ({
    id: e.id,
    fiscalPeriod: e.fiscal_period,
    reportDate: e.report_date,
    dateState: e.date_state,
    session: e.session,
    epsConsensus: toNum(e.eps_consensus),
    epsMarsad: toNum(e.eps_marsad),
    epsPrior: toNum(e.eps_prior),
    epsActual: toNum(e.eps_actual),
    revenueConsensus: toNum(e.revenue_consensus),
    revenueActual: toNum(e.revenue_actual),
    verdict: e.verdict,
    surprisePct: toNum(e.surprise_pct),
    nextSessionReactionPct: toNum(e.next_session_reaction_pct),
    deskTake: e.desk_take,
    resultsFilingId: e.results_filing_id,
  }));
}

// ── Ownership: holders, shareholding pattern, board & management ──────────

export interface HolderPosition {
  holderId: number;
  name: string;
  holderType: string;
  country: string | null;
  established: number | null;
  disclosedValueUsd: number | null;
  asOf: string;
  stakePct: number | null;
  qoqChangePp: number | null;
}

export interface OwnershipSnapshot {
  asOf: string;
  /** Producer-defined category label → stake pct (e.g. "government", "foreign_institutions"). Shape is not yet fixed — no producer has landed. */
  categories: Record<string, number>;
  foreignOwnershipPct: number | null;
  isFolRecord: boolean;
}

export interface CompanyPerson {
  id: number;
  name: string;
  /** board | management */
  role: string;
  title: string | null;
  isIndependent: boolean | null;
  seatCount: number | null;
  asOf: string | null;
}

export interface OwnershipBundle {
  /** Top holders as of the single most recent `holder_positions.as_of` for this security. */
  holders: HolderPosition[];
  /** Snapshots oldest→newest (for the shareholding-pattern matrix), capped at the last 8 periods. */
  snapshots: OwnershipSnapshot[];
  latestSnapshot: OwnershipSnapshot | null;
  board: CompanyPerson[];
  management: CompanyPerson[];
}

interface HolderPositionRow {
  holder_id: number;
  as_of: string;
  stake_pct: unknown;
  qoq_change_pp: unknown;
  holders: {
    name: string;
    holder_type: string;
    country: string | null;
    established: number | null;
    disclosed_value_usd: unknown;
  } | null;
}

async function fetchTopHolders(
  sb: ReturnType<typeof createAnonClient>,
  securityId: number,
): Promise<HolderPosition[]> {
  // Two-step: find the latest disclosed as_of for this security, then pull that
  // single cross-section — top holders is a point-in-time table, not a mixed
  // history of every as_of a holder was ever disclosed at.
  const { data: latest } = await sb
    .from("holder_positions")
    .select("as_of")
    .eq("security_id", securityId)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle<{ as_of: string }>();

  if (!latest?.as_of) return [];

  const { data } = await sb
    .from("holder_positions")
    .select("holder_id,as_of,stake_pct,qoq_change_pp,holders(name,holder_type,country,established,disclosed_value_usd)")
    .eq("security_id", securityId)
    .eq("as_of", latest.as_of)
    .order("stake_pct", { ascending: false })
    .limit(30);

  return ((data as unknown as HolderPositionRow[] | null) ?? [])
    .filter((r) => r.holders != null)
    .map((r) => ({
      holderId: r.holder_id,
      name: r.holders!.name,
      holderType: r.holders!.holder_type,
      country: r.holders!.country,
      established: toInt(r.holders!.established),
      disclosedValueUsd: toNum(r.holders!.disclosed_value_usd),
      asOf: r.as_of,
      stakePct: toNum(r.stake_pct),
      qoqChangePp: toNum(r.qoq_change_pp),
    }));
}

interface SnapshotRow {
  as_of: string;
  categories: Record<string, unknown> | null;
  foreign_ownership_pct: unknown;
  is_fol_record: boolean;
}

function mapSnapshot(s: SnapshotRow): OwnershipSnapshot {
  const categories: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.categories ?? {})) {
    const n = toNum(v);
    if (n !== null) categories[k] = n;
  }
  return {
    asOf: s.as_of,
    categories,
    foreignOwnershipPct: toNum(s.foreign_ownership_pct),
    isFolRecord: !!s.is_fol_record,
  };
}

interface PersonRow {
  id: number;
  name: string;
  role: string;
  title: string | null;
  is_independent: boolean | null;
  seat_count: number | null;
  as_of: string | null;
}

function mapPerson(p: PersonRow): CompanyPerson {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    title: p.title,
    isIndependent: p.is_independent,
    seatCount: toInt(p.seat_count),
    asOf: p.as_of,
  };
}

/** Ownership & people bundle for one security: top holders, shareholding-pattern snapshots, board, and management. All four source tables are 0 rows today — resolves to empty arrays until the profile-scrape producer lands (see module doc). */
export async function getOwnershipForSecurity(securityId: number): Promise<OwnershipBundle> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();

  const [holders, { data: snapRows }, { data: peopleRows }] = await Promise.all([
    fetchTopHolders(sb, securityId),
    sb
      .from("ownership_snapshots")
      .select("as_of,categories,foreign_ownership_pct,is_fol_record")
      .eq("security_id", securityId)
      .order("as_of", { ascending: false })
      .limit(8),
    sb
      .from("company_people")
      .select("id,name,role,title,is_independent,seat_count,as_of")
      .eq("security_id", securityId)
      .order("role", { ascending: true })
      .order("seat_count", { ascending: false, nullsFirst: false })
      .order("name", { ascending: true }),
  ]);

  const snapshotsDesc = ((snapRows as SnapshotRow[] | null) ?? []).map(mapSnapshot);
  const snapshots = snapshotsDesc.slice().reverse(); // oldest → newest for the matrix
  const people = ((peopleRows as PersonRow[] | null) ?? []).map(mapPerson);

  return {
    holders,
    snapshots,
    latestSnapshot: snapshotsDesc[0] ?? null,
    board: people.filter((p) => p.role === "board"),
    management: people.filter((p) => p.role === "management"),
  };
}

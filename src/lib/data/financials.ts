import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum } from "./util";

/**
 * Per-security filed-financials read (design 3b, BRIDGE-BUILD-PLAN P1.6).
 *
 * SOURCE: `public.v_financials_public` — the anon-safe FREE cut of
 * `public.financial_statements` added by `20260726192400_v_financials_public.sql`.
 * The base table carries a single `worker_all` RLS policy (anon sees ZERO rows),
 * so this view is the only reader path; it is `security_invoker = false`, the
 * same pattern as `v_scores_public` / `v_key_ratios_public`. A service-role read
 * was deliberately NOT used — service-role inside `use cache` can leak premium
 * rows into a shared CDN entry (BRIDGE-BUILD-PLAN §6).
 *
 * WHAT THE FREE CUT CONTAINS (everything else is premium, behind `PremiumLock`):
 * - the 4 most recent QUARTERLY and 2 most recent ANNUAL consolidated periods
 *   per security, period-aligned across income / balance / cashflow;
 * - headline lines only. The full `line_items` jsonb bag, `segments` and
 *   `presentation` are not exposed at all.
 *
 * DATA-READINESS (measured live 2026-07-26):
 * - 52,277 base rows covering 626 of 762 securities → 10,221 rows survive the
 *   free-tier window and are visible to anon. 136 securities have NO statements;
 *   for those this returns `[]` and the tab renders `EmptyState awaitingFeed`.
 * - `eps_basic` / `eps_diluted` are NULL and `epsSuppressed` is true for every
 *   TDWL row — DEF-TDWL-EPS-MAPPING (open): the TDWL XBRL extractor writes
 *   `net_income` into `eps_diluted`, corrupting EPS and therefore P/E. The
 *   suppression is enforced in the VIEW, not here, so no consumer can leak it.
 * - `capex` and `dividends_paid` sign conventions are NOT normalised upstream
 *   (both signs occur across filers) — render as filed, never derive free cash
 *   flow from them.
 * - Quarterly CASH-FLOW figures are as-filed and are cumulative year-to-date for
 *   many filers, while income rows are discrete. Do not mix the two: the adapter
 *   takes its cash-flow block from an ANNUAL period only.
 */

/** `income` | `balance` | `cashflow` — one statement, one period. */
export type StatementType = "income" | "balance" | "cashflow";
export type PeriodKind = "quarter" | "annual";

export interface FinancialStatementRow {
  statementType: StatementType;
  periodKind: PeriodKind;
  /** As filed, e.g. `Q2 2026` or `2025`. */
  fiscalPeriod: string;
  periodEnd: string;
  /** ISO-4217 of the filing, e.g. `SAR`, `QAR`, `AED`, `OMR`, `BHD`, `USD`. */
  currency: string;
  /** 1 = most recent period of this `periodKind` for this security. */
  periodRank: number;
  isEstimate: boolean;
  isRestated: boolean;
  audited: boolean | null;
  /** True when EPS was withheld by the view (DEF-TDWL-EPS-MAPPING). */
  epsSuppressed: boolean;

  // income
  revenue: number | null;
  costOfSales: number | null;
  grossProfit: number | null;
  ebit: number | null;
  financeCosts: number | null;
  profitBeforeTax: number | null;
  incomeTaxExpense: number | null;
  netIncome: number | null;
  epsBasic: number | null;
  epsDiluted: number | null;

  // balance
  totalAssets: number | null;
  totalLiabilities: number | null;
  equity: number | null;
  cash: number | null;
  totalDebt: number | null;

  // cash flow
  cfo: number | null;
  cfi: number | null;
  cff: number | null;
  capex: number | null;
  depAmort: number | null;
  dividendsPaid: number | null;
}

interface FinancialsRow {
  statement_type: string;
  period_kind: string;
  fiscal_period: string;
  period_end: string;
  currency: string;
  period_rank: number;
  is_estimate: boolean;
  is_restated: boolean;
  audited: boolean | null;
  eps_suppressed: boolean;
  revenue: unknown;
  cost_of_sales: unknown;
  gross_profit: unknown;
  ebit: unknown;
  finance_costs: unknown;
  profit_before_tax: unknown;
  income_tax_expense: unknown;
  net_income: unknown;
  eps_basic: unknown;
  eps_diluted: unknown;
  total_assets: unknown;
  total_liabilities: unknown;
  equity: unknown;
  cash: unknown;
  total_debt: unknown;
  cfo: unknown;
  cfi: unknown;
  cff: unknown;
  capex: unknown;
  dep_amort: unknown;
  dividends_paid: unknown;
}

const FINANCIALS_COLS =
  "statement_type,period_kind,fiscal_period,period_end,currency,period_rank," +
  "is_estimate,is_restated,audited,eps_suppressed," +
  "revenue,cost_of_sales,gross_profit,ebit,finance_costs,profit_before_tax," +
  "income_tax_expense,net_income,eps_basic,eps_diluted," +
  "total_assets,total_liabilities,equity,cash,total_debt," +
  "cfo,cfi,cff,capex,dep_amort,dividends_paid";

/**
 * Free-tier filed financials for one security — up to 4 quarterly + 2 annual
 * periods × 3 statement types (18 rows max), newest period first. Returns `[]`
 * for a security with no filed statements (136 of 762 today).
 */
export async function getFinancialsForSecurity(
  securityId: number,
): Promise<FinancialStatementRow[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const { data } = await sb
    .from("v_financials_public")
    .select(FINANCIALS_COLS)
    .eq("security_id", securityId)
    .order("period_end", { ascending: false })
    .order("statement_type", { ascending: true })
    .limit(24);

  return ((data as FinancialsRow[] | null) ?? []).map((r) => ({
    statementType: r.statement_type as StatementType,
    periodKind: r.period_kind as PeriodKind,
    fiscalPeriod: r.fiscal_period,
    periodEnd: r.period_end,
    currency: r.currency.trim(),
    periodRank: r.period_rank,
    isEstimate: !!r.is_estimate,
    isRestated: !!r.is_restated,
    audited: r.audited,
    epsSuppressed: !!r.eps_suppressed,

    revenue: toNum(r.revenue),
    costOfSales: toNum(r.cost_of_sales),
    grossProfit: toNum(r.gross_profit),
    ebit: toNum(r.ebit),
    financeCosts: toNum(r.finance_costs),
    profitBeforeTax: toNum(r.profit_before_tax),
    incomeTaxExpense: toNum(r.income_tax_expense),
    netIncome: toNum(r.net_income),
    epsBasic: toNum(r.eps_basic),
    epsDiluted: toNum(r.eps_diluted),

    totalAssets: toNum(r.total_assets),
    totalLiabilities: toNum(r.total_liabilities),
    equity: toNum(r.equity),
    cash: toNum(r.cash),
    totalDebt: toNum(r.total_debt),

    cfo: toNum(r.cfo),
    cfi: toNum(r.cfi),
    cff: toNum(r.cff),
    capex: toNum(r.capex),
    depAmort: toNum(r.dep_amort),
    dividendsPaid: toNum(r.dividends_paid),
  }));
}

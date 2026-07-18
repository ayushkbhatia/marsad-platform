// QE (Qatar Exchange) — per-company financial statements, XBRL-native.
//
// QE publishes its filings' XBRL facts as JSON through an undocumented-but-clean REST API
// (discovered in https://www.qe.com.qa/pps/XBRL/fsStatements.js, pinned by live recon 2026-07-17):
//
//   GET {base}/GetFinancialStatementsAPIData?symCode={sym}&reportEndDate={YYYY-MM-DD}
//         &sectionName={Balancesheet|Incomestatement|Cashflow}&getFilingDetails=0
//     -> [{ xbrlID, Value, FromDate, ToDate }, ...]
//   GET {base}/...&sectionName=&getFilingDetails=1  -> [{ approvedDate, uploadedDate }]  (=> filedAt)
//
// This module is PURE: JSON facts -> ExtractedFinancials, which flows through the SAME
// validateExtraction -> assembleFromExtraction -> fn_financials_project pipeline as every other
// venue (lake/statement-extraction.ts). No I/O, no Date.now(), replayable, golden-tested.
//
// It deliberately does NOT parse PDFs. QE's "Detailed XBRL" download (attachmentType=3) is a
// *rendered PDF* (Render_en.pdf), not an instance document — there is no raw XBRL to fetch. These
// JSON facts are the machine-readable form, so the PDFs are archived as source-of-record artifacts
// only and never extracted. That is what keeps this path deterministic and $0 (no LLM, no OCR).
//
// FIVE CONTRACT QUIRKS, all verified live — each one silently corrupts output if ignored:
//
//  1. UNORDERED. The API has no ORDER BY; the same URL returns the same facts in a different order
//     every call (verified: 3/3 distinct raw sha256, 3/3 identical once sorted). Never content-hash
//     a raw QE body — canonicalize first. Fixtures are stored pre-sorted for this reason.
//  2. COMPARATIVES ARE FREE. Every response carries the prior-period column as extra rows sharing
//     the xbrlID and differing on ToDate. One call => two periods.
//  3. PERIOD SPANS DIFFER BY QUARTER. Q1 carries only 01-01->03-31. Q2/Q3 carry BOTH the standalone
//     quarter (04-01->06-30) AND the cumulative YTD (01-01->06-30). Q4 carries ONLY the 12-month
//     annual span — there is no standalone Q4 column; derive it as FY minus 9M-YTD if ever needed.
//     We emit the STANDALONE quarter and drop the YTD duplicate: `basis` in this schema means
//     consolidated|standalone (a CHECK constraint), not QTD|YTD, so the unique key
//     (security_id, statement_type, basis, fiscal_period) admits exactly one "Q2 2024" row — and a
//     quarter label must mean the quarter.
//  4. NO SCALE OR CURRENCY TAG. Values are absolute QAR units (e.g. 949833000), so scale='units'
//     and currency is pinned from venue reference. Tadawul's detectScale() heuristic is unnecessary.
//  5. THREE TAXONOMIES, and the balance-sheet identity breaks under two of them (see IDENTITY below).
//
// IDENTITY (the landmine this module exists to defuse). validateExtraction() hard-rejects a balance
// sheet when |total_assets - (total_liabilities + equity)| / total_assets > 2%. Mapping the obvious
// tags gets that wrong for 8 of the 54 QE equities:
//
//   * Islamic banks (qse-crc_, 5 filers: QIBK QIIK MARK QFBQ DUBK) place unrestricted investment
//     accounts in `qse-crc_EquityOfInvestmentAccountHolders` — a THIRD category sitting between
//     liabilities and equity. Naive L+E leaves a 39-59% hole and every filing is rejected. IAH is
//     depositor money, so it folds into total_liabilities -> gap 0.00%.
//   * Takaful insurers (qse-ins-is_, 3 filers: AKHI QISI BEMA) report a split
//     shareholders/policyholders balance sheet and emit NO ifrs-full_Assets at all. Totals come from
//     the combined tags; equity and liabilities are each the sum of both funds -> gap 0.00%.
//
// Verified across the full universe at 2024-12-31: 48 clean + 5 IAH-corrected + 3 insurer-corrected,
// 0 failures. (QATI has a PDF but no structured JSON; FALH/MFMS listed 2025 — all yield zero rows
// here, which is the correct "nothing to project" signal, not an error.)

import type { ExtractedFinancials, ExtractedStatement } from '../../lake/statement-extraction.js';
import type { PeriodKind, StatementType } from '../../lake/statement-normalizer.js';

export const QE_FINANCIALS_PARSER_VERSION = 1;

/** QE's sectionName values. Case-insensitive at the API, but these are the canonical spellings.
 *  NOTE: the `sectionNames` var in fsStatements.js (financialPosition/statement/Cashflow) lists DIV
 *  ids, NOT API values — passing those returns []. */
export type QeSection = 'Balancesheet' | 'Incomestatement' | 'Cashflow';

export const QE_SECTIONS: readonly QeSection[] = ['Balancesheet', 'Incomestatement', 'Cashflow'];

const SECTION_STATEMENT: Record<QeSection, StatementType> = {
  Balancesheet: 'balance',
  Incomestatement: 'income',
  Cashflow: 'cashflow',
};

/** One raw fact row as returned by GetFinancialStatementsAPIData. */
export interface QeFactRow {
  xbrlID?: string | null;
  Value?: number | string | null;
  /** null on balance-sheet (instant) facts; the span start on income/cashflow (duration) facts. */
  FromDate?: string | null;
  ToDate?: string | null;
}

/** One section's payload, as handed to the parser by the (impure) researcher. */
export interface QeSectionPayload {
  section: QeSection;
  /** The raw parsed JSON body. Tolerated as unknown — a non-array degrades to zero rows. */
  rows: unknown;
}

// ── canonical §3.1 keys ──────────────────────────────────────────────────────────────────────────
// Additive: every fact ALSO lands under its own snake_cased tag name, so the reader keeps the full
// statement. This map only pins the primitives the ratio engine and the validation gate read.

const CANON: Record<string, string> = {
  // balance — standard IFRS
  'ifrs-full_Assets': 'total_assets',
  'ifrs-full_Liabilities': 'total_liabilities',
  'ifrs-full_Equity': 'equity',
  'ifrs-full_EquityAttributableToOwnersOfParent': 'equity_attributable_to_parent',
  'ifrs-full_CurrentLiabilities': 'current_liabilities',
  'ifrs-full_CurrentAssets': 'total_current_assets',
  'ifrs-full_CashAndCashEquivalents': 'cash',
  'ifrs-full_NoncontrollingInterests': 'noncontrolling_interests',
  // income
  'ifrs-full_Revenue': 'revenue',
  'ifrs-full_GrossProfit': 'gross_profit',
  'ifrs-full_CostOfSales': 'cost_of_sales',
  'ifrs-full_ProfitLossFromOperatingActivities': 'ebit',
  'ifrs-full_ProfitLoss': 'net_income',
  'ifrs-full_ProfitLossAttributableToOwnersOfParent': 'net_income_attributable_to_parent',
  'ifrs-full_BasicEarningsLossPerShare': 'eps_basic',
  'ifrs-full_DilutedEarningsLossPerShare': 'eps_diluted',
  'ifrs-full_FinanceCosts': 'finance_costs',
  'ifrs-full_FinanceIncome': 'finance_income',
  'ifrs-full_IncomeTaxExpenseContinuingOperations': 'income_tax_expense',
  'ifrs-full_NumberOfSharesOutstanding': 'shares_outstanding',
  'ifrs-full_WeightedAverageShares': 'weighted_average_shares',
  // cashflow
  'ifrs-full_CashFlowsFromUsedInOperatingActivities': 'cfo',
  'ifrs-full_CashFlowsFromUsedInInvestingActivities': 'cfi',
  'ifrs-full_CashFlowsFromUsedInFinancingActivities': 'cff',
  'ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense': 'dep_amort',
  'ifrs-full_DepreciationAndAmortisationExpense': 'dep_amort',
  'ifrs-full_DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities': 'dividends_paid',
  'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities': 'capex',
};

/** Revenue fallbacks, in priority order. Banks/Islamic banks emit no `ifrs-full_Revenue`; their
 *  top line is RevenueAndOperatingIncome (the "total operating income" analogue that
 *  statement-extraction's CANONICAL_ALIAS already folds to `revenue` for other venues). Applied
 *  only when the primary tag is absent, so an industrial's true Revenue always wins. */
const REVENUE_FALLBACKS = ['ifrs-full_RevenueAndOperatingIncome', 'qse-crc_RevenueFromOperatingActivities'];

/** Islamic-bank (qse-crc_) unrestricted investment accounts — economically depositor funds. */
const IAH_TAG = 'qse-crc_EquityOfInvestmentAccountHolders';

/** Takaful (qse-ins-is_) split-fund balance sheet. */
const INS = {
  assets: 'qse-ins-is_ShareholdersAndPolicyholdersAssets',
  equityAndLiabilities: 'qse-ins-is_ShareholdersAndPolicyholdersEquityAndLiabilities',
  shareholdersEquity: 'qse-ins-is_ShareholdersEquity',
  policyholdersEquity: 'qse-ins-is_PolicyholdersEquity',
  shareholdersLiabilities: 'qse-ins-is_ShareholdersLiabilities',
  policyholdersLiabilities: 'qse-ins-is_PolicyholdersLiabilities',
} as const;

/** `ifrs-full_PropertyPlantAndEquipment` -> `property_plant_and_equipment`. Prefix stripped so the
 *  taxonomy a filer happens to use never leaks into a line-item key. Bounded to 80 chars to match
 *  the Tadawul XBRL parser's key convention. */
export function snakeFromTag(tag: string): string {
  const local = tag.includes('_') ? tag.slice(tag.indexOf('_') + 1) : tag;
  return local
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DDT00:00:00' -> 'YYYY-MM-DD'. Returns '' for anything unparseable. */
function isoDay(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? (m[1] as string) : '';
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Whole months a duration fact spans, rounded. 89-92d -> 3, ~365d -> 12. */
function spanMonths(from: string, to: string): number {
  const d = daysBetween(from, to);
  if (d <= 0) return 0;
  return Math.round((d + 1) / 30.44);
}

interface Group {
  statement: StatementType;
  periodEnd: string;
  periodKind: PeriodKind;
  facts: Map<string, number>;
}

/**
 * PURE. QE section payloads -> ExtractedFinancials.
 *
 * @param payloads   one entry per section fetched for a single (symCode, reportEndDate).
 * @param currency   ISO-4217 from venue reference. Defaults 'QAR'; injected, never inferred.
 */
export function parseQeFinancials(
  payloads: readonly QeSectionPayload[],
  currency = 'QAR',
): ExtractedFinancials {
  // key: `${statement}|${periodEnd}` — one emitted statement per (type, period).
  const groups = new Map<string, Group>();

  for (const { section, rows } of payloads) {
    const statement = SECTION_STATEMENT[section];
    if (!statement || !Array.isArray(rows)) continue;

    for (const raw of rows as QeFactRow[]) {
      if (raw === null || typeof raw !== 'object') continue;
      const tag = typeof raw.xbrlID === 'string' ? raw.xbrlID.trim() : '';
      if (tag === '') continue;
      const value = toNum(raw.Value);
      if (value === null) continue;

      const to = isoDay(raw.ToDate);
      if (to === '') continue; // a fact with no period end cannot be placed
      const from = isoDay(raw.FromDate);

      let periodKind: PeriodKind;
      if (statement === 'balance') {
        // Instant fact. A 12-31 snapshot IS the annual balance sheet; interim reports carry the
        // prior YEAR-END as their comparative, so this also labels comparatives correctly.
        periodKind = /-12-31$/.test(to) ? 'annual' : 'quarter';
      } else {
        // Duration fact. Keep 3-month (standalone quarter) and 12-month (annual) spans; drop the
        // 6/9-month cumulative YTD columns, which would otherwise collide on the same
        // fiscal_period as the standalone quarter (quirk 3 above).
        if (from === '') continue;
        const months = spanMonths(from, to);
        if (months === 12) periodKind = 'annual';
        else if (months === 3) periodKind = 'quarter';
        else continue; // 6 / 9 / anything odd
      }

      const key = `${statement}|${to}`;
      let g = groups.get(key);
      if (!g) {
        g = { statement, periodEnd: to, periodKind, facts: new Map() };
        groups.set(key, g);
      }
      // Same tag twice within one group would mean an unexpected duplicate span; first wins.
      if (!g.facts.has(tag)) g.facts.set(tag, value);
    }
  }

  const statements: ExtractedStatement[] = [];
  for (const g of groups.values()) {
    const lineItems: Record<string, number | null> = {};

    for (const [tag, value] of g.facts) {
      lineItems[snakeFromTag(tag)] = value;
      const canon = CANON[tag];
      if (canon !== undefined && lineItems[canon] === undefined) lineItems[canon] = value;
    }

    if (g.statement === 'income') {
      if (lineItems.revenue === undefined) {
        for (const t of REVENUE_FALLBACKS) {
          const v = g.facts.get(t);
          if (v !== undefined) {
            lineItems.revenue = v;
            break;
          }
        }
      }
    }

    if (g.statement === 'balance') {
      applyBalanceTaxonomyFixes(g.facts, lineItems);
    }

    if (Object.keys(lineItems).length === 0) continue;

    statements.push({
      statement_type: g.statement,
      period_kind: g.periodKind,
      // Free-text label; canonicalFiscalPeriod() re-derives the real one from period_end on assemble.
      fiscal_period: g.periodEnd,
      period_end: g.periodEnd,
      line_items: lineItems,
    });
  }

  // Deterministic output order despite the unordered upstream (quirk 1).
  statements.sort(
    (a, b) =>
      a.statement_type.localeCompare(b.statement_type) || a.period_end.localeCompare(b.period_end),
  );

  return { currency, scale: 'units', statements };
}

/**
 * Reconcile the balance sheet to assets = liabilities + equity across QE's three taxonomies, so the
 * validateExtraction() identity gate sees a true statement rather than a taxonomy artefact. Mutates
 * `lineItems`. See the IDENTITY note in the file header for why each branch exists.
 */
function applyBalanceTaxonomyFixes(
  facts: ReadonlyMap<string, number>,
  lineItems: Record<string, number | null>,
): void {
  // ── Takaful insurers (qse-ins-is_): no ifrs-full_Assets at all; totals live in the combined tags
  //    and each side is the sum of the shareholders' and policyholders' funds.
  const insAssets = facts.get(INS.assets);
  if (insAssets !== undefined) {
    lineItems.total_assets = insAssets;

    const se = facts.get(INS.shareholdersEquity);
    const pe = facts.get(INS.policyholdersEquity);
    if (se !== undefined || pe !== undefined) lineItems.equity = (se ?? 0) + (pe ?? 0);
    if (se !== undefined) lineItems.shareholders_equity = se;
    if (pe !== undefined) lineItems.policyholders_equity = pe;

    const sl = facts.get(INS.shareholdersLiabilities);
    const pl = facts.get(INS.policyholdersLiabilities);
    if (sl !== undefined || pl !== undefined) lineItems.total_liabilities = (sl ?? 0) + (pl ?? 0);
    return;
  }

  // ── Islamic banks (qse-crc_): fold unrestricted investment accounts into liabilities. Kept as its
  //    own line item too, since it is a real and analytically important balance.
  const iah = facts.get(IAH_TAG);
  if (iah !== undefined) {
    const liabilities = facts.get('ifrs-full_Liabilities');
    if (liabilities !== undefined) lineItems.total_liabilities = liabilities + iah;
    lineItems.equity_of_investment_account_holders = iah;
  }
}

/** The getFilingDetails=1 envelope. `approvedDate` is QE's publication stamp -> our filedAt. */
export interface QeFilingDetail {
  approvedDate?: string | null;
  uploadedDate?: string | null;
}

/**
 * PURE. getFilingDetails=1 body -> the filing's publication instant as an ISO-8601 UTC string, or
 * null when absent. QE serves these as naive Asia/Qatar (UTC+3, no DST) wall-clock, so the offset is
 * applied explicitly rather than letting Date.parse() assume the host's zone.
 */
export function parseQeFilingDetail(body: unknown): string | null {
  const rows = Array.isArray(body) ? (body as QeFilingDetail[]) : [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const stamp = typeof r.approvedDate === 'string' && r.approvedDate.trim() !== ''
      ? r.approvedDate
      : typeof r.uploadedDate === 'string'
        ? r.uploadedDate
        : '';
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(stamp.trim());
    if (!m) continue;
    const ms = Date.parse(`${m[1]}T${m[2]}+03:00`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Canonicalize a QE fact array for CONTENT HASHING. The API returns rows in a different order on
 * every call (quirk 1), so hashing a raw body reports CHANGED on every poll — which would defeat the
 * weekly incremental no-op and churn storage. Hash THIS, never the raw bytes.
 */
export function canonicalizeQeFacts(rows: unknown): string {
  if (!Array.isArray(rows)) return '[]';
  const norm = (rows as QeFactRow[])
    .filter((r) => r !== null && typeof r === 'object')
    .map((r) => ({
      xbrlID: typeof r.xbrlID === 'string' ? r.xbrlID : '',
      Value: toNum(r.Value),
      FromDate: isoDay(r.FromDate),
      ToDate: isoDay(r.ToDate),
    }));
  norm.sort(
    (a, b) =>
      a.xbrlID.localeCompare(b.xbrlID) ||
      a.ToDate.localeCompare(b.ToDate) ||
      a.FromDate.localeCompare(b.FromDate) ||
      (a.Value ?? 0) - (b.Value ?? 0),
  );
  return JSON.stringify(norm);
}

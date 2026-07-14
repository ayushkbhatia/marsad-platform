/**
 * Financial-statement extraction contract + the VALIDATION GATE (plan
 * docs/plans/p17-financials-pdf-architecture.md §3.3). PURE — no I/O, no network,
 * no Date.now. The impure orchestration (pdftotext → LLM `chatComplete`) lives
 * worker-side; this module owns everything that must be deterministic + testable:
 *   - the JSON schema + prompt the LLM is constrained to,
 *   - assembleFromExtraction(): the LLM's raw JSON → canonical NormalizedStatements
 *     (§3.1 primitives, SCALE-NORMALIZED to actual currency units),
 *   - validateExtraction(): the HARD GATE that rejects the class of errors the
 *     Mubasher aggregator shipped (1000× scale swings, budget/forecast rows,
 *     impossible magnitudes, broken accounting identities). A number that fails
 *     the gate never reaches public.financial_statements — it is dropped to the
 *     Desk review queue. A wrong fundamental is worse than a missing one.
 */

import {
  toNumberOrNull,
  type NormalizedStatements,
  type NormalizedPeriod,
  type StatementType,
  type PeriodKind,
  type PrimitiveKey,
} from './statement-normalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// The LLM output contract (what chatComplete(role,{json: EXTRACTION_JSON_SCHEMA}) returns)
// ─────────────────────────────────────────────────────────────────────────────

/** One reporting column of one filing (the period, or its prior-period comparative). */
export interface ExtractedPeriod {
  /** 'quarter' | 'annual'. Interim (3/6/9-month) statements are 'quarter'. */
  period_kind: PeriodKind;
  /** Human label, e.g. 'Q1 2026' or 'FY2025'. */
  fiscal_period: string;
  /** 'YYYY-MM-DD' — the period end date. */
  period_end: string;
  /** true when this column is a prior-period comparative, not the reported period. */
  is_comparative: boolean;
  /** §3.1 primitives AS PRINTED (in `scale` units); absent line ⇒ null. */
  revenue?: number | null;
  gross_profit?: number | null;
  ebit?: number | null;
  dep_amort?: number | null;
  net_income?: number | null;
  eps_diluted?: number | null;
  equity?: number | null;
  total_assets?: number | null;
  total_debt?: number | null;
  cash?: number | null;
  current_liabilities?: number | null;
  nii?: number | null;
  avg_earning_assets?: number | null;
  dividends_paid?: number | null;
  /** Validation anchors — used by the gate, NOT persisted as primitives. */
  total_liabilities?: number | null;
}

export interface ExtractedFinancials {
  /** ISO-4217, e.g. 'SAR'. */
  currency: string;
  /** The printed unit scale — the LLM reads it from the statement header. */
  scale: 'units' | 'thousands' | 'millions' | 'billions';
  periods: ExtractedPeriod[];
}

const SCALE_FACTOR: Record<ExtractedFinancials['scale'], number> = {
  units: 1,
  thousands: 1_000,
  millions: 1_000_000,
  billions: 1_000_000_000,
};

/** Which statement family each §3.1 primitive belongs to (for per-type splitting). */
const KEY_STATEMENT: Record<PrimitiveKey, StatementType> = {
  revenue: 'income',
  gross_profit: 'income',
  ebit: 'income',
  net_income: 'income',
  eps_diluted: 'income',
  nii: 'income',
  equity: 'balance',
  total_assets: 'balance',
  total_debt: 'balance',
  cash: 'balance',
  current_liabilities: 'balance',
  capital_employed: 'balance',
  avg_earning_assets: 'balance',
  dep_amort: 'cashflow',
  dividends_paid: 'cashflow',
};

const PER_SHARE_KEYS: ReadonlySet<PrimitiveKey> = new Set(['eps_diluted']);

// ─────────────────────────────────────────────────────────────────────────────
// The LLM prompt + JSON schema (constrained structured output)
// ─────────────────────────────────────────────────────────────────────────────

/** JSON schema passed as chatComplete opts.json for strict structured decoding. */
export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  name: 'financial_statements',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['currency', 'scale', 'periods'],
    properties: {
      currency: { type: 'string', description: 'ISO-4217 currency code, e.g. SAR' },
      scale: { type: 'string', enum: ['units', 'thousands', 'millions', 'billions'] },
      periods: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['period_kind', 'fiscal_period', 'period_end', 'is_comparative'],
          properties: {
            period_kind: { type: 'string', enum: ['quarter', 'annual'] },
            fiscal_period: { type: 'string' },
            period_end: { type: 'string', description: 'YYYY-MM-DD' },
            is_comparative: { type: 'boolean' },
            revenue: { type: ['number', 'null'] },
            gross_profit: { type: ['number', 'null'] },
            ebit: { type: ['number', 'null'] },
            dep_amort: { type: ['number', 'null'] },
            net_income: { type: ['number', 'null'] },
            eps_diluted: { type: ['number', 'null'] },
            equity: { type: ['number', 'null'] },
            total_assets: { type: ['number', 'null'] },
            total_liabilities: { type: ['number', 'null'] },
            total_debt: { type: ['number', 'null'] },
            cash: { type: ['number', 'null'] },
            current_liabilities: { type: ['number', 'null'] },
            nii: { type: ['number', 'null'] },
            avg_earning_assets: { type: ['number', 'null'] },
            dividends_paid: { type: ['number', 'null'] },
          },
        },
      },
    },
  },
};

export const EXTRACTION_SYSTEM = [
  'You extract structured financial data from the plain text of a listed-company financial-statement filing.',
  'Return ONLY JSON matching the schema. Rules:',
  '- Report every number EXACTLY as printed (do not rescale); set `scale` to the unit the statement declares',
  '  (e.g. "Expressed in SAR thousands" → "thousands"). If no scale is stated, use "units".',
  '- Map to these canonical keys ONLY where the statement clearly reports them; otherwise null:',
  '  revenue (banks: total operating income = net interest income + fee income), gross_profit, ebit (operating',
  '  income), dep_amort (depreciation+amortisation, from cash-flow), net_income (profit attributable to equity',
  '  holders of the parent, post-minority), eps_diluted, equity (total equity attributable to the parent),',
  '  total_assets, total_liabilities, total_debt (short+long borrowings), cash (cash & equivalents),',
  '  current_liabilities, nii (banks: net interest income), avg_earning_assets (banks), dividends_paid.',
  '- Emit ONE period object per reporting column, including the prior-period comparative (is_comparative=true).',
  '- eps_diluted is a per-share figure — never rescale it by `scale`.',
  '- Never invent, infer, or cross-foot a number that is not printed. A missing line is null, not a guess.',
].join('\n');

/** Build the user message from the extracted PDF text (truncated to a token budget). */
export function buildExtractionUserMessage(pdfText: string, maxChars = 60_000): string {
  const text = pdfText.length > maxChars ? pdfText.slice(0, maxChars) : pdfText;
  return `Financial-statement filing text:\n\n${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly: LLM JSON → canonical NormalizedStatements (SCALE-NORMALIZED)
// ─────────────────────────────────────────────────────────────────────────────

const PRIMITIVES: readonly PrimitiveKey[] = [
  'revenue', 'gross_profit', 'ebit', 'dep_amort', 'net_income', 'eps_diluted',
  'equity', 'total_assets', 'total_debt', 'cash', 'current_liabilities',
  'nii', 'avg_earning_assets', 'dividends_paid',
];

/** Scale a printed value to actual currency units (per-share keys are never scaled). */
function toActual(key: PrimitiveKey, raw: number | null, factor: number): number | null {
  if (raw === null) return null;
  const v = PER_SHARE_KEYS.has(key) ? raw : raw * factor;
  return Number.isFinite(v) ? v : null;
}

/**
 * PURE. Turn a validated ExtractedFinancials into per-statement-type NormalizedPeriods
 * (§3.1 primitives, actual units). One fiscal period fans out to up to 3 rows
 * (income/balance/cashflow), matching how key-ratios.ts reads statements per type.
 * capital_employed is derived (total_assets − current_liabilities) onto the balance row.
 */
export function assembleFromExtraction(
  raw: ExtractedFinancials,
  venue: string,
  ticker: string,
): NormalizedStatements {
  const factor = SCALE_FACTOR[raw.scale] ?? 1;
  const currency = raw.currency && raw.currency.trim() !== '' ? raw.currency : 'SAR';
  const periods: NormalizedPeriod[] = [];

  for (const p of raw.periods) {
    // Bucket scaled primitives by statement family.
    const byType: Record<StatementType, Record<string, number | null>> = {
      income: {}, balance: {}, cashflow: {},
    };
    for (const key of PRIMITIVES) {
      const val = toActual(key, (p as unknown as Record<string, number | null | undefined>)[key] ?? null, factor);
      if (val === null) continue;
      byType[KEY_STATEMENT[key]][key] = val;
    }
    // Derived capital_employed onto the balance row.
    const ta = byType.balance.total_assets ?? null;
    const cl = byType.balance.current_liabilities ?? null;
    if (ta !== null && cl !== null) byType.balance.capital_employed = ta - cl;

    for (const st of ['income', 'balance', 'cashflow'] as StatementType[]) {
      if (Object.keys(byType[st]).length === 0) continue;
      periods.push({
        periodKind: p.period_kind,
        fiscalPeriod: p.fiscal_period,
        periodEnd: p.period_end,
        currency,
        statementType: st,
        lineItems: byType[st],
      });
    }
  }
  return { venue, ticker, periods };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VALIDATION GATE (the Mubasher-killer)
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  fiscalPeriod: string;
  check: string;
  severity: 'reject' | 'warn';
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Extracted periods that PASSED every hard check (scaled to actual units). */
  accepted: ExtractedPeriod[];
  /** Periods dropped to the Desk review queue, with the reason. */
  rejected: { period: ExtractedPeriod; reasons: ValidationIssue[] }[];
  issues: ValidationIssue[];
}

/** Absolute magnitude ceiling for any single balance-sheet total (actual units). */
const MAX_MAGNITUDE = 1e15; // > world's largest balance sheet; anything above = a parse/scale bug
const IDENTITY_TOL = 0.02; // 2% tolerance on the accounting identity
const BUDGET_RE = /budget|forecast|estimate|projected|guidance/i;

/**
 * PURE. The hard gate. Runs scale-normalized checks and returns which periods may
 * be persisted. Every rejected period carries its reason for the Desk queue.
 *
 * Checks (07 §3.3 spirit + the Mubasher post-mortem):
 *  - budget/forecast/estimate periods are NOT actuals → reject.
 *  - impossible magnitude (|total_assets| > 1e15 after scaling) → reject (scale bug).
 *  - accounting identity: total_assets ≈ total_liabilities + equity (±2%) when all present.
 *  - gross_profit ≤ revenue; |net_income| ≤ 5×revenue (sanity) → warn/reject.
 *  - CROSS-PERIOD scale consistency (the 1000× Mubasher signature): within one filing the
 *    reported period and its comparative are the same company months apart — total_assets must
 *    not swing beyond [0.2×, 5×]. A 1000× jump ⇒ reject BOTH as an internal scale inconsistency.
 */
export function validateExtraction(raw: ExtractedFinancials): ValidationResult {
  const factor = SCALE_FACTOR[raw.scale] ?? 1;
  const issues: ValidationIssue[] = [];
  const rejected: ValidationResult['rejected'] = [];
  const accepted: ExtractedPeriod[] = [];

  const sc = (v: number | null | undefined): number | null =>
    v === null || v === undefined || !Number.isFinite(v) ? null : v * factor;

  // Cross-period scale consistency on total_assets (actual units). Budget/forecast
  // periods are excluded from the population so a stray non-actual can't poison the
  // scale check for the real reporting + comparative columns.
  const assetsByPeriod = raw.periods
    .filter((p) => !BUDGET_RE.test(p.fiscal_period))
    .map((p) => sc(p.total_assets))
    .filter((v): v is number => v !== null && v > 0);
  let scaleInconsistent = false;
  for (const a of assetsByPeriod) {
    for (const b of assetsByPeriod) {
      const r = a / b;
      if (r > 5 || r < 0.2) scaleInconsistent = true;
    }
  }

  for (const p of raw.periods) {
    const reasons: ValidationIssue[] = [];
    const ta = sc(p.total_assets);
    const tl = sc(p.total_liabilities);
    const eq = sc(p.equity);
    const rev = sc(p.revenue);
    const gp = sc(p.gross_profit);
    const ni = sc(p.net_income);

    if (BUDGET_RE.test(p.fiscal_period)) {
      reasons.push({ fiscalPeriod: p.fiscal_period, check: 'not_actual', severity: 'reject',
        detail: `fiscal_period "${p.fiscal_period}" is a budget/forecast, not reported actuals` });
    }
    for (const [k, v] of [['total_assets', ta], ['equity', eq], ['revenue', rev]] as const) {
      if (v !== null && Math.abs(v) > MAX_MAGNITUDE) {
        reasons.push({ fiscalPeriod: p.fiscal_period, check: 'magnitude', severity: 'reject',
          detail: `${k}=${v} exceeds the ${MAX_MAGNITUDE} sanity ceiling (scale/parse bug)` });
      }
    }
    if (scaleInconsistent) {
      reasons.push({ fiscalPeriod: p.fiscal_period, check: 'scale_consistency', severity: 'reject',
        detail: 'total_assets swings >5× across the filing periods — internal scale inconsistency (the Mubasher 1000× signature)' });
    }
    if (ta !== null && tl !== null && eq !== null && ta !== 0) {
      const gap = Math.abs(ta - (tl + eq)) / Math.abs(ta);
      if (gap > IDENTITY_TOL) {
        reasons.push({ fiscalPeriod: p.fiscal_period, check: 'accounting_identity', severity: 'reject',
          detail: `total_assets(${ta}) ≠ total_liabilities(${tl}) + equity(${eq}); gap ${(gap * 100).toFixed(1)}%` });
      }
    }
    // gross_profit = revenue − COGS, so it can never exceed revenue, and its
    // magnitude can't wildly exceed revenue either (a −14.6T "gross profit" on
    // revenue 100 is the Mubasher-class garbage this catches).
    if (rev !== null && gp !== null && (gp > Math.abs(rev) * 1.001 || Math.abs(gp) > Math.abs(rev) * 2)) {
      reasons.push({ fiscalPeriod: p.fiscal_period, check: 'gross_le_revenue', severity: 'reject',
        detail: `gross_profit(${gp}) is implausible vs revenue(${rev})` });
    }
    if (rev !== null && ni !== null && rev > 0 && Math.abs(ni) > rev * 5) {
      reasons.push({ fiscalPeriod: p.fiscal_period, check: 'income_bound', severity: 'warn',
        detail: `|net_income|(${Math.abs(ni)}) > 5× revenue(${rev}) — unusual, flag` });
    }

    issues.push(...reasons);
    const hardFail = reasons.some((r) => r.severity === 'reject');
    if (hardFail) rejected.push({ period: p, reasons: reasons.filter((r) => r.severity === 'reject') });
    else accepted.push(p);
  }

  return { ok: rejected.length === 0, accepted, rejected, issues };
}

/** Convenience: validate then assemble only the accepted periods → NormalizedStatements. */
export function extractToStatements(
  raw: ExtractedFinancials,
  venue: string,
  ticker: string,
): { statements: NormalizedStatements; validation: ValidationResult } {
  void toNumberOrNull; // keep the import surface stable for callers extending this module
  const validation = validateExtraction(raw);
  const statements = assembleFromExtraction(
    { ...raw, periods: validation.accepted },
    venue,
    ticker,
  );
  return { statements, validation };
}

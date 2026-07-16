/**
 * Financial-statement extraction contract + the VALIDATION GATE (plan
 * docs/plans/p17-financials-pdf-architecture.md §3.3). PURE — no I/O, no network,
 * no Date.now. The impure orchestration (pdftotext → LLM `chatComplete`) lives
 * worker-side; this module owns everything deterministic + testable.
 *
 * FULL-STATEMENT CAPTURE (2026-07-15): a quarterly/annual filing PDF carries the
 * complete Income Statement + Balance Sheet + Cash-Flow Statement (+ notes). We
 * extract EVERY line of all three, per period, into financial_statements.line_items
 * (jsonb) — the canonical §3.1 primitive keys (which the ratio engine reads) PLUS
 * every other printed line under a snake_case key (the business datapoints the
 * reader shows). One filing → up to 3 statement_types × N periods.
 *
 *   - buildExtractionUserMessage / EXTRACTION_JSON_SCHEMA: the constrained LLM contract.
 *   - assembleFromExtraction(): LLM/XBRL JSON → NormalizedStatements, SCALE-NORMALIZED to
 *     actual currency units; canonical aliases resolved (total_equity→equity, …).
 *   - validateExtraction(): the HARD GATE — rejects the Mubasher failure class
 *     (1000× scale swings, budget/forecast rows, impossible magnitudes, broken
 *     assets=liabilities+equity). A number that fails never reaches
 *     public.financial_statements — it drops to the Desk review queue.
 *
 * PROVENANCE: recovered 2026-07-16 from the live VPS build
 * (dist/lake/statement-extraction.js) to close DEF-REPO-DRIFT-STMT-EXTRACTION —
 * the source had drifted out of the repo. Reconstruction is behaviour-verified
 * byte-for-byte against a real SABIC (2010) XBRL filing (see the golden test).
 */
import { toNumberOrNull } from './statement-normalizer.js';
import type { NormalizedPeriod, NormalizedStatements, PeriodKind, StatementType } from './statement-normalizer.js';

/** One reporting column of one filing (the reported period, or its prior-period comparative). The SAME
 *  shape the XBRL parser (adapters/tadawul/xbrl.ts) and the PDF+LLM path both emit, so both flow through
 *  the identical gate → assemble → fn_financials_project pipeline. */
export interface ExtractedStatement {
  statement_type: StatementType;
  period_kind: PeriodKind;
  /** Model/parser free-text label (e.g. 'Q1 2026', 'FY2025') — canonicalised on assemble. */
  fiscal_period: string;
  /** 'YYYY-MM-DD' — the period end date. */
  period_end: string;
  /** true when this column is a prior-period comparative, not the reported period. Not read here. */
  is_comparative?: boolean;
  /** {key: value} for EVERY printed line, in `scale` units; absent line ⇒ null/absent. */
  line_items: Record<string, number | null>;
}

/** The LLM/XBRL extraction envelope — one filing's statements at a single declared scale. */
export interface ExtractedFinancials {
  /** ISO-4217, e.g. 'SAR'. */
  currency: string;
  /** The printed unit scale — read from the statement header ("in SAR thousands" → 'thousands'). */
  scale: 'units' | 'thousands' | 'millions' | 'billions';
  statements: ExtractedStatement[];
}

const SCALE_FACTOR: Record<ExtractedFinancials['scale'], number> = {
  units: 1, thousands: 1_000, millions: 1_000_000, billions: 1_000_000_000,
};

/** Per-share keys are never rescaled by `scale`. */
const PER_SHARE_KEYS = new Set(['eps_diluted', 'eps_basic', 'dps', 'book_value_ps']);

/** Canonical-key aliases: LLM may print a synonym; fold it onto the §3.1 key the
 *  ratio engine reads. Applied after scaling. Only fills a canonical key if absent. */
const CANONICAL_ALIAS: Record<string, string> = {
  total_equity: 'equity',
  total_shareholders_equity: 'equity',
  shareholders_equity: 'equity',
  profit_for_the_period: 'net_income',
  net_profit: 'net_income',
  profit_attributable_to_equity_holders: 'net_income',
  total_revenue: 'revenue',
  total_operating_income: 'revenue', // banks
  operating_income: 'ebit',
  net_interest_income: 'nii',
  cash_and_cash_equivalents: 'cash',
  depreciation_and_amortization: 'dep_amort',
  depreciation_amortization: 'dep_amort',
};

/** §3.1 canonical primitives → which statement they belong to (for capital_employed derivation). */
const CANON_BALANCE = new Set(['equity', 'total_assets', 'total_debt', 'cash', 'current_liabilities', 'capital_employed', 'avg_earning_assets']);

// ─────────────────────────────────────────────────────────────────────────────
// LLM prompt + schema
// ─────────────────────────────────────────────────────────────────────────────

/** JSON schema passed as chatComplete opts.json for strict structured decoding. */
export const EXTRACTION_JSON_SCHEMA = {
  name: 'financial_statements',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['currency', 'scale', 'statements'],
    properties: {
      currency: { type: 'string' },
      scale: { type: 'string', enum: ['units', 'thousands', 'millions', 'billions'] },
      statements: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['statement_type', 'period_kind', 'fiscal_period', 'period_end', 'is_comparative', 'line_items'],
          properties: {
            statement_type: { type: 'string', enum: ['income', 'balance', 'cashflow'] },
            period_kind: { type: 'string', enum: ['quarter', 'annual'] },
            fiscal_period: { type: 'string' },
            period_end: { type: 'string' },
            is_comparative: { type: 'boolean' },
            line_items: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          },
        },
      },
    },
  },
};

export const EXTRACTION_SYSTEM = [
  'You extract the COMPLETE financial statements from a listed-company filing (quarterly or annual). The',
  'filing contains an Income Statement, a Balance Sheet (Statement of Financial Position), and a Cash-Flow',
  'Statement — extract ALL THREE, and for each, EVERY line item, for every period column present (including',
  'the prior-period comparative).',
  'Return ONLY JSON of the exact shape: {"currency":"ISO3","scale":"units|thousands|millions|billions",',
  '"statements":[{"statement_type":"income|balance|cashflow","period_kind":"quarter|annual",',
  '"fiscal_period":"e.g. Q1 2026","period_end":"YYYY-MM-DD","is_comparative":bool,"line_items":{...}}]}.',
  'RULES:',
  '- Report numbers EXACTLY as printed; set `scale` to the declared unit ("in SAR thousands" → "thousands").',
  '- `line_items` is an object of {key: value} for EVERY printed line of that statement. Use a snake_case key',
  '  from the printed label (e.g. "Total revenue" → total_revenue). ALSO include these CANONICAL keys wherever',
  '  the corresponding line exists so downstream ratios work:',
  '    income:   revenue (banks: total_operating_income), gross_profit, ebit (=operating income), net_income',
  '              (profit for the period attributable to equity holders of the parent), eps_diluted, nii (banks).',
  '    balance:  total_assets, total_liabilities, equity (TOTAL equity incl. non-controlling interests),',
  '              cash (cash & equivalents), total_debt (short+long borrowings), current_liabilities.',
  '    cashflow: dep_amort (depreciation+amortisation), dividends_paid, cfo/cfi/cff (operating/investing/financing).',
  '- eps/dps are per-share — never rescale. Never invent or cross-foot a line that is not printed.',
  '- One statement object per (statement_type × period). Keep the comparative column as its own object.',
].join('\n');

/** Build the user message from the (full) extracted PDF text. */
export function buildExtractionUserMessage(pdfText: string, maxChars = 120_000): string {
  const text = pdfText.length > maxChars ? pdfText.slice(0, maxChars) : pdfText;
  return `Financial-statement filing text:\n\n${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly: LLM/XBRL JSON → NormalizedStatements (SCALE-NORMALIZED, full line_items)
// ─────────────────────────────────────────────────────────────────────────────

function scaleLineItems(lines: Record<string, unknown>, factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(lines)) {
    const n = toNumberOrNull(raw);
    if (n === null) continue;
    out[k] = PER_SHARE_KEYS.has(k) ? n : n * factor;
  }
  // Fold aliases onto canonical keys (only if the canonical key is absent).
  for (const [alias, canon] of Object.entries(CANONICAL_ALIAS)) {
    if (out[alias] !== undefined && out[canon] === undefined) out[canon] = out[alias];
  }
  // Derived capital_employed (§3.1) onto the balance line_items.
  if (typeof out.total_assets === 'number' && typeof out.current_liabilities === 'number' && out.capital_employed === undefined) {
    out.capital_employed = out.total_assets - out.current_liabilities;
  }
  return out;
}

/** Canonical fiscal_period DERIVED from period_end + kind — NOT the model's free-text (which varies:
 *  "FY 2024" vs "2024" vs "FY2024"). Guarantees the XBRL and LLM paths agree so their lake objects share
 *  a natural_key (dedup + the source-rank guard depend on it). Annual → "2025"; quarter → "Q1 2026". */
export function canonicalFiscalPeriod(periodKind: PeriodKind, periodEnd: string, fallback: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(periodEnd || '');
  if (!m) return fallback;
  const y = Number(m[1]);
  if (periodKind === 'annual' || periodKind === 'ttm') return String(y);
  const q = Math.floor((Number(m[2]) - 1) / 3) + 1;
  return `Q${q} ${y}`;
}

/** PURE. LLM/XBRL JSON → per-statement-type NormalizedPeriods with FULL line_items (actual units). */
export function assembleFromExtraction(raw: ExtractedFinancials, venue: string, ticker: string): NormalizedStatements {
  const factor = SCALE_FACTOR[raw.scale] ?? 1;
  const currency = raw.currency && raw.currency.trim() !== '' ? raw.currency : 'SAR';
  const periods: NormalizedPeriod[] = [];
  for (const s of raw.statements ?? []) {
    const lineItems = scaleLineItems(s.line_items || {}, factor);
    if (Object.keys(lineItems).length === 0) continue;
    const fiscalPeriod = canonicalFiscalPeriod(s.period_kind, s.period_end, s.fiscal_period);
    periods.push({ periodKind: s.period_kind, fiscalPeriod, periodEnd: s.period_end, currency, statementType: s.statement_type, lineItems });
  }
  return { venue, ticker, periods };
}

const MAX_MAGNITUDE = 1e15;
const IDENTITY_TOL = 0.02;
const BUDGET_RE = /budget|forecast|projected|guidance/i;

export interface ValidationIssue {
  statementType: StatementType;
  fiscalPeriod: string;
  check: string;
  severity: 'reject' | 'warn';
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Statements that PASSED every hard check (raw; assemble scales them). */
  accepted: ExtractedStatement[];
  /** Statements dropped to the Desk review queue, with the reasons. */
  rejected: { statement: ExtractedStatement; reasons: ValidationIssue[] }[];
  issues: ValidationIssue[];
}

/** PURE. The hard gate — see file header. Runs scale-normalized checks per statement. */
export function validateExtraction(raw: ExtractedFinancials): ValidationResult {
  const factor = SCALE_FACTOR[raw.scale] ?? 1;
  const stmts = raw.statements ?? [];
  const issues: ValidationIssue[] = [];
  const rejected: { statement: ExtractedStatement; reasons: ValidationIssue[] }[] = [];
  const accepted: ExtractedStatement[] = [];
  const li = (s: ExtractedStatement) => scaleLineItems(s.line_items || {}, factor);
  // Cross-period scale consistency on total_assets across the BALANCE statements (the 1000× signature).
  const bals = stmts.filter((s) => s.statement_type === 'balance' && !BUDGET_RE.test(s.fiscal_period));
  const assets = bals.map((s) => li(s).total_assets).filter((v): v is number => typeof v === 'number' && v > 0);
  let scaleBad = false;
  for (const a of assets)
    for (const b of assets) {
      const r = a / b;
      if (r > 5 || r < 0.2) scaleBad = true;
    }
  for (const s of stmts) {
    const reasons: ValidationIssue[] = [];
    const m = li(s);
    const push = (check: string, severity: 'reject' | 'warn', detail: string) => reasons.push({ statementType: s.statement_type, fiscalPeriod: s.fiscal_period, check, severity, detail });
    if (BUDGET_RE.test(s.fiscal_period)) push('not_actual', 'reject', `"${s.fiscal_period}" is a budget/forecast`);
    for (const k of ['total_assets', 'equity', 'revenue'])
      if (typeof m[k] === 'number' && Math.abs(m[k]) > MAX_MAGNITUDE)
        push('magnitude', 'reject', `${k}=${m[k]} exceeds sanity ceiling (scale/parse bug)`);
    if (s.statement_type === 'balance') {
      if (scaleBad)
        push('scale_consistency', 'reject', 'total_assets swings >5× across periods (Mubasher 1000× signature)');
      const ta = m.total_assets, tl = m.total_liabilities, eq = m.equity;
      if (typeof ta === 'number' && typeof tl === 'number' && typeof eq === 'number' && ta !== 0) {
        const gap = Math.abs(ta - (tl + eq)) / Math.abs(ta);
        if (gap > IDENTITY_TOL)
          push('accounting_identity', 'reject', `total_assets(${ta}) ≠ liabilities(${tl}) + equity(${eq}); gap ${(gap * 100).toFixed(1)}%`);
      }
    }
    if (s.statement_type === 'income') {
      const rev = m.revenue, gp = m.gross_profit, ni = m.net_income;
      if (typeof rev === 'number' && typeof gp === 'number' && (gp > Math.abs(rev) * 1.001 || Math.abs(gp) > Math.abs(rev) * 2))
        push('gross_le_revenue', 'reject', `gross_profit(${gp}) implausible vs revenue(${rev})`);
      if (typeof rev === 'number' && typeof ni === 'number' && rev > 0 && Math.abs(ni) > rev * 5)
        push('income_bound', 'warn', `|net_income| > 5× revenue`);
    }
    issues.push(...reasons);
    if (reasons.some((r) => r.severity === 'reject'))
      rejected.push({ statement: s, reasons: reasons.filter((r) => r.severity === 'reject') });
    else
      accepted.push(s);
  }
  return { ok: rejected.length === 0, accepted, rejected, issues };
}

/** Convenience: gate then assemble only the accepted statements → NormalizedStatements. */
export function extractToStatements(raw: ExtractedFinancials, venue: string, ticker: string): {
  statements: NormalizedStatements;
  validation: ValidationResult;
} {
  const validation = validateExtraction(raw);
  const statements = assembleFromExtraction({ ...raw, statements: validation.accepted }, venue, ticker);
  return { statements, validation };
}

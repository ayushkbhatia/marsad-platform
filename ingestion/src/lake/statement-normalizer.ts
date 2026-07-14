/**
 * Statement normalizer — the shared hard part of P1.7b (plan §2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Every venue serves financial statements in a different messy shape (Mubasher's
 * label×year table, Yahoo's fundamentals-timeseries envelope, ADX/QE HTML tables,
 * MSX/BHB PDFs). The ratio job (key-ratios.ts / ratios-compute.ts) and the Score
 * downstream can only be a pure function of ONE canonical primitive schema. This
 * module is that contract: it maps each source onto the §3.1 primitive keys
 * written into public.financial_statements.line_items (jsonb) per period, so
 * everything downstream reads the SAME keys regardless of venue.
 *
 * HYBRID design (owner "max coverage"): deterministic rule-based mappers for the
 * STRUCTURED sources (Mubasher, Yahoo, and — via the same NormalizedStatements
 * target — ADX-native later); the LLM/PDF extraction path (P1.7d, MSX/BHB) is
 * OUT OF SCOPE here but is left a clearly-marked seam (normalizeViaLlm) so 7d can
 * slot an extractor onto the identical NormalizedStatements contract.
 *
 * PURITY: every export in this file is a PURE function of its input — no Date.now(),
 * no network, no I/O (CONTRACT §hard-rules). Golden-testable against the fixtures.
 *
 * §3.1 PRIMITIVE KEYS (07-lake-enrichment.md §3.1) — the canonical line_items:
 *   revenue (banks: total_operating_income), gross_profit, ebit, dep_amort,
 *   net_income, eps_diluted, equity, total_assets, total_debt, cash,
 *   capital_employed (= total_assets − current_liabilities), nii,
 *   avg_earning_assets (banks), dividends_paid; current_liabilities is also kept
 *   because capital_employed is derived from it.
 * Every value numeric|null; an absent source line is omitted, never guessed.
 */

import { fromYahooSymbol } from '../adapters/yahoo/symbols.js';

/** The three statement families public.financial_statements.statement_type checks. */
export type StatementType = 'income' | 'balance' | 'cashflow';

/** public.financial_statements.period_kind check ('quarter'|'annual'|'ttm'). */
export type PeriodKind = 'quarter' | 'annual' | 'ttm';

/** One normalized period → one public.financial_statements row (0006 DDL columns). */
export interface NormalizedPeriod {
  periodKind: PeriodKind;
  fiscalPeriod: string; // → fiscal_period, e.g. 'FY2023' or '2023-Q4'
  periodEnd: string; // 'YYYY-MM-DD' → period_end
  currency: string; // char(3) → currency
  statementType: StatementType;
  lineItems: Record<string, number | null>; // → line_items (jsonb), the §3.1 primitive keys
}

/** All normalized periods for one security from one source. */
export interface NormalizedStatements {
  venue: string;
  ticker: string;
  periods: NormalizedPeriod[];
}

/** The §3.1 canonical primitive keys — the single vocabulary line_items may use. */
export const PRIMITIVE_KEYS = [
  'revenue',
  'gross_profit',
  'ebit',
  'dep_amort',
  'net_income',
  'eps_diluted',
  'equity',
  'total_assets',
  'total_debt',
  'cash',
  'capital_employed',
  'current_liabilities',
  'nii',
  'avg_earning_assets',
  'dividends_paid',
] as const;

export type PrimitiveKey = (typeof PRIMITIVE_KEYS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Numeric coercion (PURE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a source cell → number | null. Handles the Mubasher comma-thousands
 * strings ("2,516,431,000"), a leading currency/sign, blanks and dashes. A
 * genuine 0 survives; anything non-finite (or an absent line) is null, never a
 * guess (CONTRACT: missing input ⇒ null).
 */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (s === '' || s === '-' || s === '—' || s === 'N/A' || s === 'n/a') return null;
  // Parenthesised negatives: "(1,234)" → -1234 (accounting convention).
  let sign = 1;
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1;
    s = s.slice(1, -1);
  }
  // Strip thousands separators, stray currency glyphs and a trailing percent.
  s = s.replace(/,/g, '').replace(/[^0-9.+-]/g, '');
  if (s === '' || s === '-' || s === '+' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

/** Drop null-valued keys so a period's line_items only ever carries known facts. */
function pruneNulls(items: Record<string, number | null>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, val] of Object.entries(items)) {
    if (val !== null) out[k] = val;
  }
  return out;
}

/** capital_employed = total_assets − current_liabilities (§3.1 derived), else null. */
function capitalEmployed(totalAssets: number | null, currentLiabilities: number | null): number | null {
  if (totalAssets === null || currentLiabilities === null) return null;
  const v = totalAssets - currentLiabilities;
  return Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mubasher /financial-statements  (TDWL/ADX — label×year table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row-label → primitive key map for the verbatim Mubasher /financial-statements
 * shape (07 §2.2). Only the rows Mubasher actually serves are here; a row not in
 * this map is ignored (never guessed onto a primitive). Labels are matched after
 * lower-casing + collapsing whitespace, so casing/spacing drift is tolerated.
 */
const MUBASHER_ROW_MAP: Record<string, { key: PrimitiveKey; statement: StatementType }> = {
  "total assets": { key: 'total_assets', statement: 'balance' },
  "total owners' equity": { key: 'equity', statement: 'balance' },
  'total owners equity': { key: 'equity', statement: 'balance' },
  'net income or loss': { key: 'net_income', statement: 'income' },
  'gross profit': { key: 'gross_profit', statement: 'income' },
};

interface MubasherStatementRow {
  label?: unknown;
  values?: unknown;
}

interface MubasherStatementDoc {
  exchange?: unknown;
  code?: unknown;
  currency?: unknown;
  columns?: unknown;
  rows?: unknown;
}

function normLabel(label: unknown): string {
  return typeof label === 'string' ? label.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/** Fiscal-period label + Dec-31 period-end from a Mubasher year column ("2023"). */
function annualPeriodFromYear(year: string): { fiscalPeriod: string; periodEnd: string } {
  return { fiscalPeriod: `FY${year}`, periodEnd: `${year}-12-31` };
}

/**
 * PURE. Mubasher /financial-statements JSON (or its already-parsed rows) → the
 * canonical NormalizedStatements. Each YEAR column becomes one annual period;
 * every mapped row lands its value under the §3.1 primitive key. Statement rows
 * that Mubasher does not serve (ebit, cash, debt…) are simply absent from
 * line_items (null-pruned) — best-effort, never guessed.
 *
 * NOTE ON GRANULARITY: Mubasher's table is a MIXED-statement view (assets +
 * equity + net income + gross profit + cashflow rows share one grid). We split
 * per year and, because the ratio job reads all line_items for a period
 * regardless of statement_type, we emit ONE NormalizedPeriod per (year) carrying
 * the balance+income primitives together under statementType 'income' with the
 * balance-sheet keys included — the persist layer (7b) may re-split by
 * statement_type; the primitive contract only requires the keys to be present and
 * correctly valued. capital_employed stays null here (Mubasher has no current
 * liabilities line).
 */
export function normalizeMubasherStatements(raw: unknown): NormalizedStatements {
  const doc = (raw ?? {}) as MubasherStatementDoc;
  const venue = typeof doc.exchange === 'string' ? doc.exchange : '';
  const ticker = typeof doc.code === 'string' ? doc.code : String(doc.code ?? '');
  const currency = typeof doc.currency === 'string' && doc.currency.trim() !== '' ? doc.currency : 'SAR';
  const columns = Array.isArray(doc.columns) ? doc.columns.map((c) => String(c)) : [];
  const rows = Array.isArray(doc.rows) ? (doc.rows as MubasherStatementRow[]) : [];

  if (columns.length === 0 || rows.length === 0) {
    return { venue, ticker, periods: [] };
  }

  // Accumulate primitives per year-column index.
  const perColumn: Record<string, number | null>[] = columns.map(() => ({}));

  for (const row of rows) {
    const mapping = MUBASHER_ROW_MAP[normLabel(row.label)];
    if (!mapping) continue; // unmapped row → ignored, never guessed
    const values = Array.isArray(row.values) ? row.values : [];
    for (let i = 0; i < columns.length; i++) {
      perColumn[i]![mapping.key] = toNumberOrNull(values[i]);
    }
  }

  const periods: NormalizedPeriod[] = [];
  for (let i = 0; i < columns.length; i++) {
    const { fiscalPeriod, periodEnd } = annualPeriodFromYear(columns[i]!);
    const items = perColumn[i]!;
    // capital_employed derivable only if current_liabilities present (Mubasher: absent → null).
    items.capital_employed = capitalEmployed(items.total_assets ?? null, items.current_liabilities ?? null);
    periods.push({
      periodKind: 'annual',
      fiscalPeriod,
      periodEnd,
      currency,
      statementType: 'income',
      lineItems: pruneNulls(items),
    });
  }

  return { venue, ticker, periods };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mubasher /ratios  (TDWL/ADX — flat headline ratios)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mubasher /ratios label → a stable snake_case key. Kept separate from the
 * statement primitives: these are pre-computed HEADLINE ratios (a cross-check
 * source for our own ratios-compute.ts output, per 07 §2.2), not line items.
 */
const MUBASHER_RATIO_MAP: Record<string, string> = {
  'roe %': 'roe',
  'roa %': 'roa',
  'eps': 'eps',
  'net profit growth %': 'net_profit_growth',
  'total assets growth %': 'total_assets_growth',
  'book value growth %': 'book_value_growth',
  'eps growth %': 'eps_growth',
  'cash from operations growth %': 'cash_from_operations_growth',
};

interface MubasherRatiosDoc {
  ratios?: unknown;
}

/**
 * PURE. Mubasher /ratios JSON → a flat Record of snake_case ratio → number|null.
 * Percent labels are carried as reported (31.37 means 31.37%, not 0.3137) so the
 * cross-check compares like-for-like with the source display. Unknown labels are
 * dropped. Accepts either the wrapped `{ ratios: {...} }` shape or a bare object.
 */
export function normalizeMubasherRatios(raw: unknown): Record<string, number | null> {
  const doc = (raw ?? {}) as MubasherRatiosDoc;
  const src =
    doc.ratios && typeof doc.ratios === 'object'
      ? (doc.ratios as Record<string, unknown>)
      : ((raw ?? {}) as Record<string, unknown>);
  const out: Record<string, number | null> = {};
  for (const [label, value] of Object.entries(src)) {
    const key = MUBASHER_RATIO_MAP[label.trim().toLowerCase().replace(/\s+/g, ' ')];
    if (!key) continue;
    out[key] = toNumberOrNull(value);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo fundamentals-timeseries  (TDWL/DFM/QE — standardized envelope)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yahoo metricKey → primitive key. Yahoo prefixes the reporting granularity
 * (annual / quarterly / trailing) onto a standardized metric name; we key off
 * the suffix (the part after the prefix) so both cadences map to the same
 * primitive.
 */
const YAHOO_METRIC_MAP: Record<string, { key: PrimitiveKey; statement: StatementType }> = {
  TotalRevenue: { key: 'revenue', statement: 'income' },
  TotalOperatingIncome: { key: 'revenue', statement: 'income' }, // banks
  GrossProfit: { key: 'gross_profit', statement: 'income' },
  OperatingIncome: { key: 'ebit', statement: 'income' },
  EBIT: { key: 'ebit', statement: 'income' },
  NetIncome: { key: 'net_income', statement: 'income' },
  DilutedEPS: { key: 'eps_diluted', statement: 'income' },
  TotalAssets: { key: 'total_assets', statement: 'balance' },
  StockholdersEquity: { key: 'equity', statement: 'balance' },
  TotalEquityGrossMinorityInterest: { key: 'equity', statement: 'balance' },
  CurrentLiabilities: { key: 'current_liabilities', statement: 'balance' },
  TotalDebt: { key: 'total_debt', statement: 'balance' },
  CashAndCashEquivalents: { key: 'cash', statement: 'balance' },
  ReconciledDepreciation: { key: 'dep_amort', statement: 'cashflow' },
  CashDividendsPaid: { key: 'dividends_paid', statement: 'cashflow' },
};

/** Yahoo granularity prefix → our PeriodKind. Anything else → 'annual' fallback. */
function yahooPeriodKind(metricType: string): PeriodKind | null {
  if (metricType.startsWith('annual')) return 'annual';
  if (metricType.startsWith('quarterly')) return 'quarter';
  if (metricType.startsWith('trailing')) return 'ttm';
  return null;
}

/** Strip the granularity prefix off a Yahoo metric type → the standardized name. */
function yahooMetricSuffix(metricType: string): string {
  return metricType.replace(/^(annual|quarterly|trailing)/, '');
}

interface YahooTsObservation {
  asOfDate?: unknown;
  currencyCode?: unknown;
  reportedValue?: { raw?: unknown } | null;
}

interface YahooTsResult {
  meta?: { symbol?: unknown; type?: unknown } | null;
  [metricKey: string]: unknown;
}

interface YahooTsEnvelope {
  timeseries?: { result?: unknown } | null;
}

/** Build the fiscalPeriod label from a period kind + an 'YYYY-MM-DD' asOfDate. */
function yahooFiscalPeriod(kind: PeriodKind, asOfDate: string): string {
  const year = asOfDate.slice(0, 4);
  if (kind === 'annual') return `FY${year}`;
  if (kind === 'ttm') return `TTM-${asOfDate}`;
  return asOfDate; // quarter: keep the exact period-end as the label
}

/**
 * PURE. Yahoo fundamentals-timeseries envelope → canonical NormalizedStatements.
 * Each result carries ONE metric across several periods (asOfDate); we transpose
 * to one NormalizedPeriod per (periodKind, periodEnd) accumulating every mapped
 * metric's value. venue+ticker are recovered from meta.symbol via the shared
 * Yahoo symbol map (suffix stripped → our venue/ticker), so this ties into the
 * same identity the Yahoo quote/OHLCV adapters use. Malformed/empty → no periods.
 */
export function normalizeYahooTimeseries(raw: unknown): NormalizedStatements {
  let doc: YahooTsEnvelope;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw) as YahooTsEnvelope;
    } catch {
      return { venue: '', ticker: '', periods: [] };
    }
  } else {
    doc = (raw ?? {}) as YahooTsEnvelope;
  }

  const results = doc?.timeseries?.result;
  if (!Array.isArray(results) || results.length === 0) {
    return { venue: '', ticker: '', periods: [] };
  }

  let venue = '';
  let ticker = '';

  // Accumulate: key = `${periodKind}|${periodEnd}` → the building period.
  const byPeriod = new Map<
    string,
    { periodKind: PeriodKind; periodEnd: string; currency: string; items: Record<string, number | null> }
  >();

  for (const result of results as YahooTsResult[]) {
    if (result === null || typeof result !== 'object') continue;
    const type = firstString(result.meta?.type);
    if (!type) continue;

    // Recover identity once, from the first usable symbol.
    if (venue === '') {
      const parsed = fromYahooSymbol(firstString(result.meta?.symbol) ?? '');
      if (parsed) {
        venue = parsed.venue;
        ticker = parsed.ticker;
      }
    }

    const kind = yahooPeriodKind(type);
    const mapping = YAHOO_METRIC_MAP[yahooMetricSuffix(type)];
    if (kind === null || !mapping) continue; // unmapped metric or unknown cadence → ignored

    const observations = result[type];
    if (!Array.isArray(observations)) continue;

    for (const obs of observations as YahooTsObservation[]) {
      if (obs === null || typeof obs !== 'object') continue;
      const asOfDate = typeof obs.asOfDate === 'string' ? obs.asOfDate : null;
      if (!asOfDate) continue;
      const value = toNumberOrNull(obs.reportedValue?.raw);
      const currency = typeof obs.currencyCode === 'string' && obs.currencyCode.trim() !== '' ? obs.currencyCode : 'USD';

      const pkey = `${kind}|${asOfDate}`;
      let bucket = byPeriod.get(pkey);
      if (!bucket) {
        bucket = { periodKind: kind, periodEnd: asOfDate, currency, items: {} };
        byPeriod.set(pkey, bucket);
      }
      bucket.items[mapping.key] = value;
    }
  }

  const periods: NormalizedPeriod[] = [];
  for (const bucket of byPeriod.values()) {
    bucket.items.capital_employed = capitalEmployed(
      bucket.items.total_assets ?? null,
      bucket.items.current_liabilities ?? null,
    );
    periods.push({
      periodKind: bucket.periodKind,
      fiscalPeriod: yahooFiscalPeriod(bucket.periodKind, bucket.periodEnd),
      periodEnd: bucket.periodEnd,
      currency: bucket.currency,
      statementType: 'income',
      lineItems: pruneNulls(bucket.items),
    });
  }
  // Deterministic ordering: newest period first (period_end desc), stable across runs.
  periods.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));

  return { venue, ticker, periods };
}

/** First string of a value that may be a Yahoo `[...]`-wrapped meta field or a bare string. */
function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === 'string');
    return typeof first === 'string' ? first : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TTM derivation  (trailing-4-quarter sums for flows + latest for balance)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §3.1 keys that are FLOWS (summed over trailing 4 quarters for TTM). Everything
 * else is a STOCK/balance level, carried from the LATEST quarter. eps_diluted is a
 * flow (per-period EPS sums to a trailing EPS). Ratios like capital_employed are
 * re-derived from the TTM balance levels, not summed.
 */
const FLOW_KEYS = new Set<PrimitiveKey>([
  'revenue',
  'gross_profit',
  'ebit',
  'dep_amort',
  'net_income',
  'eps_diluted',
  'nii',
  'dividends_paid',
]);

/**
 * PURE. Given a security's periods, derive a TTM NormalizedPeriod from the four
 * most-recent QUARTERS: flows summed, balance levels taken from the latest
 * quarter, capital_employed re-derived. Returns the ADDED ttm rows only (empty
 * when fewer than 4 quarters exist — no synthetic TTM from thin data). A flow key
 * missing in ANY of the 4 quarters yields null for that key (never a partial sum
 * masquerading as a full year). Deterministic period-end = the latest quarter's.
 */
export function deriveTtm(periods: NormalizedPeriod[]): NormalizedPeriod[] {
  const quarters = periods
    .filter((p) => p.periodKind === 'quarter')
    .slice()
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));

  if (quarters.length < 4) return [];

  const window = quarters.slice(0, 4);
  const latest = window[0]!;
  const items: Record<string, number | null> = {};

  for (const key of PRIMITIVE_KEYS) {
    if (key === 'capital_employed') continue; // re-derived below
    if (FLOW_KEYS.has(key)) {
      // Sum across all 4 quarters; any missing quarter ⇒ null (no partial TTM flow).
      let sum = 0;
      let allPresent = true;
      for (const q of window) {
        const v = q.lineItems[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          allPresent = false;
          break;
        }
        sum += v;
      }
      items[key] = allPresent ? sum : null;
    } else {
      // Stock/balance level: the latest quarter's value.
      const v = latest.lineItems[key];
      items[key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
  }
  items.capital_employed = capitalEmployed(items.total_assets ?? null, items.current_liabilities ?? null);

  return [
    {
      periodKind: 'ttm',
      fiscalPeriod: `TTM-${latest.periodEnd}`,
      periodEnd: latest.periodEnd,
      currency: latest.currency,
      statementType: latest.statementType,
      lineItems: pruneNulls(items),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation harness — the fixed target adapters + the LLM PDF path must satisfy
// ─────────────────────────────────────────────────────────────────────────────

export interface StatementValidation {
  ok: boolean;
  missingRequired: string[];
  warnings: string[];
}

/** Required primitive keys per statement type (07 §3.1; cashflow has no hard floor). */
const REQUIRED_BY_TYPE: Record<StatementType, PrimitiveKey[]> = {
  income: ['revenue', 'net_income'],
  balance: ['total_assets', 'equity'],
  cashflow: [],
};

/**
 * PURE. Validate ONE normalized period against the primitive contract: the
 * required-by-statement-type keys must be present AND non-null. Missing required
 * keys ⇒ ok:false + the list. Warnings flag soft issues (empty line_items, an
 * unknown key that is not a §3.1 primitive) without failing — the LLM/PDF path
 * (7d) and the venue adapters both aim at this fixed target.
 */
export function validateNormalizedPeriod(p: NormalizedPeriod): StatementValidation {
  const missingRequired: string[] = [];
  const warnings: string[] = [];

  const required = REQUIRED_BY_TYPE[p.statementType] ?? [];
  for (const key of required) {
    const v = p.lineItems[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) missingRequired.push(key);
  }

  if (Object.keys(p.lineItems).length === 0) warnings.push('empty line_items');
  if (!p.currency || p.currency.length !== 3) warnings.push('currency not a 3-letter code');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.periodEnd)) warnings.push('period_end not YYYY-MM-DD');

  const known = new Set<string>(PRIMITIVE_KEYS);
  for (const key of Object.keys(p.lineItems)) {
    if (!known.has(key)) warnings.push(`non-primitive key: ${key}`);
  }

  return { ok: missingRequired.length === 0, missingRequired, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM / PDF seam  (OUT OF SCOPE here — P1.7d PDF pipeline)
// ─────────────────────────────────────────────────────────────────────────────

/** A raw statement document handed to the (future) LLM extractor. */
export interface RawStatementDoc {
  kind: 'html' | 'json' | 'pdf_text';
  body: string;
}

/**
 * SEAM for the P1.7d LLM/PDF extraction path (MSX/BHB and any statement served
 * only as PDF). It is intentionally NOT implemented here — no PDF pipeline exists
 * yet — but it is declared against the SAME NormalizedStatements contract so 7d
 * can drop an LLM extractor in without touching any downstream consumer. Throws
 * so a caller wiring it prematurely fails loudly rather than silently emitting
 * empty statements.
 */
export function normalizeViaLlm(_doc: RawStatementDoc): never {
  throw new Error('not implemented (P1.7d PDF pipeline)');
}

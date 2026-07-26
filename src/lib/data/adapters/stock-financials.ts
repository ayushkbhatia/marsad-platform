import type { CagrBlock, Financials, KeyValRow, StockFinRow } from "@/lib/contracts/stock";
import type { FinancialStatementRow } from "@/lib/data/financials";
import { currencyLabel, fmtSignedPct } from "@/lib/reader/format";

/**
 * ADAPTER — `v_financials_public` rows → the frozen `Financials` contract (3b).
 *
 * Law #1 (BRIDGE-BUILD-PLAN §0.1): the contract is the spec. Nothing here edits
 * a view-model field to fit a DB column; anything the free cut cannot serve is
 * either rendered `—` or the row is omitted, and the gap is stated in the note
 * strings the design already reserves for provenance.
 *
 * Every `Financials` field is a pre-formatted STRING — thousands separators and
 * units are baked in HERE, never in the component.
 *
 * WHAT THIS ADAPTER CAN AND CANNOT FILL (all measured, none invented):
 * - `quarterlyPeriods` — 4 (design shows 8). The free cut is 4 quarters; the
 *   older four are premium. No estimate column: `is_estimate` is false on every
 *   row in the base table, so the design's "Jun '26E" desk-estimate column has
 *   no producer and is simply absent (`DEF-ESTIMATES-AGG`).
 * - `annualPeriods` — 2 (design shows 10 incl. TTM). Deep annual history and TTM
 *   are premium / not computable from a 2-period window.
 * - `annualRows` — no DPS or Payout rows: `dividends` is 100% `pending_confirm`
 *   and therefore invisible to anon (`DEF-DIVIDENDS-CONFIRM`). Rows are OMITTED
 *   rather than filled with a row of dashes.
 * - `cagr` — the design's 3Y/5Y/8Y CAGR, stock-price CAGR and ROE series need
 *   deep annual history and a price series this surface does not read. Only the
 *   FY-over-FY growth and the margins that the 2 free annual periods genuinely
 *   support are computed; the multi-year block renders `—`.
 * - `StockFinRow.pdf` — left unset. The free cut carries no `source_filing_id`,
 *   and the component renders the flag as static text, not a link.
 * - EPS — omitted entirely when the view withheld it (TDWL, DEF-TDWL-EPS-MAPPING);
 *   the suppression is called out in `quarterlyNote` so the absence is visible.
 * - Free cash flow — NOT derived. `capex` sign conventions are unnormalised
 *   upstream (both signs occur), so a computed FCF would be a coin flip.
 */

// ── formatting ───────────────────────────────────────────────────────────────

/** Typographic minus (U+2212) for negatives, matching the design's number set. */
function typographicMinus(s: string): string {
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}

/**
 * Filed absolute figures are in units of the filing currency; the statement
 * tables are denominated in MILLIONS. Precision steps down as magnitude grows so
 * a 2.5tn balance sheet and a 40mn line both stay readable.
 */
function fmtMn(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const mn = n / 1e6;
  const abs = Math.abs(mn);
  const frac = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return typographicMinus(
    mn.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac }),
  );
}

/** Unsigned 1-decimal percentage (margins, ratios). */
function fmtPct1(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${typographicMinus(n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))}%`;
}

/** Per-share figures keep 2–4 decimals; they are never scaled to millions. */
function fmtPerShare(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return typographicMinus(
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
  );
}

function ratioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

function growthPct(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** `Q2 2026` → `Q2 '26`; `2025` → `FY25`. Falls back to the filed label. */
function periodLabel(fiscalPeriod: string, kind: "quarter" | "annual"): string {
  const raw = (fiscalPeriod ?? "").trim();
  if (kind === "annual") {
    const m = /^(\d{4})$/.exec(raw);
    return m ? `FY${m[1].slice(2)}` : raw || "—";
  }
  const m = /^(Q[1-4])\s+(\d{4})$/i.exec(raw);
  return m ? `${m[1].toUpperCase()} '${m[2].slice(2)}` : raw || "—";
}

// ── row assembly ─────────────────────────────────────────────────────────────

type Num = (r: FinancialStatementRow | undefined) => number | null;

/** Build one contract row across the period series; drop it when every cell is empty. */
function finRow(
  label: string,
  series: Array<FinancialStatementRow | undefined>,
  pick: Num,
  format: (n: number | null) => string,
  strong = false,
): StockFinRow | null {
  const values = series.map((r) => format(pick(r)));
  if (values.every((v) => v === "—")) return null;
  return strong ? { label, strong: true, values } : { label, values };
}

function keyVal(label: string, value: string): KeyValRow | null {
  return value === "—" ? null : { label, value };
}

function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

/**
 * Index the rows of one `periodKind` by rank, oldest → newest, so the contract's
 * period columns and value arrays are guaranteed to line up.
 */
function seriesFor(
  rows: FinancialStatementRow[],
  kind: "quarter" | "annual",
  statement: "income" | "balance" | "cashflow",
  ranks: number[],
): Array<FinancialStatementRow | undefined> {
  return ranks.map((rank) =>
    rows.find(
      (r) => r.periodKind === kind && r.statementType === statement && r.periodRank === rank,
    ),
  );
}

function ranksPresent(rows: FinancialStatementRow[], kind: "quarter" | "annual"): number[] {
  const set = new Set(rows.filter((r) => r.periodKind === kind).map((r) => r.periodRank));
  // Descending rank = newest first; the contract renders oldest → newest.
  return [...set].sort((a, b) => b - a);
}

function labelForRank(
  rows: FinancialStatementRow[],
  kind: "quarter" | "annual",
  rank: number,
): string {
  const row = rows.find((r) => r.periodKind === kind && r.periodRank === rank);
  return row ? periodLabel(row.fiscalPeriod, kind) : "—";
}

// ── the adapter ──────────────────────────────────────────────────────────────

/**
 * Map free-tier statement rows to the `Financials` contract. Returns `null` when
 * the rows cannot produce a usable P&L (no revenue and no net income anywhere) —
 * the caller then falls back to the sample rather than blanking a finished
 * screen (D-7, transitional).
 */
export function toStockFinancials(rows: FinancialStatementRow[]): Financials | null {
  if (rows.length === 0) return null;

  const currency = currencyLabel(rows[0].currency) || "—";
  const unit = `${currency} MN`;
  const epsSuppressed = rows.some((r) => r.epsSuppressed);

  const qRanks = ranksPresent(rows, "quarter");
  const aRanks = ranksPresent(rows, "annual");

  const quarterlyPeriods = qRanks.map((rank) => labelForRank(rows, "quarter", rank));
  const annualPeriods = aRanks.map((rank) => labelForRank(rows, "annual", rank));

  const qIncome = seriesFor(rows, "quarter", "income", qRanks);
  const aIncome = seriesFor(rows, "annual", "income", aRanks);

  const quarterlyRows = compact<StockFinRow>([
    finRow("Revenue", qIncome, (r) => r?.revenue ?? null, fmtMn, true),
    finRow("Cost of sales", qIncome, (r) => r?.costOfSales ?? null, fmtMn),
    finRow("Gross profit", qIncome, (r) => r?.grossProfit ?? null, fmtMn),
    finRow("Operating profit", qIncome, (r) => r?.ebit ?? null, fmtMn, true),
    finRow("OPM %", qIncome, (r) => ratioPct(r?.ebit ?? null, r?.revenue ?? null), fmtPct1),
    finRow("Finance costs", qIncome, (r) => r?.financeCosts ?? null, fmtMn),
    finRow("Profit before tax", qIncome, (r) => r?.profitBeforeTax ?? null, fmtMn),
    finRow("Zakat & tax", qIncome, (r) => r?.incomeTaxExpense ?? null, fmtMn),
    finRow("Net profit", qIncome, (r) => r?.netIncome ?? null, fmtMn, true),
    finRow("Net margin %", qIncome, (r) => ratioPct(r?.netIncome ?? null, r?.revenue ?? null), fmtPct1),
    epsSuppressed
      ? null
      : finRow(`EPS (${currency})`, qIncome, (r) => r?.epsBasic ?? r?.epsDiluted ?? null, fmtPerShare),
  ]);

  const annualRows = compact<StockFinRow>([
    finRow("Revenue", aIncome, (r) => r?.revenue ?? null, fmtMn, true),
    finRow("Operating profit", aIncome, (r) => r?.ebit ?? null, fmtMn, true),
    finRow("OPM %", aIncome, (r) => ratioPct(r?.ebit ?? null, r?.revenue ?? null), fmtPct1),
    finRow("Net profit", aIncome, (r) => r?.netIncome ?? null, fmtMn, true),
    finRow("Net margin %", aIncome, (r) => ratioPct(r?.netIncome ?? null, r?.revenue ?? null), fmtPct1),
    epsSuppressed
      ? null
      : finRow(`EPS (${currency})`, aIncome, (r) => r?.epsBasic ?? r?.epsDiluted ?? null, fmtPerShare),
  ]);

  if (quarterlyRows.length === 0 && annualRows.length === 0) return null;

  // ── CAGR / growth block. Only what 2 annual + 4 quarterly periods support. ──
  const latestFy = aIncome[aIncome.length - 1];
  const priorFy = aIncome[aIncome.length - 2];
  const latestQ = qIncome[qIncome.length - 1];

  const cagr: CagrBlock[] = [
    {
      title: "Revenue growth",
      rows: [
        {
          label: annualPeriods.length >= 2 ? `${annualPeriods[annualPeriods.length - 1]} y/y` : "FY y/y",
          value: fmtSignedPct(growthPct(latestFy?.revenue ?? null, priorFy?.revenue ?? null)),
        },
      ],
    },
    {
      title: "Net profit growth",
      rows: [
        {
          label: annualPeriods.length >= 2 ? `${annualPeriods[annualPeriods.length - 1]} y/y` : "FY y/y",
          value: fmtSignedPct(growthPct(latestFy?.netIncome ?? null, priorFy?.netIncome ?? null)),
        },
      ],
    },
    {
      title: "Net margin",
      rows: [
        {
          label: "Latest FY",
          value: fmtPct1(ratioPct(latestFy?.netIncome ?? null, latestFy?.revenue ?? null)),
        },
        {
          label: "Latest quarter",
          value: fmtPct1(ratioPct(latestQ?.netIncome ?? null, latestQ?.revenue ?? null)),
        },
      ],
    },
    {
      // Honest degradation, not a blank: multi-year compounding needs deep annual
      // history, which is the premium cut.
      title: "Multi-year CAGR",
      rows: [
        { label: "3Y", value: "—" },
        { label: "5Y", value: "—" },
      ],
    },
  ];

  // ── Balance sheet: point-in-time, so the most recent period of ANY kind. ────
  const balanceRows = rows
    .filter((r) => r.statementType === "balance")
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));
  const balance = balanceRows[0];

  // ── Cash flow: ANNUAL only. Quarterly cash-flow filings are cumulative YTD for
  //    many filers while income rows are discrete — mixing them would misstate.
  const cashRows = rows
    .filter((r) => r.statementType === "cashflow" && r.periodKind === "annual")
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));
  const cash = cashRows[0];

  const quarterlyNote = [
    `CONSOLIDATED · ${unit} · AS FILED`,
    `${quarterlyPeriods.length} MOST RECENT QUARTERS — DEEPER HISTORY, SEGMENTS AND LINE-ITEM BREAK-UP ARE PREMIUM`,
    epsSuppressed
      ? "EPS WITHHELD ON TADAWUL FILINGS — PER-SHARE EXTRACTION DEFECT UNDER REPAIR (DEF-TDWL-EPS-MAPPING); NO ESTIMATE IS SHOWN IN ITS PLACE"
      : null,
    "NO DESK-ESTIMATE COLUMN — CONSENSUS/ESTIMATE PRODUCER NOT LIVE",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    // Per-entity currency + scale for the section headings. The component used
    // to hardcode "SAR MN", which mislabelled every non-Tadawul venue.
    currencyLabel: unit,
    quarterlyPeriods,
    quarterlyRows,
    quarterlyNote,
    annualPeriods,
    annualRows,
    cagr,
    balanceSheet: {
      rows: compact<KeyValRow>([
        keyVal("Total assets", fmtMn(balance?.totalAssets ?? null)),
        keyVal("Total liabilities", fmtMn(balance?.totalLiabilities ?? null)),
        keyVal("Shareholder equity", fmtMn(balance?.equity ?? null)),
        keyVal("Cash & equivalents", fmtMn(balance?.cash ?? null)),
        keyVal("Gross debt", fmtMn(balance?.totalDebt ?? null)),
      ]),
      note: balance
        ? `AS OF ${periodLabel(balance.fiscalPeriod, balance.periodKind)} · ${unit} · FULL BALANCE-SHEET HISTORY IS PREMIUM`
        : `${unit} · NO BALANCE SHEET IN THE FREE PERIOD WINDOW`,
    },
    cashFlow: {
      rows: compact<KeyValRow>([
        keyVal("Cash from operations", fmtMn(cash?.cfo ?? null)),
        keyVal("Cash from investing", fmtMn(cash?.cfi ?? null)),
        keyVal("Cash from financing", fmtMn(cash?.cff ?? null)),
        keyVal("Capex", fmtMn(cash?.capex ?? null)),
        keyVal("Depreciation & amortisation", fmtMn(cash?.depAmort ?? null)),
        keyVal("Dividends paid", fmtMn(cash?.dividendsPaid ?? null)),
      ]),
      note: cash
        ? `${periodLabel(cash.fiscalPeriod, cash.periodKind)} ANNUAL · ${unit} · SIGNS AS FILED — CAPEX/DIVIDEND CONVENTIONS ARE NOT NORMALISED UPSTREAM, SO FREE CASH FLOW IS NOT DERIVED`
        : `${unit} · NO ANNUAL CASH-FLOW STATEMENT IN THE FREE PERIOD WINDOW`,
    },
  };
}

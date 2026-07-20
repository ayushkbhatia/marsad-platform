/**
 * Key-ratio math — PURE (no I/O), unit-tested independently of the DB.
 *
 * Inputs are the latest VERIFIED fundamentals + the latest delayed quote for one
 * security; output is the flat public.key_ratios shape (02 §8). Every field is
 * best-effort: when an input is missing the ratio is null rather than a guess.
 * The screener scans this flat table, so nulls simply drop a security from the
 * corresponding filter — never a wrong number.
 *
 * Ratios we can derive from scrape-only fundamentals + delayed price:
 *   market_cap     = last * shares_outstanding
 *   eps_ttm        = trailing income (eps line, or net_income / shares)
 *   pe             = last / eps_ttm
 *   book_value_ps  = total_equity / shares_outstanding
 *   pb             = last / book_value_ps
 *   dividend_yield = trailing_dps / last
 *   payout_ratio   = trailing_dps / eps_ttm
 *   ps             = market_cap / ttm_revenue
 *   roe            = net_income_ttm / total_equity
 *   roce           = ebit_ttm / (total_assets - current_liabilities)
 *   nim            = net_interest_income_ttm / avg_earning_assets   (banks only)
 *   ev_ebitda      = (market_cap + net_debt) / ebitda_ttm
 *   net_debt_ebitda= net_debt / ebitda_ttm
 *   net_margin     = net_income_ttm / revenue_ttm
 *   gross_margin   = gross_profit_ttm / revenue_ttm   (null banks/insurers)
 *   rev/eps_growth_yoy = ttm / prior_year_ttm − 1
 *   rev/eps_cagr_3y    = (ttm / 3y_ago)^(1/3) − 1     (both > 0)
 *   ebitda_ttm     = ebit_ttm + dep_amort_ttm         (when no explicit ebitda)
 *   ret_3m/6m/12_1 = price momentum, precomputed from ohlcv_daily upstream
 * Ratio validity is sector-conditional (07 §3.3, owner D-1): banks/insurers NULL
 * gross_margin + ev_ebitda + net_debt_ebitda. Anything whose driver line item is
 * absent stays null.
 */

/** Latest-verified fundamentals for one security, flattened from the income /
 *  balance line_items jsonb (02 §8) plus trailing dividends. All optional. */
export interface RatioInputs {
  securityId: number;
  /** Latest delayed close/last from public.quotes_latest. */
  last: number | null;
  sharesOutstanding: number | null;
  /** Trailing-twelve-month figures pulled from financial_statements line_items. */
  epsTtm?: number | null;
  netIncomeTtm?: number | null;
  revenueTtm?: number | null;
  ebitTtm?: number | null;
  ebitdaTtm?: number | null;
  /** Gross profit (income) + D&A (cashflow) TTM — feed gross margin + EBITDA. */
  grossProfitTtm?: number | null;
  depAmortTtm?: number | null;
  totalEquity?: number | null;
  totalAssets?: number | null;
  currentLiabilities?: number | null;
  /** Balance-sheet debt + cash — derive net_debt = total_debt − cash. */
  totalDebt?: number | null;
  cash?: number | null;
  netDebt?: number | null;
  /** Prior-year TTM (for YoY growth) + 3y-ago annual (for 3Y CAGR). */
  revenueTtmPrior?: number | null;
  epsTtmPrior?: number | null;
  revenue3yAgo?: number | null;
  eps3yAgo?: number | null;
  /** Momentum returns, precomputed from ohlcv_daily by gatherInputs. */
  ret3m?: number | null;
  ret6m?: number | null;
  ret121?: number | null;
  /** Sum of live dividends over the trailing 12 months (per share). */
  trailingDps?: number | null;
  /** Bank-only: net interest income + average earning assets. */
  netInterestIncomeTtm?: number | null;
  avgEarningAssets?: number | null;
  /** Sector (drives ratio validity) + reporting currency of the statements. */
  sector?: string | null;
  currency?: string | null;
}

export interface KeyRatios {
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
  epsTtm: number | null;
  bookValuePs: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  roe: number | null;
  roce: number | null;
  nim: number | null;
  netDebtEbitda: number | null;
  evEbitda: number | null;
  ps: number | null;
  netMargin: number | null;
  grossMargin: number | null;
  revGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  revCagr3y: number | null;
  epsCagr3y: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret121: number | null;
  ebitdaTtm: number | null;
  currencyComputed: string | null;
}

const nn = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/** a / b, null unless both finite and b ≠ 0. */
function safeDiv(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

function mul(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const r = a * b;
  return Number.isFinite(r) ? r : null;
}

/** cur / prior − 1 — period-over-period growth, null unless both finite and prior ≠ 0. */
function growth(cur: number | null, prior: number | null): number | null {
  if (cur === null || prior === null || prior === 0) return null;
  const r = cur / prior - 1;
  return Number.isFinite(r) ? r : null;
}

/** (a / b)^(1/3) − 1 — 3-year CAGR, null unless both inputs are > 0. */
function cagr3y(ttm: number | null, ago: number | null): number | null {
  if (ttm === null || ago === null || ttm <= 0 || ago <= 0) return null;
  const r = Math.cbrt(ttm / ago) - 1;
  return Number.isFinite(r) ? r : null;
}

/** Which ratios a sector may carry (07 §3.3, owner D-1). Banks/insurers make
 *  gross margin + EV/EBITDA + net-debt/EBITDA meaningless (deposits are "debt");
 *  everything else — including 'unknown'/null — gets the full set. */
interface SectorValidity {
  grossMargin: boolean;
  evEbitda: boolean;
  netDebtEbitda: boolean;
}

function sectorValidity(sector: string | null): SectorValidity {
  if (sector !== null && /bank/i.test(sector)) {
    return { grossMargin: false, evEbitda: false, netDebtEbitda: false };
  }
  if (sector !== null && /insur/i.test(sector)) {
    return { grossMargin: false, evEbitda: false, netDebtEbitda: false };
  }
  return { grossMargin: true, evEbitda: true, netDebtEbitda: true };
}

export function computeKeyRatios(input: RatioInputs): KeyRatios {
  const last = nn(input.last);
  const shares = nn(input.sharesOutstanding);
  const netIncome = nn(input.netIncomeTtm);
  const revenue = nn(input.revenueTtm);
  const ebit = nn(input.ebitTtm);
  const equity = nn(input.totalEquity);
  const assets = nn(input.totalAssets);
  const curLiab = nn(input.currentLiabilities);
  const grossProfit = nn(input.grossProfitTtm);
  const depAmort = nn(input.depAmortTtm);
  const totalDebt = nn(input.totalDebt);
  const cash = nn(input.cash);
  const revenuePrior = nn(input.revenueTtmPrior);
  const revenue3yAgo = nn(input.revenue3yAgo);
  const eps3yAgo = nn(input.eps3yAgo);
  const dps = nn(input.trailingDps);
  const nii = nn(input.netInterestIncomeTtm);
  const earningAssets = nn(input.avgEarningAssets);

  const marketCap = mul(last, shares);
  // eps: explicit line wins; else derived from net income / shares. BELT (DEF-TDWL-EPS-MAPPING): reject an
  // implausible explicit eps — |eps| must be ≤ |net_income| / 1e6 (implied shares ≥ 1M) or it is a mis-tagged
  // net-income magnitude that leaked past the extractor guard. A rejected eps falls back to net_income/shares,
  // so a legacy garbage value can never produce pe ≈ 0 (which is in-range and would silently mis-rank a name).
  const rawEps = nn(input.epsTtm);
  const epsOk = rawEps !== null && (netIncome === null || Math.abs(rawEps) <= Math.abs(netIncome) / 1e6);
  const epsTtm = (epsOk ? rawEps : null) ?? safeDiv(netIncome, shares);
  const epsPrior = nn(input.epsTtmPrior);
  const bookValuePs = safeDiv(equity, shares);
  const capitalEmployed = assets !== null && curLiab !== null ? assets - curLiab : null;
  // ebitda: explicit line wins; else ebit + D&A (07 §3.2).
  const ebitda =
    nn(input.ebitdaTtm) ?? (ebit !== null && depAmort !== null ? ebit + depAmort : null);
  // net_debt: explicit line wins (back-compat); else total_debt − cash.
  const netDebt =
    nn(input.netDebt) ?? (totalDebt !== null && cash !== null ? totalDebt - cash : null);

  const valid = sectorValidity(input.sector ?? null);

  return {
    marketCap,
    epsTtm,
    pe: safeDiv(last, epsTtm),
    bookValuePs,
    pb: safeDiv(last, bookValuePs),
    dividendYield: safeDiv(dps, last),
    payoutRatio: safeDiv(dps, epsTtm),
    ps: safeDiv(marketCap, revenue),
    roe: safeDiv(netIncome, equity),
    roce: safeDiv(ebit, capitalEmployed),
    nim: safeDiv(nii, earningAssets),
    evEbitda:
      valid.evEbitda && marketCap !== null && netDebt !== null
        ? safeDiv(marketCap + netDebt, ebitda)
        : null,
    netDebtEbitda: valid.netDebtEbitda ? safeDiv(netDebt, ebitda) : null,
    netMargin: safeDiv(netIncome, revenue),
    grossMargin: valid.grossMargin ? safeDiv(grossProfit, revenue) : null,
    revGrowthYoy: growth(revenue, revenuePrior),
    epsGrowthYoy: growth(epsTtm, epsPrior),
    revCagr3y: cagr3y(revenue, revenue3yAgo),
    epsCagr3y: cagr3y(epsTtm, eps3yAgo),
    ret3m: nn(input.ret3m),
    ret6m: nn(input.ret6m),
    ret121: nn(input.ret121),
    ebitdaTtm: ebitda,
    currencyComputed: input.currency ?? null,
  };
}

/** True when at least one ratio is non-null — used to skip writing an all-null
 *  row (a security with no verified fundamentals yet stays absent from the
 *  screener scan target rather than as a row of nulls). currencyComputed is
 *  metadata, not a ratio, so it does not count towards "has a ratio". */
export function hasAnyRatio(r: KeyRatios): boolean {
  return Object.entries(r).some(([k, v]) => k !== 'currencyComputed' && v !== null);
}

/**
 * The public.key_ratios numeric(precision, scale) budget — MIRRORS THE DDL (0006
 * `key_ratios`, plus the later growth/momentum columns). A numeric(p,s) column
 * rejects any value whose absolute value is >= 10^(p-s): postgres raises
 * `numeric field overflow` and the INSERT takes the whole recompute down with it.
 *
 * Keep in sync with the DDL. A column added to key_ratios without a row here is
 * simply never range-checked (fail-open, same as today) — it is not silently
 * dropped.
 */
const COLUMN_NUMERIC: Partial<Record<keyof KeyRatios, readonly [precision: number, scale: number]>> = {
  marketCap: [20, 2],
  pe: [10, 3],
  pb: [10, 3],
  epsTtm: [12, 4],
  bookValuePs: [12, 4],
  dividendYield: [7, 4],
  payoutRatio: [7, 4],
  roe: [7, 4],
  roce: [7, 4],
  nim: [7, 4],
  netDebtEbitda: [8, 3],
  evEbitda: [10, 3],
  ps: [10, 3],
  netMargin: [7, 4],
  grossMargin: [7, 4],
  revGrowthYoy: [9, 4],
  epsGrowthYoy: [9, 4],
  revCagr3y: [9, 4],
  epsCagr3y: [9, 4],
  ret3m: [9, 4],
  ret6m: [9, 4],
  ret121: [9, 4],
  ebitdaTtm: [20, 2],
};

/** A ratio dropped for not fitting its column. Surfaced so the caller can LOG it —
 *  an out-of-range ratio is either a genuinely degenerate business (a shell with
 *  ~zero revenue) or an upstream extraction bug, and both deserve to be visible
 *  rather than to vanish into a null. */
export interface DroppedRatio {
  field: keyof KeyRatios;
  value: number;
  /** The exclusive absolute bound the value had to clear: 10^(precision-scale). */
  limit: number;
}

/**
 * Null every ratio that cannot be stored in its key_ratios column, and report what
 * was dropped.
 *
 * WHY NULL RATHER THAN CLAMP: this module's contract is "when an input is missing
 * the ratio is null rather than a guess … never a wrong number" — and the screener
 * scans this table, so a null simply drops the security from that filter. Clamping
 * net_margin to 999.9999 would instead assert a 99,999% margin and rank the name
 * FIRST on any high-margin screen. Null is the honest answer.
 *
 * WHY THIS IS NEEDED AT ALL: safeDiv only guards `b === 0`. A denominator that is
 * merely NEAR zero yields a huge FINITE number that passes every isFinite check and
 * then overflows on insert. Live example (2026-07-17): DFM ALFIRDOUS, a dormant
 * holding company, booked AED 647 of trailing revenue against ~3.66M of investment
 * income ⇒ net_margin 5,663.4 ⇒ numeric(7,4) overflow ⇒ the entire nightly recompute
 * died, and with no per-security isolation it took every other security's ratios
 * with it.
 */
export function fitToColumnBudget(r: KeyRatios): { ratios: KeyRatios; dropped: DroppedRatio[] } {
  const dropped: DroppedRatio[] = [];
  const ratios = { ...r };
  for (const [field, spec] of Object.entries(COLUMN_NUMERIC) as Array<
    [keyof KeyRatios, readonly [number, number]]
  >) {
    const value = ratios[field];
    if (typeof value !== 'number') continue;
    const limit = 10 ** (spec[0] - spec[1]);
    if (Math.abs(value) >= limit) {
      dropped.push({ field, value, limit });
      (ratios[field] as number | null) = null;
    }
  }
  return { ratios, dropped };
}

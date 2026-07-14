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
  // eps: explicit line wins; else derived from net income / shares.
  const epsTtm = nn(input.epsTtm) ?? safeDiv(netIncome, shares);
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

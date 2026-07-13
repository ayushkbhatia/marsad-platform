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
 * Anything whose driver line item is absent stays null.
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
  totalEquity?: number | null;
  totalAssets?: number | null;
  currentLiabilities?: number | null;
  netDebt?: number | null;
  /** Sum of live dividends over the trailing 12 months (per share). */
  trailingDps?: number | null;
  /** Bank-only: net interest income + average earning assets. */
  netInterestIncomeTtm?: number | null;
  avgEarningAssets?: number | null;
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

export function computeKeyRatios(input: RatioInputs): KeyRatios {
  const last = nn(input.last);
  const shares = nn(input.sharesOutstanding);
  const netIncome = nn(input.netIncomeTtm);
  const revenue = nn(input.revenueTtm);
  const ebit = nn(input.ebitTtm);
  const ebitda = nn(input.ebitdaTtm);
  const equity = nn(input.totalEquity);
  const assets = nn(input.totalAssets);
  const curLiab = nn(input.currentLiabilities);
  const netDebt = nn(input.netDebt);
  const dps = nn(input.trailingDps);
  const nii = nn(input.netInterestIncomeTtm);
  const earningAssets = nn(input.avgEarningAssets);

  const marketCap = mul(last, shares);
  // eps: explicit line wins; else derived from net income / shares.
  const epsTtm = nn(input.epsTtm) ?? safeDiv(netIncome, shares);
  const bookValuePs = safeDiv(equity, shares);
  const capitalEmployed = assets !== null && curLiab !== null ? assets - curLiab : null;

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
    evEbitda: marketCap !== null && netDebt !== null ? safeDiv(marketCap + netDebt, ebitda) : null,
    netDebtEbitda: safeDiv(netDebt, ebitda),
  };
}

/** True when at least one ratio is non-null — used to skip writing an all-null
 *  row (a security with no verified fundamentals yet stays absent from the
 *  screener scan target rather than as a row of nulls). */
export function hasAnyRatio(r: KeyRatios): boolean {
  return Object.values(r).some((v) => v !== null);
}

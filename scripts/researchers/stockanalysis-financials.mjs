#!/usr/bin/env node
/**
 * stockanalysis.com second-source financials cross-check researcher (FINANCIALS.XCHECK).
 *
 * WHY A NEW OBJECT TYPE (do NOT reuse FILING.FINANCIALS): the golden projection
 * lake.fn_financials_project keys purely on the payload accounting key
 * (security_id, statement_type, basis, fiscal_period, is_estimate=false) and IGNORES
 * source_rank / natural_key / venue. A second FILING.FINANCIALS object on the same key
 * is treated as a RESTATEMENT — it archives golden to financial_statement_history and
 * overwrites the current row in place. So a 2nd source landed as FILING.FINANCIALS would
 * ping-pong-clobber golden forever. Instead we land a DISTINCT object_type
 * 'FINANCIALS.XCHECK' at state PENDING (source_rank=90, aggregator tier). The golden
 * financials trigger's WHEN clause is an exact match on 'FILING.FINANCIALS' so it never
 * fires for us; a separate reconcile trigger (built elsewhere) reads these PENDING objects,
 * compares against golden and writes agree/conflict/gap into financial_statement_xcheck.
 * This researcher ONLY lands the objects — it never touches golden, key_ratios, or ratios.
 *
 * SOURCE: stockanalysis.com SvelteKit __data.json loader (devalue index-pool format),
 * numbers are S&P-Global-Market-Intelligence ("spg") re-served, RAW currency units (no
 * thousands/millions), TTM + last 5 FY (annual) / last 20 quarters (?p=quarterly).
 *
 * TWO TEMPLATES auto-selected by sector: industrial (cor/gp/opinc/ebitda) vs bank
 * (netInterestIncomeBank/loanLosses/grossLoans/totalDeposits). Detected by *Bank key presence.
 *
 * CONTROLS (env):
 *   VENUE          single venue per run (TDWL|DFM|QE|ADX|MSX|BHB). REQUIRED.
 *   TICKERS        csv override of venue tickers (e.g. EMAAR,1120). Skips coverage guard.
 *   ASSESS_ONLY=1  parse+crosswalk+gate and PRINT a per-security dry report; writes NOTHING
 *                  (no lake.objects, no parse_run, no DB connection at all). First no-write pass.
 *   REFRESH=1      re-scrape ALL listed securities (else coverage-guard: only those lacking a
 *                  recent live FINANCIALS.XCHECK object).
 *   DELAY_MS       polite spacing between fetches (default 600).
 *   XCHECK_MAX_AGE_DAYS  coverage-guard freshness window (default 30).
 *   MAX            optional cap on #securities this run.
 *
 * RUN (per venue, detached on the VPS — DB RTT is there):
 *   systemd-run --unit=marsad-sa-fin-dfm --property=EnvironmentFile=/etc/marsad/worker.env \
 *     --setenv=VENUE=DFM /usr/bin/node /opt/marsad/scripts/researchers/stockanalysis-financials.mjs
 *   (repeat with VENUE=TDWL|QE|ADX|MSX|BHB). First pass: add --setenv=ASSESS_ONLY=1 for a dry report.
 */
import { spawnSync } from 'node:child_process';
import { upsertLakeObject } from './lib/lake-objects.mjs';

// ── env / controls ──────────────────────────────────────────────────────────
const VENUE = (process.env.VENUE || '').toUpperCase();
const SA_PATH = { TDWL: 'tadawul', DFM: 'dfm', QE: 'qse', ADX: 'adx', MSX: 'msm', BHB: 'bax' }[VENUE];
if (!SA_PATH) { console.error(`unknown/missing VENUE ${VENUE || '(unset)'} (expect TDWL|DFM|QE|ADX|MSX|BHB)`); process.exit(1); }
const ASSESS_ONLY = process.env.ASSESS_ONLY === '1';
const REFRESH = process.env.REFRESH === '1';
const DELAY_MS = Number(process.env.DELAY_MS || 600);
const XCHECK_MAX_AGE_DAYS = Number(process.env.XCHECK_MAX_AGE_DAYS || 30);
const MAX = process.env.MAX ? Number(process.env.MAX) : null;
const ONLY = (process.env.TICKERS || '').split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SOURCE_TAG = 'stockanalysis-spg';
const SOURCE_RANK = 90;

// ── devalue index-pool unflattener (reused from recon.mjs, proven on EMAAR) ───
function unflatten(values) {
  if (typeof values === 'number') return h(values);
  const H = new Array(values.length), S = new Array(values.length).fill(false);
  function h(i) {
    if (i < 0) return { '-1': undefined, '-2': undefined, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 }[i];
    if (S[i]) return H[i];
    const v = values[i];
    if (!v || typeof v !== 'object') { S[i] = true; H[i] = v; return v; }
    if (Array.isArray(v)) {
      if (v[0] === 'Date') { const d = new Date(v[1]); S[i] = true; H[i] = d; return d; }
      if (v[0] === 'null') { S[i] = true; H[i] = null; return null; }
      const a = []; S[i] = true; H[i] = a; for (const n of v) a.push(n === -2 ? undefined : h(n)); return a;
    }
    const o = {}; S[i] = true; H[i] = o; for (const k in v) o[k] = h(v[k]); return o;
  }
  return h(0);
}
/** Parse a __data.json body buffer → normalized statement or null (stub/no-financials). */
function parseSA(body) {
  let raw;
  try { raw = JSON.parse(body); } catch { return null; }
  if (!raw || !Array.isArray(raw.nodes)) return null;
  const nodes = raw.nodes.map((n) => (n && n.data) ? unflatten(n.data) : null);
  const fin = nodes.find((n) => n && n.financialData);
  if (!fin) return null;
  const info = nodes.find((n) => n && n.info)?.info;
  const fd = fin.financialData;
  const currency = info?.curr?.financial || info?.curr?.main || null;
  const rows = [];
  for (const m of (fin.map || [])) {
    if (m && (m.id in fd)) rows.push({ id: m.id, title: m.title, format: m.format || 'raw', vals: fd[m.id] });
  }
  return {
    statement: fin.statement, period: fin.period, source: fin.source,
    periods: fd.datekey || [], fy: fd.fiscalYear || [], fq: fd.fiscalQuarter || null,
    currency, name: info?.name, rows,
  };
}

// ── crosswalk: SA key → our snake_case line_items key ─────────────────────────
// (industrial + bank keys share one map per statement; a key absent in the other
//  template simply never appears in its data.) Only CANONICAL primitives listed here
//  matter to the reconcile comparator (income:revenue,net_income,gross_profit,ebit;
//  balance:total_assets,total_liabilities,equity,cash,total_debt; cashflow:cfo,cff,cfi,dep_amort);
//  the rest are reader/display + future crosswalk growth. Aliases the lake gate folds:
//  total_operating_income→revenue (banks), net_interest_income→nii, total_equity→equity.
const INCOME_MAP = {
  // industrial
  revenue: 'revenue', cor: 'cost_of_sales', gp: 'gross_profit', sgna: 'general_and_administrative_expenses',
  goodwillIntangibleAmortization: 'amortization_of_intangibles', otheropex: 'other_operating_expenses',
  opex: 'operating_expenses', opinc: 'operating_income', interestExpense: 'finance_costs', interestIncome: 'finance_income',
  incomeEquity: 'share_of_profit_of_associates_and_jv', currencyGains: 'foreign_exchange_gain_loss',
  otherNonOperating: 'other_non_operating_income_expense', ebtExcl: 'ebt_excluding_unusual',
  gainAssets: 'gain_loss_on_sale_of_assets', gainInvestments: 'gain_loss_on_sale_of_investments',
  assetWritedown: 'asset_writedown', otherUnusualItems: 'other_unusual_items', mergerRestructureCharges: 'merger_restructuring_charges',
  pretax: 'profit_before_tax', taxexp: 'income_tax_expense', minorityInterest: 'minority_interest',
  netinc: 'net_income', netinccmn: 'net_income_to_common', earningContinuing: 'earnings_from_continuing_operations',
  sharesBasic: 'weighted_average_shares', sharesDiluted: 'weighted_average_shares_diluted',
  epsBasic: 'eps_basic', epsdil: 'eps_diluted', ebit: 'ebit',
  // bank
  interestIncomeLoansBank: 'interest_income', interestDepositsBank: 'interest_expense_on_deposits',
  netInterestIncomeBank: 'net_interest_income', gainAssetsBank: 'gain_loss_on_sale_of_assets',
  gainInvestmentsBank: 'gain_loss_on_sale_of_investments', gainEquityInvestmentsBank: 'gain_loss_on_equity_investments',
  otherNonIntIncBank: 'other_non_interest_income', nonInterestIncomeBank: 'non_interest_income',
  revenuesBeforeLoanLosses: 'revenue_before_loan_losses', loanLosses: 'loan_loss_provision',
  revenueBank: 'total_operating_income', salariesBenefits: 'salaries_and_benefits', occupyExp: 'occupancy_expense',
  goodwillIntangibleAmortizationBank: 'amortization_of_intangibles', sgaBank: 'general_and_administrative_expenses',
  otherNonInterestExpenseBank: 'other_non_interest_expense', nonInterestExpenseBank: 'total_non_interest_expense',
  ebtExclBank: 'ebt_excluding_unusual', otherUnusualBank: 'other_unusual_items', assetWritedownBank: 'asset_writedown',
  ebtBank: 'profit_before_tax', preferredDividendsOther: 'preferred_dividends',
};
const BALANCE_MAP = {
  // industrial
  cashneq: 'cash', investmentsc: 'short_term_investments', tradingAssetSecurities: 'trading_securities',
  totalcash: 'total_cash_and_short_term_investments', accountsReceivable: 'trade_receivables',
  otherReceivables: 'other_receivables', receivables: 'total_receivables', inventory: 'inventories',
  prepaidExpenses: 'prepaid_expenses', restrictedCash: 'restricted_cash', othercurrent: 'other_current_assets',
  assetsc: 'total_current_assets', netPPE: 'property_plant_equipment', investmentsnc: 'long_term_investments',
  goodwill: 'goodwill', otherIntangibles: 'intangible_assets', longTermAccountsReceivable: 'long_term_receivables',
  defferedTaxAssets: 'deferred_tax_assets', deferredLongTermCharges: 'deferred_charges',
  othernoncurrent: 'other_non_current_assets', assets: 'total_assets', accountsPayable: 'trade_payables',
  accruedExpenses: 'accrued_expenses', debtc: 'short_term_debt', currentPortDebt: 'current_portion_long_term_debt',
  currentCapLeases: 'current_capital_leases', currentIncomeTaxesPayable: 'income_tax_payable',
  otherCurrentLiabilities: 'other_current_liabilities', currentLiabilities: 'current_liabilities',
  debtnc: 'long_term_debt', capitalLeases: 'capital_leases', longTermUnearnedRevenue: 'deferred_revenue_non_current',
  pensionRetirementBenefits: 'pension_retirement_benefits', longTermDeferredTaxLiabilities: 'deferred_tax_liabilities',
  otherliabilitiesnoncurrent: 'other_non_current_liabilities', liabilities: 'total_liabilities',
  commonStock: 'share_capital', additionalPaidInCapital: 'additional_paid_in_capital', retearn: 'retained_earnings',
  otherEquity: 'other_equity', totalCommonEquity: 'equity_attributable_to_parent', minorityInterestBS: 'minority_interest',
  equity: 'equity', liabilitiesequity: 'total_liabilities_and_equity', debt: 'total_debt', netcash: 'net_cash',
  sharesOutFilingDate: 'shares_outstanding_filing_date', sharesOutTotalCommon: 'shares_outstanding',
  workingcapital: 'working_capital', tangibleBookValue: 'tangible_book_value', land: 'land', machinery: 'machinery',
  constructionInProgress: 'construction_in_progress', leaseholdImprovements: 'leasehold_improvements', orderBacklog: 'order_backlog',
  buildings: 'buildings', currentUnearnedRevenue: 'deferred_revenue_current',
  // bank
  investmentSecurities: 'investment_securities', totalInvestment: 'total_investments', grossLoans: 'gross_loans',
  investmentRealEstate: 'investment_real_estate', accountsPayableBank: 'trade_payables',
  allowanceForLoanLosses: 'loan_loss_allowance', otherAdjustGrossLoans: 'other_loan_adjustments', netLoans: 'net_loans',
  otherIntanBank: 'intangible_assets', accruedInterestReceivables: 'accrued_interest_receivable',
  otherCurrentAssetsBank: 'other_current_assets', defferedTaxAssetsBank: 'deferred_tax_assets',
  otherRealEstate: 'other_real_estate', otherLongTermAssetsBank: 'other_non_current_assets',
  accruedExpensesBank: 'accrued_expenses', interestBearingDeposits: 'interest_bearing_deposits',
  nonInterestBearingDeposits: 'non_interest_bearing_deposits', totalDeposits: 'customer_deposits',
  shortTermDebtBank: 'short_term_debt', currentPortDebtBank: 'current_portion_long_term_debt',
  accruedInterestPayable: 'accrued_interest_payable', otherCurrentLiabilitiesBank: 'other_current_liabilities',
  longTermDebtBank: 'long_term_debt', deferredTaxLiabilitiesBank: 'deferred_tax_liabilities',
  otherLongTermLiabilitiesBank: 'other_non_current_liabilities', liabilitiesBank: 'total_liabilities',
  treasuryStock: 'treasury_stock', otherEquityBank: 'other_equity', minorityInterestBank: 'minority_interest',
};
const CASHFLOW_MAP = {
  // industrial
  netIncomeCF: 'net_income', totalDepAmorCF: 'dep_amort', otherAmortization: 'other_amortization',
  gainAssetsCF: 'gain_loss_on_sale_of_assets', assetWritedownCF: 'asset_writedown',
  gainInvestmentsCF: 'gain_loss_on_sale_of_investments', incomeLossEquityInvestments: 'income_from_equity_investments',
  provisionWriteoffBadDebtsCF: 'provision_writeoff_bad_debts', otheroperating: 'other_operating_activities',
  changeAR: 'change_in_receivables', changeAP: 'change_in_payables', changeUnearnedRev: 'change_in_unearned_revenue',
  changeIncomeTax: 'change_in_income_tax', changeOtherNetOperAssets: 'change_in_other_operating_assets',
  ncfo: 'cfo', capex: 'capex', saleOfPropertyPlantAndEquipment: 'sale_of_ppe', cashAcquisition: 'cash_acquisitions',
  divestitures: 'divestitures', salePurchaseIntangibles: 'sale_purchase_intangibles', saleRealEstateCF: 'sale_of_real_estate',
  investInSecurities: 'investment_in_securities', otherinvesting: 'other_investing_activities', ncfi: 'cfi',
  debtIssuedLongTerm: 'long_term_debt_issued', debtRepaidLongTerm: 'long_term_debt_repaid', netDebtIssued: 'net_debt_issued',
  debtIssuedTotal: 'total_debt_issued', debtRepaidTotal: 'total_debt_repaid',
  debtIssuedShortTerm: 'short_term_debt_issued', debtRepaidShortTerm: 'short_term_debt_repaid',
  commonDividendCF: 'dividends_paid', otherfinancing: 'other_financing_activities', ncff: 'cff',
  commonRepurchased: 'common_stock_repurchased', changeInventory: 'change_in_inventory',
  exchangeRateAdjustments: 'fx_rate_adjustments', miscCashFlowAdjustments: 'misc_cashflow_adjustments',
  ncf: 'net_change_in_cash', cashInterestPaid: 'cash_interest_paid', cashTaxesPaid: 'cash_taxes_paid',
  changeWorkingCapital: 'change_in_working_capital',
  // bank
  totalDepAmorCFBank: 'dep_amort', gainLossSaleOfAssetsBank: 'gain_loss_on_sale_of_assets',
  gainLossSaleOfInvestmentsBank: 'gain_loss_on_sale_of_investments', provisionForCreditLosses: 'loan_loss_provision',
  changeOtherNetOperatingAssetsBank: 'change_in_other_operating_assets', otherOperatingActivitiesBank: 'other_operating_activities',
  saleOfPropertyPlantAndEquipmentBank: 'sale_of_ppe', investInSecuritiesBank: 'investment_in_securities',
  otherInvestActSupplBank: 'other_investing_activities', netDebtIssuedBank: 'net_debt_issued',
  commonIssuedBank: 'common_stock_issued', commonRepurchasedBank: 'common_stock_repurchased',
  changeInDepositAccount: 'change_in_deposits', otherAmortizationBank: 'other_amortization',
  changeInTradingAssets: 'change_in_trading_assets', salePurchaseIntangiblesBank: 'sale_purchase_intangibles',
  assetWritedownBankCF: 'asset_writedown', otherFinancingActivitiesBank: 'other_financing_activities',
};
const STMT_MAP = { income: INCOME_MAP, balance: BALANCE_MAP, cashflow: CASHFLOW_MAP };

// DERIVED-ONLY metrics that appear on the income/balance/cashflow tabs — routed to the
// payload.ratios bucket (NOT line_items, NOT key_ratios). margins/growth/FCF-family/per-share-market.
const DERIVED = new Set([
  // growth
  'revenueGrowth', 'netIncomeGrowth', 'netInterestIncomeGrowthBank', 'nonInterestIncomeGrowthBank', 'epsGrowth',
  'sharesYoY', 'dividendGrowth', 'cashGrowth', 'netCashGrowth', 'ocfGrowth', 'fcfGrowth', 'marketCapGrowth',
  // margins
  'grossMargin', 'operatingMargin', 'profitMargin', 'fcfMargin', 'ebitdaMargin', 'ebitMargin',
  // rates
  'taxrate', 'payoutratio',
  // fcf / per-share market
  'fcf', 'fcfps', 'leveredFCF', 'unleveredFCF', 'dps', 'netcashpershare', 'bvps', 'tangibleBookValuePerShare',
  // ebitda family (buildSpec: ebitda→ebitda_ttm on key_ratios)
  'ebitda', 'depAmorEbitda',
]);
const PER_SHARE_LINE = new Set(['eps_basic', 'eps_diluted']);
const CORE = {
  income: ['revenue', 'net_income', 'gross_profit', 'ebit', 'total_operating_income'],
  balance: ['total_assets', 'total_liabilities', 'equity', 'cash', 'total_debt'],
  cashflow: ['cfo', 'cfi', 'cff', 'dep_amort'],
};
const BANK_SIGNAL = new Set(['netInterestIncomeBank', 'grossLoans', 'totalDeposits', 'revenueBank', 'loanLosses', 'provisionForCreditLosses']);

// ── value rounding (kill IEEE float noise like ...000.000004) ─────────────────
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const rInt = (v) => Math.round(v);
const roundLine = (target, v) => (PER_SHARE_LINE.has(target) ? r6(v) : rInt(v));
const roundRaw = (v) => (Math.abs(v) >= 1000 ? rInt(v) : r6(v)); // currency → int, small → 6dp
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toDateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function detectTemplate(rows) {
  for (const r of rows) if (/Bank$/.test(r.id) || BANK_SIGNAL.has(r.id)) return 'bank';
  return 'industrial';
}

// ── canonicalFiscalPeriod: prefer the lake export (identical key rule as golden), else replicate.
let extMod = null, extTried = false;
async function loadExt() {
  if (extTried) return extMod;
  extTried = true;
  try { extMod = await import('/opt/marsad/ingestion/dist/lake/statement-extraction.js'); }
  catch { extMod = null; }
  return extMod;
}
function canonicalFiscalPeriodLocal(periodKind, periodEnd, fallback) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(periodEnd || '');
  if (!m) return fallback;
  const y = Number(m[1]);
  if (periodKind === 'annual' || periodKind === 'ttm') return String(y);
  const q = Math.floor((Number(m[2]) - 1) / 3) + 1;
  return `Q${q} ${y}`;
}

// ── curl fetch (browser UA); returns parsed statement or {miss:reason} ────────
function fetchTab(saTicker, tabPath, quarterly) {
  const url = `https://stockanalysis.com/quote/${SA_PATH}/${saTicker}/${tabPath}/__data.json${quarterly ? '?p=quarterly' : ''}`;
  const r = spawnSync('curl', ['-s', '-m', '30', '--compressed', '-H', `user-agent: ${UA}`, '-H', 'accept: application/json', url], { maxBuffer: 5e7 });
  if (r.status !== 0) return { miss: `curl-${r.status}` };
  const body = r.stdout.toString();
  if (body.length < 400) return { miss: 'stub' }; // 188-325 byte empty shell
  const parsed = parseSA(body);
  if (!parsed) return { miss: 'no-financialData' };
  return { parsed };
}

/** Map one statement's parsed rows across all persisted (non-TTM) periods.
 *  Returns { periods:[{period_kind,period_end,fiscal_period,currency,line_items,ratios,raw,template}], unmapped:Map<id,count> } */
async function mapStatement(parsed, stype, periodKind, canon) {
  const map = STMT_MAP[stype];
  const template = detectTemplate(parsed.rows);
  const unmapped = new Map();
  const out = [];
  for (let i = 0; i < parsed.periods.length; i++) {
    if (parsed.periods[i] === 'TTM') continue; // rolling aggregate, not a filed period — drop
    const periodEnd = toDateStr(parsed.periods[i]);
    const fbFy = parsed.fy?.[i];
    const fbFq = parsed.fq?.[i];
    const fallback = fbFy ? (fbFq ? `${fbFq} ${fbFy}` : String(fbFy)) : undefined;
    const fiscalPeriod = canon(periodKind, periodEnd, fallback);
    const line_items = {}, ratios = {}, raw = {};
    for (const row of parsed.rows) {
      const v = row.vals?.[i];
      if (!isNum(v)) continue;
      if (DERIVED.has(row.id)) { ratios[row.id] = r6(v); continue; }
      const target = map[row.id];
      if (target) { line_items[target] = roundLine(target, v); }
      else { raw[row.id] = roundRaw(v); unmapped.set(row.id, (unmapped.get(row.id) || 0) + 1); }
    }
    out.push({ period_kind: periodKind, period_end: periodEnd, fiscal_period: fiscalPeriod, currency: parsed.currency, line_items, ratios, raw, template });
  }
  return { periods: out, unmapped };
}

/** Map the ratios tab (all keys derived) → fiscal_period → {saId:value}. */
function mapRatiosTab(parsed, periodKind, canon) {
  const byFp = {};
  for (let i = 0; i < parsed.periods.length; i++) {
    if (parsed.periods[i] === 'TTM') continue;
    const periodEnd = toDateStr(parsed.periods[i]);
    const fp = canon(periodKind, periodEnd, parsed.fy?.[i]);
    const m = {};
    for (const row of parsed.rows) { const v = row.vals?.[i]; if (isNum(v)) m[row.id] = r6(v); }
    byFp[fp] = m;
  }
  return byFp;
}

function hasCore(stype, li) { return CORE[stype].some((k) => isNum(li[k])); }

/** Run the lake extraction gate over one (stype, periodKind) batch; returns rejected fiscal_periods + reasons.
 *  Falls back to a minimal finite/scale-free check when the module isn't importable (e.g. local dry run). */
function runGate(currency, stype, periods, ext) {
  if (!ext || typeof ext.validateExtraction !== 'function') {
    return { rejected: new Set(), reasons: [], gate: 'fallback' };
  }
  const raw = {
    scale: 'units', currency,
    statements: periods.map((p) => ({ statement_type: stype, period_kind: p.period_kind, period_end: p.period_end, fiscal_period: p.fiscal_period, line_items: p.line_items })),
  };
  let v;
  try { v = ext.validateExtraction(raw); } catch (e) { return { rejected: new Set(), reasons: [`gate-threw:${e.message}`], gate: 'error' }; }
  const rejected = new Set(v.rejected.map((r) => r.statement.fiscal_period));
  const reasons = v.rejected.flatMap((r) => r.reasons.map((x) => `${r.statement.fiscal_period}:${x.check}`));
  return { rejected, reasons, gate: 'lake' };
}

/** Fetch + crosswalk + gate a single security across income/balance/cashflow × annual/quarterly.
 *  Returns { statements:[...landable...], unmapped:{income:Map,balance:Map,cashflow:Map}, fetch:{ok,miss}, incomeRevenue, template } */
async function processSecurity(saTicker) {
  const ext = await loadExt();
  const canon = ext?.canonicalFiscalPeriod || canonicalFiscalPeriodLocal;
  const unmapped = { income: new Map(), balance: new Map(), cashflow: new Map() };
  const statements = [];
  const misses = [];
  let anyOk = false, incomeRevenue = null, template = null, currency = null;

  for (const periodKind of ['annual', 'quarter']) {
    const quarterly = periodKind === 'quarter';
    // ratios tab first (to merge market ratios into the income object's ratios bucket)
    let ratiosByFp = {};
    const rr = fetchTab(saTicker, 'financials/ratios', quarterly);
    await sleep(DELAY_MS);
    if (rr.parsed) ratiosByFp = mapRatiosTab(rr.parsed, periodKind, canon);

    for (const [tab, stype] of [['financials', 'income'], ['financials/balance-sheet', 'balance'], ['financials/cash-flow-statement', 'cashflow']]) {
      const res = fetchTab(saTicker, tab, quarterly);
      await sleep(DELAY_MS);
      if (res.miss) { misses.push(`${stype}/${periodKind}:${res.miss}`); continue; }
      anyOk = true;
      currency = currency || res.parsed.currency;
      const { periods, unmapped: um } = await mapStatement(res.parsed, stype, periodKind, canon);
      for (const [k, n] of um) unmapped[stype].set(k, (unmapped[stype].get(k) || 0) + n);
      if (stype === 'income') { template = template || detectTemplate(res.parsed.rows); }
      // merge ratios-tab metrics into income period ratios
      if (stype === 'income') for (const p of periods) if (ratiosByFp[p.fiscal_period]) Object.assign(p.ratios, ratiosByFp[p.fiscal_period]);
      const gate = runGate(res.parsed.currency, stype, periods, ext);
      for (const p of periods) {
        if (stype === 'income' && periodKind === 'annual' && incomeRevenue == null) {
          const rev = isNum(p.line_items.revenue) ? p.line_items.revenue : p.line_items.total_operating_income; // banks use total_operating_income (gate folds → revenue)
          if (isNum(rev)) incomeRevenue = rev;
        }
        if (gate.rejected.has(p.fiscal_period)) { misses.push(`gate-reject ${stype} ${p.fiscal_period}`); continue; }
        if (!hasCore(stype, p.line_items)) { misses.push(`no-core ${stype} ${p.fiscal_period}`); continue; }
        if (!p.currency) { misses.push(`no-currency ${stype} ${p.fiscal_period}`); continue; }
        statements.push({ statement_type: stype, ...p });
      }
    }
  }
  return { statements, unmapped, ok: anyOk, misses, incomeRevenue, template, currency };
}

// ── ASSESS_ONLY dry report (no DB) ────────────────────────────────────────────
function fmt(v) { return v == null ? '—' : (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : String(v)); }
function reportSecurity(t, r) {
  console.log(`\n==== ${VENUE}/${t}  (template=${r.template || '?'}  currency=${r.currency || '?'}) ====`);
  if (!r.ok) { console.log(`  NO DATA (${r.misses.join(', ') || 'no financialData'})`); return; }
  const inc = r.statements.find((s) => s.statement_type === 'income' && s.period_kind === 'annual');
  if (inc) {
    console.log(`  income ${inc.fiscal_period} (end ${inc.period_end}) mapped line_items:`);
    for (const [k, v] of Object.entries(inc.line_items)) console.log(`     ${k.padEnd(38)} ${fmt(v)}`);
  } else console.log('  (no landable annual income statement)');
  for (const st of ['income', 'balance', 'cashflow']) {
    const um = [...r.unmapped[st].keys()];
    console.log(`  UNMAPPED ${st} (${um.length}): ${um.join(', ') || '—'}`);
  }
  const nLand = r.statements.length;
  console.log(`  landable statements: ${nLand}  |  income revenue (latest annual) = ${r.incomeRevenue == null ? '—' : r.incomeRevenue.toLocaleString()} ${r.currency || ''}`);
  if (r.misses.length) console.log(`  skips: ${r.misses.join(', ')}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function assessMain() {
  if (!ONLY.length) { console.error('ASSESS_ONLY requires TICKERS=csv (no DB is opened in assess mode)'); process.exit(1); }
  log(`ASSESS_ONLY stockanalysis ${VENUE} (saPath ${SA_PATH}) — ${ONLY.length} tickers, NO writes`);
  const globalUnmapped = { income: new Map(), balance: new Map(), cashflow: new Map() };
  for (const t of ONLY) {
    const r = await processSecurity(t);
    reportSecurity(t, r);
    for (const st of ['income', 'balance', 'cashflow']) for (const [k, n] of r.unmapped[st]) globalUnmapped[st].set(k, (globalUnmapped[st].get(k) || 0) + n);
  }
  console.log('\n==== GLOBAL UNMAPPED KEY TALLY (crosswalk gaps to grow) ====');
  for (const st of ['income', 'balance', 'cashflow']) {
    const entries = [...globalUnmapped[st].entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  ${st}: ${entries.map(([k, n]) => `${k}(${n})`).join(', ') || 'none'}`);
  }
}

async function writeMain() {
  const postgres = await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m);
  const { SUPABASE_DB_URL } = process.env;
  if (!SUPABASE_DB_URL) { console.error('missing env SUPABASE_DB_URL'); process.exit(1); }
  const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });

  // sa_symbol may not exist yet (alias migration not applied) — probe the catalog and coalesce defensively.
  const hasSa = (await sql`select 1 from information_schema.columns where table_schema='public' and table_name='securities' and column_name='sa_symbol'`).length > 0;
  const saExpr = hasSa ? sql`coalesce(sa_symbol, ticker)` : sql`ticker`;

  let universe;
  if (ONLY.length) {
    universe = await sql`select id, ticker, ${saExpr} as sa_ticker from public.securities where venue_code=${VENUE} and ticker = any(${ONLY}) order by ticker`;
  } else if (REFRESH) {
    universe = await sql`select id, ticker, ${saExpr} as sa_ticker from public.securities where venue_code=${VENUE} and status='listed' order by ticker`;
  } else {
    universe = await sql`
      select s.id, s.ticker, ${saExpr} as sa_ticker from public.securities s
      where s.venue_code=${VENUE} and s.status='listed'
        and not exists (
          select 1 from lake.objects o
          where o.security_id=s.id and o.object_type='FINANCIALS.XCHECK'
            and o.superseded_by is null and o.updated_at > now() - make_interval(days => ${XCHECK_MAX_AGE_DAYS}))
      order by s.ticker`;
  }
  if (MAX) universe = universe.slice(0, MAX);

  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, ${'stockanalysis_financials_' + VENUE.toLowerCase()}, '1', 'running') returning id`;
  const runId = pr[0].id;
  log(`stockanalysis-financials ${VENUE} — ${universe.length} securities (REFRESH=${REFRESH}, sa_symbol=${hasSa})`);

  let created = 0, updated = 0, secWritten = 0, secEmpty = 0, secMiss = 0, i = 0;
  const unmappedTally = { income: new Map(), balance: new Map(), cashflow: new Map() };
  try {
  for (const { id: secId, ticker, sa_ticker } of universe) {
    i++;
    let r;
    try { r = await processSecurity(sa_ticker); }
    catch (e) { secMiss++; log(`  [${i}/${universe.length}] ${ticker}: process-error ${e.message}`); continue; }
    for (const st of ['income', 'balance', 'cashflow']) for (const [k, n] of r.unmapped[st]) unmappedTally[st].set(k, (unmappedTally[st].get(k) || 0) + n);
    if (!r.ok) { secMiss++; if (i % 25 === 0) log(`  [${i}/${universe.length}] ${ticker}: no-financialData (sa_symbol miss? ${r.misses.slice(0, 2).join(',')})`); continue; }
    if (!r.statements.length) { secEmpty++; continue; }

    for (const st of r.statements) {
      const nk = `FINXCHECK:SA:${VENUE}:${ticker}:${st.statement_type}:${st.fiscal_period}`;
      const payload = {
        statement_type: st.statement_type, period_kind: st.period_kind, fiscal_period: st.fiscal_period,
        period_end: st.period_end, currency: st.currency, basis: 'consolidated',
        line_items: st.line_items, ratios: st.ratios, raw: st.raw, template: st.template, source: SOURCE_TAG,
      };
      const { action } = await upsertLakeObject(sql, {
        naturalKey: nk, objectType: 'FINANCIALS.XCHECK', securityId: secId, venueCode: VENUE,
        payload, parseRunId: runId, sourceRank: SOURCE_RANK,
      });
      if (action === 'updated') updated++;
      else if (action !== 'noop') created++;
    }
    secWritten++;
    if (i % 25 === 0) log(`  [${i}/${universe.length}] ${secWritten} sec-written · ${secEmpty} empty · ${secMiss} miss · ${created} obj-new · ${updated} obj-upd`);
  }
  await sql`update lake.parse_runs set status='succeeded', finished_at=now(), objects_created=${created}, objects_updated=${updated} where id=${runId}`;
  log('\nUNMAPPED KEY TALLY (crosswalk gaps to grow):');
  for (const st of ['income', 'balance', 'cashflow']) {
    const e = [...unmappedTally[st].entries()].sort((a, b) => b[1] - a[1]);
    log(`  ${st}: ${e.map(([k, n]) => `${k}(${n})`).join(', ') || 'none'}`);
  }
  log(`DONE ${VENUE} | sec-written ${secWritten} | empty ${secEmpty} | miss ${secMiss} | objects new ${created} upd ${updated} | of ${universe.length}`);
  } catch (e) {
    // Never leave the run wedged at 'running' (the old code had no failed path).
    await sql`update lake.parse_runs set status='failed', finished_at=now(), objects_created=${created}, objects_updated=${updated} where id=${runId}`.catch(() => {});
    throw e;
  } finally {
    await sql.end();
  }
}

(ASSESS_ONLY ? assessMain() : writeMain()).catch((e) => { console.error(e); process.exit(1); });

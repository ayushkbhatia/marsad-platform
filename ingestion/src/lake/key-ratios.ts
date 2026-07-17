/**
 * Nightly key_ratios recompute (CONTRACT §9 `key_ratios_recompute`; 02 §8).
 *
 * public.key_ratios is the screener's flat scan target — one row per security,
 * rebuilt from the latest VERIFIED fundamentals + the latest delayed quote. This
 * service gathers inputs per security, computes the ratios (pure math in
 * ratios-compute.ts), writes a COMPUTED.RATIOS lake object per security for
 * lineage, and upserts key_ratios with source_object_id pointing at it.
 *
 * The COMPUTED object is written straight to VERIFIED (numeric facts we derived
 * ourselves need no cross-check) attributed to the compute agent (default
 * SYSTEM — no dedicated ratios principal in the live seed). It carries a
 * per-batch natural_key so each nightly run supersedes the prior COMPUTED object
 * via the same one-live-per-key discipline used elsewhere in the lake.
 *
 * Runs as marsad_worker on q_pipeline. Chunked by construction: the handler may
 * pass an explicit securityIds slice (CONTRACT KeyRatiosPayload.securityIds);
 * with none, every listed security is recomputed.
 */

import type { LakeSql, LakeTx, LakeLogger } from './db.js';
import { noopLogger } from './db.js';
import {
  computeKeyRatios,
  fitToColumnBudget,
  hasAnyRatio,
  type RatioInputs,
  type KeyRatios,
} from './ratios-compute.js';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface KeyRatiosOptions {
  /** iam handle attributed as the COMPUTED object's verifier/actor. */
  computeHandle?: string;
  logger?: LakeLogger;
}

export interface RecomputeSummary {
  securitiesConsidered: number;
  rowsWritten: number;
  rowsSkippedAllNull: number;
}

interface SecurityRow {
  id: string;
  venue_code: string;
  shares_outstanding: string | null;
  sector: string | null;
  currency: string | null;
}

export class KeyRatiosRecompute {
  private readonly computeHandle: string;
  private readonly log: LakeLogger;
  private computeAgentId: string | null = null;

  constructor(private readonly sql: LakeSql, opts: KeyRatiosOptions = {}) {
    this.computeHandle = opts.computeHandle ?? 'SYSTEM';
    this.log = opts.logger ?? noopLogger;
  }

  /** Recompute for the given securities (or all listed securities when omitted). */
  async run(securityIds?: number[]): Promise<RecomputeSummary> {
    const agentId = await this.resolveAgent();
    const securities = await this.loadSecurities(securityIds);
    let rowsWritten = 0;
    let rowsSkippedAllNull = 0;
    const rowsFailed: Array<{ securityId: string; err: unknown }> = [];

    for (const sec of securities) {
      // PER-SECURITY ISOLATION: persist() opens its own transaction per security, so
      // one bad name rolls back alone. Without this try/catch a single security threw
      // out of the whole loop and every remaining security silently went ratio-less —
      // live on 2026-07-17 the recompute died on security id 29 (TDWL EAST PIPES, a
      // bad eps extraction) and so never reached the other ~660. Failures are counted
      // and rethrown as a batch below, never swallowed.
      try {
        const inputs = await this.gatherInputs(sec);
        const { ratios, dropped } = fitToColumnBudget(computeKeyRatios(inputs));
        if (dropped.length > 0) {
          // Loud on purpose: an out-of-range ratio is either a degenerate business or
          // an upstream extraction bug. Nulling it keeps the screener honest, but a
          // SILENT null is how a systematic data fault hides.
          this.log.warn('key_ratios.out_of_range', {
            securityId: sec.id,
            venue: sec.venue_code,
            dropped: dropped.map((d) => ({ field: d.field, value: d.value, limit: d.limit })),
          });
        }
        if (!hasAnyRatio(ratios)) {
          rowsSkippedAllNull += 1;
          continue;
        }
        await this.persist(sec, ratios, agentId);
        rowsWritten += 1;
      } catch (err) {
        rowsFailed.push({ securityId: sec.id, err });
        this.log.warn('key_ratios.security_failed', { securityId: sec.id, venue: sec.venue_code, err });
      }
    }

    this.log.info('key_ratios.recompute', {
      considered: securities.length,
      written: rowsWritten,
      skipped: rowsSkippedAllNull,
      failed: rowsFailed.length,
    });

    // Surface partial failure to the caller — the handler's heartbeat records it and
    // the sentinel raises on a sustained streak (20260717101959). The good rows are
    // already committed by their own transactions, so throwing costs no data; staying
    // quiet about N broken securities is what we are deliberately not doing.
    if (rowsFailed.length > 0) {
      const sample = rowsFailed.slice(0, 3).map((f) => `${f.securityId}: ${errText(f.err)}`).join('; ');
      throw new Error(
        `key_ratios recompute: ${rowsFailed.length}/${securities.length} securities failed ` +
          `(${rowsWritten} written). First: ${sample}`,
      );
    }

    return {
      securitiesConsidered: securities.length,
      rowsWritten,
      rowsSkippedAllNull,
    };
  }

  private async loadSecurities(securityIds?: number[]): Promise<SecurityRow[]> {
    if (securityIds && securityIds.length > 0) {
      return this.sql<SecurityRow>`
        select id, venue_code, shares_outstanding, sector, currency
        from public.securities
        where id = any(${securityIds}) and status = 'listed'
        order by id
      `;
    }
    return this.sql<SecurityRow>`
      select id, venue_code, shares_outstanding, sector, currency
      from public.securities
      where status = 'listed'
      order by id
    `;
  }

  /**
   * Gather the latest verified inputs for one security:
   *  - last price from public.quotes_latest,
   *  - PROPER TTM flows: the trailing-4-quarter sum of income/cashflow line
   *    items (fallback to a 'ttm' row, else the latest 'annual' as a TTM proxy),
   *  - prior-year TTM (quarters 5..8) for YoY growth, 3y-ago annual for CAGR,
   *  - latest balance-sheet stocks,
   *  - price momentum returns from public.ohlcv_daily,
   *  - trailing-12-month dividends per share from live public.dividends.
   * line_items is jsonb; we read the §3.1 primitive keys and tolerate misses.
   */
  private async gatherInputs(sec: SecurityRow): Promise<RatioInputs> {
    const securityId = Number(sec.id);
    const shares = sec.shares_outstanding !== null ? Number(sec.shares_outstanding) : null;

    const quote = await this.sql<{ last: string | null }>`
      select last from public.quotes_latest where security_id = ${sec.id} limit 1
    `;
    const last = quote[0]?.last != null ? Number(quote[0].last) : null;

    // Quarterly rows (newest first) drive the TTM roll-up; annual rows are the
    // fallback TTM proxy + the 3y-ago CAGR anchor.
    const incomeQ = await this.quarterlyStatements(sec.id, 'income');
    const cashflowQ = await this.quarterlyStatements(sec.id, 'cashflow');
    const incomeTtmRow = await this.singleStatement(sec.id, 'income', 'ttm');
    const cashflowTtmRow = await this.singleStatement(sec.id, 'cashflow', 'ttm');
    const incomeAnnual = await this.annualStatements(sec.id, 'income');
    const cashflowAnnual = await this.annualStatements(sec.id, 'cashflow');
    const balance = await this.balanceStatement(sec.id);

    // TTM flow = Σ trailing 4 quarters; else the explicit ttm row; else latest annual.
    const incomeTtm = ttmFlow(incomeQ, incomeTtmRow, incomeAnnual[0] ?? null);
    const cashflowTtm = ttmFlow(cashflowQ, cashflowTtmRow, cashflowAnnual[0] ?? null);
    // Prior-year TTM = Σ quarters 5..8; else the prior annual row.
    const incomePriorTtm = priorTtmFlow(incomeQ, incomeAnnual[1] ?? null);
    // 3y-ago = the annual ~3 fiscal years before the latest annual.
    const income3yAgo = incomeAnnual[3] ?? null;

    const trailingDps = await this.trailingDps(sec.id);
    const momentum = await this.momentum(sec.id);

    const revenueKeys = ['revenue', 'total_operating_income', 'total_revenue', 'sales'] as const;
    const epsKeys = ['eps_diluted', 'eps'] as const;

    return {
      securityId,
      last,
      sharesOutstanding: shares,
      epsTtm: numFrom(incomeTtm, ...epsKeys),
      netIncomeTtm: numFrom(incomeTtm, 'net_income', 'net_profit', 'profit'),
      revenueTtm: numFrom(incomeTtm, ...revenueKeys),
      ebitTtm: numFrom(incomeTtm, 'ebit', 'operating_income'),
      ebitdaTtm: numFrom(incomeTtm, 'ebitda'),
      grossProfitTtm: numFrom(incomeTtm, 'gross_profit'),
      depAmortTtm: numFrom(cashflowTtm, 'dep_amort', 'depreciation_amortization'),
      totalEquity: numFrom(balance, 'total_equity', 'equity', 'shareholders_equity'),
      totalAssets: numFrom(balance, 'total_assets'),
      currentLiabilities: numFrom(balance, 'current_liabilities'),
      totalDebt: numFrom(balance, 'total_debt'),
      cash: numFrom(balance, 'cash', 'cash_and_equivalents'),
      netDebt: numFrom(balance, 'net_debt'),
      revenueTtmPrior: numFrom(incomePriorTtm, ...revenueKeys),
      epsTtmPrior: numFrom(incomePriorTtm, ...epsKeys),
      revenue3yAgo: numFrom(income3yAgo, ...revenueKeys),
      eps3yAgo: numFrom(income3yAgo, ...epsKeys),
      ret3m: momentum.ret3m,
      ret6m: momentum.ret6m,
      ret121: momentum.ret121,
      trailingDps,
      netInterestIncomeTtm: numFrom(incomeTtm, 'nii', 'net_interest_income'),
      avgEarningAssets: numFrom(balance, 'avg_earning_assets', 'earning_assets'),
      sector: sec.sector,
      currency: sec.currency,
    };
  }

  /** The trailing-8 QUARTERLY line_items (newest period_end first) for a flow
   *  statement, so gatherInputs can sum quarters 1..4 (TTM) and 5..8 (prior). */
  private async quarterlyStatements(
    securityId: string,
    kind: 'income' | 'cashflow',
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<{ line_items: Record<string, unknown> }>`
      select line_items
      from public.financial_statements
      where security_id = ${securityId}
        and statement_type = ${kind}
        and period_kind = 'quarter'
        and is_estimate = false
      order by period_end desc
      limit 8
    `;
    return rows.map((r) => r.line_items);
  }

  /** Annual line_items (newest period_end first) — [0] latest, [1] prior year,
   *  [3] ~3 fiscal years before latest (the CAGR anchor). */
  private async annualStatements(
    securityId: string,
    kind: 'income' | 'cashflow',
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<{ line_items: Record<string, unknown> }>`
      select line_items
      from public.financial_statements
      where security_id = ${securityId}
        and statement_type = ${kind}
        and period_kind = 'annual'
        and is_estimate = false
      order by period_end desc
      limit 4
    `;
    return rows.map((r) => r.line_items);
  }

  /** The single newest row of a given period_kind (used for the explicit 'ttm'
   *  fallback when < 4 quarters exist). */
  private async singleStatement(
    securityId: string,
    kind: 'income' | 'cashflow',
    periodKind: 'ttm',
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ line_items: Record<string, unknown> }>`
      select line_items
      from public.financial_statements
      where security_id = ${securityId}
        and statement_type = ${kind}
        and period_kind = ${periodKind}
        and is_estimate = false
      order by period_end desc
      limit 1
    `;
    return rows[0]?.line_items ?? null;
  }

  /** Latest balance sheet (stocks are point-in-time, no TTM roll-up). */
  private async balanceStatement(securityId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ line_items: Record<string, unknown> }>`
      select line_items
      from public.financial_statements
      where security_id = ${securityId}
        and statement_type = 'balance'
        and is_estimate = false
      order by period_end desc
      limit 1
    `;
    return rows[0]?.line_items ?? null;
  }

  /**
   * Price momentum from public.ohlcv_daily (07 §3.2 [NEW COL]):
   *   ret3m  = close[0]/close[63]  − 1
   *   ret6m  = close[0]/close[126] − 1
   *   ret121 = close[21]/close[252] − 1   (classic 12-1, skips 1-month reversal)
   * closes are ordered newest-first; a return is null when the referenced bar
   * is missing.
   * NB dividend/split adjustment (owner D-6) is a documented v1 approximation:
   * ohlcv_daily has no adjusted close and public.dividends is empty, so v1 uses
   * RAW closes — subtract cumulative ex-date DPS once dividends are populated.
   */
  private async momentum(securityId: string): Promise<{ ret3m: number | null; ret6m: number | null; ret121: number | null }> {
    const rows = await this.sql<{ close: string | null }>`
      select close from public.ohlcv_daily
      where security_id = ${securityId}
      order by trade_date desc
      limit 260
    `;
    const c = rows.map((r) => (r.close != null ? Number(r.close) : null));
    const ret = (numIdx: number, denIdx: number): number | null => {
      const num = c[numIdx];
      const den = c[denIdx];
      if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
      const r = num / den - 1;
      return Number.isFinite(r) ? r : null;
    };
    return { ret3m: ret(0, 63), ret6m: ret(0, 126), ret121: ret(21, 252) };
  }

  /** Sum of live dividends' dps with ex_date in the trailing 365 days. */
  private async trailingDps(securityId: string): Promise<number | null> {
    const rows = await this.sql<{ dps_sum: string | null }>`
      select sum(dps)::text as dps_sum
      from public.dividends
      where security_id = ${securityId}
        and state = 'live'
        and ex_date is not null
        and ex_date >= (now() at time zone 'utc')::date - 365
    `;
    const v = rows[0]?.dps_sum;
    return v != null ? Number(v) : null;
  }

  /** Write COMPUTED.RATIOS lake object (VERIFIED) then upsert key_ratios. */
  private async persist(sec: SecurityRow, ratios: KeyRatios, agentId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const objectId = await this.writeComputedObject(tx, sec, ratios, agentId);
      await this.upsertKeyRatios(tx, sec.id, ratios, objectId);
    });
  }

  private async writeComputedObject(
    tx: LakeTx,
    sec: SecurityRow,
    ratios: KeyRatios,
    agentId: string,
  ): Promise<string> {
    const naturalKey = `COMPUTED.RATIOS:${sec.venue_code}:${sec.id}`;
    const payload = ratiosPayload(ratios);

    const parseRun = await tx<{ id: string }>`
      insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
      values (${agentId}, 'key_ratios', '1', 'running')
      returning id
    `;
    const parseRunId = parseRun[0].id;

    // Supersede the prior live COMPUTED object for this key, if any.
    const live = await tx<{ id: string; state: string; revision: number }>`
      select id, state, revision from lake.objects
      where natural_key = ${naturalKey} and superseded_by is null
      limit 1
    `;

    let revision = 1;
    let newId: string;
    if (live[0]) {
      revision = live[0].revision + 1;
      const alloc = await tx<{ id: string }>`select gen_random_uuid() as id`;
      newId = alloc[0].id;
      // Retire the previous VERIFIED computed row (VERIFIED→RETIRED).
      await tx`
        update lake.objects
        set superseded_by = ${newId}, state = 'RETIRED'
        where id = ${live[0].id}
      `;
      await tx`
        insert into lake.objects (
          id, object_type, natural_key, security_id, venue_code, payload,
          numeric_value, state, revision, parse_run_id, source_rank
        ) values (
          ${newId}, ${'COMPUTED.RATIOS'}, ${naturalKey}, ${sec.id}, ${sec.venue_code},
          ${payload}, ${ratios.marketCap}, ${'PENDING'}, ${revision}, ${parseRunId}, ${10}
        )
      `;
      await tx`update lake.objects set state = 'VERIFIED', verified_by = ${agentId} where id = ${newId}`;
    } else {
      const inserted = await tx<{ id: string }>`
        insert into lake.objects (
          object_type, natural_key, security_id, venue_code, payload,
          numeric_value, state, revision, parse_run_id, source_rank
        ) values (
          ${'COMPUTED.RATIOS'}, ${naturalKey}, ${sec.id}, ${sec.venue_code},
          ${payload}, ${ratios.marketCap}, ${'PENDING'}, ${1}, ${parseRunId}, ${10}
        )
        returning id
      `;
      newId = inserted[0].id;
      await tx`update lake.objects set state = 'VERIFIED', verified_by = ${agentId} where id = ${newId}`;
    }

    await tx`update lake.parse_runs set status = 'succeeded', finished_at = now() where id = ${parseRunId}`;
    return newId;
  }

  private async upsertKeyRatios(tx: LakeTx, securityId: string, r: KeyRatios, objectId: string): Promise<void> {
    await tx`
      insert into public.key_ratios (
        security_id, market_cap, pe, pb, eps_ttm, book_value_ps,
        dividend_yield, payout_ratio, roe, roce, nim,
        net_debt_ebitda, ev_ebitda, ps,
        net_margin, gross_margin, rev_growth_yoy, eps_growth_yoy,
        rev_cagr_3y, eps_cagr_3y, ret_3m, ret_6m, ret_12_1,
        ebitda_ttm, currency_computed,
        computed_at, source_object_id
      ) values (
        ${securityId}, ${r.marketCap}, ${r.pe}, ${r.pb}, ${r.epsTtm}, ${r.bookValuePs},
        ${r.dividendYield}, ${r.payoutRatio}, ${r.roe}, ${r.roce}, ${r.nim},
        ${r.netDebtEbitda}, ${r.evEbitda}, ${r.ps},
        ${r.netMargin}, ${r.grossMargin}, ${r.revGrowthYoy}, ${r.epsGrowthYoy},
        ${r.revCagr3y}, ${r.epsCagr3y}, ${r.ret3m}, ${r.ret6m}, ${r.ret121},
        ${r.ebitdaTtm}, ${r.currencyComputed},
        now(), ${objectId}
      )
      on conflict (security_id) do update set
        market_cap = excluded.market_cap,
        pe = excluded.pe,
        pb = excluded.pb,
        eps_ttm = excluded.eps_ttm,
        book_value_ps = excluded.book_value_ps,
        dividend_yield = excluded.dividend_yield,
        payout_ratio = excluded.payout_ratio,
        roe = excluded.roe,
        roce = excluded.roce,
        nim = excluded.nim,
        net_debt_ebitda = excluded.net_debt_ebitda,
        ev_ebitda = excluded.ev_ebitda,
        ps = excluded.ps,
        net_margin = excluded.net_margin,
        gross_margin = excluded.gross_margin,
        rev_growth_yoy = excluded.rev_growth_yoy,
        eps_growth_yoy = excluded.eps_growth_yoy,
        rev_cagr_3y = excluded.rev_cagr_3y,
        eps_cagr_3y = excluded.eps_cagr_3y,
        ret_3m = excluded.ret_3m,
        ret_6m = excluded.ret_6m,
        ret_12_1 = excluded.ret_12_1,
        ebitda_ttm = excluded.ebitda_ttm,
        currency_computed = excluded.currency_computed,
        computed_at = excluded.computed_at,
        source_object_id = excluded.source_object_id
    `;
  }

  private async resolveAgent(): Promise<string> {
    if (this.computeAgentId) return this.computeAgentId;
    const rows = await this.sql<{ id: string }>`
      select id from iam.principals where handle = ${this.computeHandle} limit 1
    `;
    if (rows.length === 0) {
      throw new Error(`key_ratios compute principal not found: handle=${this.computeHandle}`);
    }
    this.computeAgentId = rows[0].id;
    return this.computeAgentId;
  }
}

function ratiosPayload(r: KeyRatios): Record<string, unknown> {
  // NB: intentionally NO metric_key. key_ratios is a flat multi-column table
  // (public.key_ratios), not a single datapoint_series scalar. Omitting
  // metric_key guarantees the lake.fn_datapoint_fanout AFTER-UPDATE trigger
  // (0007) short-circuits on the PENDING→VERIFIED transition (it returns early
  // when payload->>'metric_key' is null), so market_cap is never projected into
  // public.datapoints masquerading as a composite 'key_ratios' metric.
  return {
    market_cap: r.marketCap,
    pe: r.pe,
    pb: r.pb,
    eps_ttm: r.epsTtm,
    book_value_ps: r.bookValuePs,
    dividend_yield: r.dividendYield,
    payout_ratio: r.payoutRatio,
    roe: r.roe,
    roce: r.roce,
    nim: r.nim,
    net_debt_ebitda: r.netDebtEbitda,
    ev_ebitda: r.evEbitda,
    ps: r.ps,
    net_margin: r.netMargin,
    gross_margin: r.grossMargin,
    rev_growth_yoy: r.revGrowthYoy,
    eps_growth_yoy: r.epsGrowthYoy,
    rev_cagr_3y: r.revCagr3y,
    eps_cagr_3y: r.epsCagr3y,
    ret_3m: r.ret3m,
    ret_6m: r.ret6m,
    ret_12_1: r.ret121,
    ebitda_ttm: r.ebitdaTtm,
    currency_computed: r.currencyComputed,
  };
}

/**
 * TTM flow row: prefer the trailing-4-quarter SUM (element-wise across every
 * numeric key present in any of the 4 quarters); fall back to an explicit 'ttm'
 * row, then the latest 'annual' row as a TTM proxy. Returns a synthetic
 * line_items object the ratio math reads via numFrom().
 */
function ttmFlow(
  quarters: Array<Record<string, unknown>>,
  ttmRow: Record<string, unknown> | null,
  annualRow: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (quarters.length >= 4) return sumRows(quarters.slice(0, 4));
  if (ttmRow) return ttmRow;
  return annualRow;
}

/** Prior-year TTM flow: Σ quarters 5..8; else the prior 'annual' row. */
function priorTtmFlow(
  quarters: Array<Record<string, unknown>>,
  priorAnnualRow: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (quarters.length >= 8) return sumRows(quarters.slice(4, 8));
  return priorAnnualRow;
}

/** Element-wise sum of the numeric keys across a set of quarterly line_items.
 *  A key contributes only where it parses to a finite number; keys absent from
 *  every row stay absent (⇒ numFrom returns null ⇒ the ratio is null). */
function sumRows(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = numFrom(row, k);
      if (v !== null) out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/** Read the first present numeric key from a jsonb line_items object. */
function numFrom(items: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!items) return null;
  for (const k of keys) {
    const v = items[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

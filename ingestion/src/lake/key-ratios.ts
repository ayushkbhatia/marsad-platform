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
import { computeKeyRatios, hasAnyRatio, type RatioInputs, type KeyRatios } from './ratios-compute.js';

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

    for (const sec of securities) {
      const inputs = await this.gatherInputs(sec);
      const ratios = computeKeyRatios(inputs);
      if (!hasAnyRatio(ratios)) {
        rowsSkippedAllNull += 1;
        continue;
      }
      await this.persist(sec, ratios, agentId);
      rowsWritten += 1;
    }

    this.log.info('key_ratios.recompute', {
      considered: securities.length,
      written: rowsWritten,
      skipped: rowsSkippedAllNull,
    });
    return {
      securitiesConsidered: securities.length,
      rowsWritten,
      rowsSkippedAllNull,
    };
  }

  private async loadSecurities(securityIds?: number[]): Promise<SecurityRow[]> {
    if (securityIds && securityIds.length > 0) {
      return this.sql<SecurityRow>`
        select id, venue_code, shares_outstanding
        from public.securities
        where id = any(${securityIds}) and status = 'listed'
        order by id
      `;
    }
    return this.sql<SecurityRow>`
      select id, venue_code, shares_outstanding
      from public.securities
      where status = 'listed'
      order by id
    `;
  }

  /**
   * Gather the latest verified inputs for one security:
   *  - last price from public.quotes_latest,
   *  - trailing income/balance line items from the newest financial_statements
   *    rows (ttm preferred, else annual),
   *  - trailing-12-month dividends per share from live public.dividends.
   * line_items is jsonb; we read a conventional set of keys and tolerate misses.
   */
  private async gatherInputs(sec: SecurityRow): Promise<RatioInputs> {
    const securityId = Number(sec.id);
    const shares = sec.shares_outstanding !== null ? Number(sec.shares_outstanding) : null;

    const quote = await this.sql<{ last: string | null }>`
      select last from public.quotes_latest where security_id = ${sec.id} limit 1
    `;
    const last = quote[0]?.last != null ? Number(quote[0].last) : null;

    const income = await this.latestStatement(sec.id, 'income');
    const balance = await this.latestStatement(sec.id, 'balance');

    const trailingDps = await this.trailingDps(sec.id);

    return {
      securityId,
      last,
      sharesOutstanding: shares,
      epsTtm: numFrom(income, 'eps'),
      netIncomeTtm: numFrom(income, 'net_income', 'net_profit', 'profit'),
      revenueTtm: numFrom(income, 'revenue', 'total_revenue', 'sales'),
      ebitTtm: numFrom(income, 'ebit', 'operating_income'),
      ebitdaTtm: numFrom(income, 'ebitda'),
      totalEquity: numFrom(balance, 'total_equity', 'equity', 'shareholders_equity'),
      totalAssets: numFrom(balance, 'total_assets'),
      currentLiabilities: numFrom(balance, 'current_liabilities'),
      netDebt: numFrom(balance, 'net_debt'),
      trailingDps,
      netInterestIncomeTtm: numFrom(income, 'net_interest_income', 'nii'),
      avgEarningAssets: numFrom(balance, 'avg_earning_assets', 'earning_assets'),
    };
  }

  private async latestStatement(securityId: string, kind: 'income' | 'balance'): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ line_items: Record<string, unknown> }>`
      select line_items
      from public.financial_statements
      where security_id = ${securityId}
        and statement_type = ${kind}
        and is_estimate = false
      order by case period_kind when 'ttm' then 0 when 'annual' then 1 else 2 end,
               period_end desc
      limit 1
    `;
    return rows[0]?.line_items ?? null;
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
        net_debt_ebitda, ev_ebitda, ps, computed_at, source_object_id
      ) values (
        ${securityId}, ${r.marketCap}, ${r.pe}, ${r.pb}, ${r.epsTtm}, ${r.bookValuePs},
        ${r.dividendYield}, ${r.payoutRatio}, ${r.roe}, ${r.roce}, ${r.nim},
        ${r.netDebtEbitda}, ${r.evEbitda}, ${r.ps}, now(), ${objectId}
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
  };
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

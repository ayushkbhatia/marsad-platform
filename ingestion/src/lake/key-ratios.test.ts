import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyRatiosRecompute } from './key-ratios.js';
import { createFakeDb, newState, type FakeState } from './fake-db.js';
import type { LakeSql, LakeTx, Row } from './db.js';

/**
 * Local fake sql.
 *
 * KeyRatiosRecompute.gatherInputs now issues queries the shared fake-db (which
 * models the lake.objects supersede machinery) does not recognise — the proper
 * TTM roll-up reads QUARTERLY/annual/ttm financial_statements separately, plus
 * momentum from public.ohlcv_daily, plus sector/currency from securities. Rather
 * than fork fake-db (owned elsewhere), we wrap it: gather-side reads are answered
 * here against a richer in-memory state, everything else (persist, objects,
 * key_ratios upsert, parse_runs) delegates to the shared fake so the lineage /
 * supersede invariants are still exercised end-to-end.
 */

interface StatementRec {
  security_id: string;
  statement_type: string;
  period_kind: string;
  period_end: string;
  is_estimate: boolean;
  line_items: Record<string, unknown>;
}
interface OhlcvRec {
  security_id: string;
  trade_date: string;
  close: number | null;
}
interface SecMeta {
  sector: string | null;
  currency: string | null;
}

interface RichState {
  fake: FakeState;
  statements: StatementRec[];
  ohlcv: OhlcvRec[];
  secMeta: Map<string, SecMeta>;
}

function richState(): RichState {
  return { fake: newState(), statements: [], ohlcv: [], secMeta: new Map() };
}

function seedSecurity(
  rs: RichState,
  over: { id?: string; shares?: string | null; sector?: string | null; currency?: string | null } = {},
): string {
  const id = over.id ?? '5001';
  rs.fake.securities.push({
    id,
    venue_code: 'TDWL',
    ticker: '7010',
    shares_outstanding: over.shares === undefined ? '1000' : over.shares,
    status: 'listed',
  });
  rs.secMeta.set(id, { sector: over.sector ?? null, currency: over.currency ?? null });
  return id;
}

function createRichDb(rs: RichState): LakeSql {
  const base = createFakeDb(rs.fake);

  const answer = (q: string, params: unknown[]): Row[] | null => {
    // securities — inject sector/currency the shared fake does not carry.
    if (q.includes('from public.securities') && q.includes("status = 'listed'")) {
      let secs = rs.fake.securities.filter((s) => s.status === 'listed');
      if (q.includes('id = any')) {
        const ids = (params[0] as number[]).map(String);
        secs = secs.filter((s) => ids.includes(s.id));
      }
      return secs.map((s) => {
        const m = rs.secMeta.get(s.id) ?? { sector: null, currency: null };
        return {
          id: s.id,
          venue_code: s.venue_code,
          shares_outstanding: s.shares_outstanding,
          sector: m.sector,
          currency: m.currency,
        };
      });
    }

    // financial_statements — period_kind-aware, returns ALL matching rows.
    if (q.includes('from public.financial_statements')) {
      const secId = params[0] as string;
      const kind = params[1] as string;
      let rows = rs.statements.filter(
        (s) => s.security_id === secId && s.statement_type === kind && !s.is_estimate,
      );
      if (q.includes("period_kind = 'quarter'")) rows = rows.filter((s) => s.period_kind === 'quarter');
      else if (q.includes("period_kind = 'annual'")) rows = rows.filter((s) => s.period_kind === 'annual');
      else if (q.includes('period_kind = ?')) {
        const pk = params[2] as string;
        rows = rows.filter((s) => s.period_kind === pk);
      } else if (q.includes("statement_type = 'balance'")) {
        // balanceStatement: statement_type bound as literal, secId is params[0].
        rows = rs.statements.filter(
          (s) => s.security_id === (params[0] as string) && s.statement_type === 'balance' && !s.is_estimate,
        );
      }
      rows = [...rows].sort((a, b) => (a.period_end < b.period_end ? 1 : -1));
      return rows.map((r) => ({ line_items: r.line_items }));
    }

    // ohlcv_daily — newest close first.
    if (q.includes('from public.ohlcv_daily')) {
      const secId = params[0] as string;
      const rows = rs.ohlcv
        .filter((o) => o.security_id === secId)
        .sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));
      return rows.map((o) => ({ close: o.close == null ? null : String(o.close) }));
    }

    return null;
  };

  const run = (strings: TemplateStringsArray, params: unknown[]): Promise<Row[]> => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
    const hit = answer(q, params);
    if (hit !== null) return Promise.resolve(hit);
    return base(strings, ...params);
  };

  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeSql;
  sql.begin = <T>(fn: (tx: LakeTx) => Promise<T>): Promise<T> => {
    const tx = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeTx;
    return fn(tx);
  };
  return sql;
}

// ── lineage / supersede behaviour (unchanged contract, richer fake) ──────────

test('recompute writes key_ratios + a VERIFIED COMPUTED.RATIOS lake object with lineage', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '1000' });
  rs.fake.quotesLatest.set(id, '50'); // last 50 → market cap 50_000
  rs.statements.push({
    security_id: id, statement_type: 'income', period_kind: 'ttm', period_end: '2026-06-30',
    is_estimate: false, line_items: { net_income: 5000, revenue: 20000 },
  });
  rs.statements.push({
    security_id: id, statement_type: 'balance', period_kind: 'annual', period_end: '2025-12-31',
    is_estimate: false, line_items: { total_equity: 25000 },
  });
  rs.fake.dividends.push({ security_id: id, state: 'live', dps: 2, ex_date: '2026-03-01' });

  const summary = await new KeyRatiosRecompute(createRichDb(rs)).run();
  assert.equal(summary.rowsWritten, 1);

  const kr = rs.fake.keyRatios.get(id)!;
  assert.ok(kr.source_object_id, 'key_ratios row carries lineage to the COMPUTED object');

  const computed = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS' && o.superseded_by === null)!;
  assert.equal(computed.state, 'VERIFIED');
  assert.equal(computed.verified_by, 'sys-0000');
  assert.equal(computed.numeric_value, '50000'); // market cap retained on the COMPUTED object for lineage
  // The COMPUTED.RATIOS payload carries NO metric_key, so in the live DB the 0007
  // datapoint fan-out short-circuits (market cap is never projected into
  // public.datapoints). The fake-db mirror does not model that gate; this count
  // reflects the PENDING→VERIFIED update, not a real datapoint write.
  assert.equal(rs.fake.datapointFanoutCalls.length, 1);
  assert.equal((computed.payload as Record<string, unknown>).metric_key, undefined); // no series binding
});

test('all-null inputs ⇒ no row written, no object', async () => {
  const rs = richState();
  seedSecurity(rs, { shares: null });
  // no quote, no statements, no dividends, no ohlcv
  const summary = await new KeyRatiosRecompute(createRichDb(rs)).run();
  assert.equal(summary.rowsWritten, 0);
  assert.equal(summary.rowsSkippedAllNull, 1);
  assert.equal(rs.fake.objects.length, 0);
  assert.equal(rs.fake.keyRatios.size, 0);
});

test('second nightly run supersedes the prior COMPUTED object (one live per key)', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '1000' });
  rs.fake.quotesLatest.set(id, '50');
  const run = () => new KeyRatiosRecompute(createRichDb(rs)).run();

  await run();
  const first = rs.fake.objects.find((o) => o.superseded_by === null)!;
  assert.equal(first.revision, 1);

  // price moves → recompute
  rs.fake.quotesLatest.set(id, '60');
  await run();

  const live = rs.fake.objects.filter((o) => o.object_type === 'COMPUTED.RATIOS' && o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].revision, 2);
  assert.equal(live[0].numeric_value, '60000');
  const retired = rs.fake.objects.find((o) => o.id === first.id)!;
  assert.equal(retired.state, 'RETIRED');
});

test('securityIds slice restricts the recompute set', async () => {
  const rs = richState();
  const a = seedSecurity(rs, { id: '1', shares: '10' });
  rs.fake.securities.push({ id: '2', venue_code: 'TDWL', ticker: 'OTHER', shares_outstanding: '10', status: 'listed' });
  rs.secMeta.set('2', { sector: null, currency: null });
  rs.fake.quotesLatest.set(a, '5');
  rs.fake.quotesLatest.set('2', '5');

  const summary = await new KeyRatiosRecompute(createRichDb(rs)).run([1]);
  assert.equal(summary.securitiesConsidered, 1);
  assert.equal(rs.fake.keyRatios.has('1'), true);
  assert.equal(rs.fake.keyRatios.has('2'), false);
});

// ── TTM assembly (the new gatherInputs behaviour) ────────────────────────────

/** Build a quarter income row; period_end drives newest-first ordering. */
function q(security_id: string, period_end: string, li: Record<string, unknown>): StatementRec {
  return { security_id, statement_type: 'income', period_kind: 'quarter', period_end, is_estimate: false, line_items: li };
}

test('gatherInputs sums the trailing 4 quarters into TTM flows (and 5..8 into prior-year)', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '100', currency: 'SAR' });
  rs.fake.quotesLatest.set(id, '20');
  // 8 quarters, newest first each with revenue/net_income/eps_diluted.
  // Trailing 4 (2026): revenue Σ = 4000, net_income Σ = 400, eps Σ = 4.
  rs.statements.push(q(id, '2026-12-31', { revenue: 1000, net_income: 100, eps_diluted: 1 }));
  rs.statements.push(q(id, '2026-09-30', { revenue: 1000, net_income: 100, eps_diluted: 1 }));
  rs.statements.push(q(id, '2026-06-30', { revenue: 1000, net_income: 100, eps_diluted: 1 }));
  rs.statements.push(q(id, '2026-03-31', { revenue: 1000, net_income: 100, eps_diluted: 1 }));
  // Prior 4 (2025): revenue Σ = 2000, eps Σ = 2.
  rs.statements.push(q(id, '2025-12-31', { revenue: 500, net_income: 50, eps_diluted: 0.5 }));
  rs.statements.push(q(id, '2025-09-30', { revenue: 500, net_income: 50, eps_diluted: 0.5 }));
  rs.statements.push(q(id, '2025-06-30', { revenue: 500, net_income: 50, eps_diluted: 0.5 }));
  rs.statements.push(q(id, '2025-03-31', { revenue: 500, net_income: 50, eps_diluted: 0.5 }));

  const summary = await new KeyRatiosRecompute(createRichDb(rs)).run();
  assert.equal(summary.rowsWritten, 1);

  const computed = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS')!;
  const p = computed.payload as Record<string, number>;
  // eps_ttm = Σ eps 4Q = 4; ps = market_cap (20*100=2000) / rev_ttm (4000) = 0.5.
  assert.equal(p.eps_ttm, 4);
  assert.equal(p.ps, 2000 / 4000);
  // revGrowthYoy = 4000/2000 − 1 = 1; epsGrowthYoy = 4/2 − 1 = 1.
  assert.equal(p.rev_growth_yoy, 1);
  assert.equal(p.eps_growth_yoy, 1);
  assert.equal(p.currency_computed as unknown as string, 'SAR');
});

test('gatherInputs falls back to the latest annual as TTM proxy when < 4 quarters', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '100' });
  rs.fake.quotesLatest.set(id, '10');
  // Only 2 quarters — not enough for a 4Q TTM → use latest annual proxy.
  rs.statements.push(q(id, '2026-06-30', { revenue: 900, net_income: 90 }));
  rs.statements.push(q(id, '2026-03-31', { revenue: 900, net_income: 90 }));
  rs.statements.push({
    security_id: id, statement_type: 'income', period_kind: 'annual', period_end: '2025-12-31',
    is_estimate: false, line_items: { revenue: 3000, net_income: 300 },
  });

  await new KeyRatiosRecompute(createRichDb(rs)).run();
  const computed = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS')!;
  const p = computed.payload as Record<string, number>;
  // ps uses the annual-proxy revenue 3000; market cap = 1000.
  assert.equal(p.ps, 1000 / 3000);
  assert.equal(p.roe, null); // no balance sheet → no equity
});

test('gatherInputs computes momentum returns from ohlcv_daily closes', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '100' });
  rs.fake.quotesLatest.set(id, '10');
  // 253 bars, newest first at index 0. close[i] = 100 - i so that:
  //   ret3m  = close[0]/close[63]  − 1 = 100/37 − 1
  //   ret6m  = close[0]/close[126] − 1 = 100/(-26)... avoid negatives:
  // use a strictly positive series close[i] = 300 - i (index 0..252 → 300..48).
  for (let i = 0; i < 253; i++) {
    const d = String(20260000 - i); // descending trade_date proxy (newest first)
    rs.ohlcv.push({ security_id: id, trade_date: d, close: 300 - i });
  }
  await new KeyRatiosRecompute(createRichDb(rs)).run();
  const p = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS')!.payload as Record<string, number>;
  assert.equal(p.ret_3m, 300 / (300 - 63) - 1);
  assert.equal(p.ret_6m, 300 / (300 - 126) - 1);
  assert.equal(p.ret_12_1, (300 - 21) / (300 - 252) - 1);
});

test('gatherInputs nulls a momentum return when the referenced bar is missing', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '100' });
  rs.fake.quotesLatest.set(id, '10');
  // Only 64 bars: enough for ret3m (needs index 63) but not ret6m/ret121.
  for (let i = 0; i < 64; i++) {
    rs.ohlcv.push({ security_id: id, trade_date: String(20260000 - i), close: 300 - i });
  }
  await new KeyRatiosRecompute(createRichDb(rs)).run();
  const p = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS')!.payload as Record<string, number | null>;
  assert.equal(p.ret_3m, 300 / (300 - 63) - 1);
  assert.equal(p.ret_6m, null);
  assert.equal(p.ret_12_1, null);
});

test('bank sector nulls gross/ev/net-debt but keeps nim in the persisted payload', async () => {
  const rs = richState();
  const id = seedSecurity(rs, { shares: '100', sector: 'Banks' });
  rs.fake.quotesLatest.set(id, '10');
  rs.statements.push({
    security_id: id, statement_type: 'income', period_kind: 'ttm', period_end: '2026-06-30',
    is_estimate: false,
    line_items: { revenue: 1000, gross_profit: 800, ebit: 300, net_income: 200, nii: 30 },
  });
  rs.statements.push({
    security_id: id, statement_type: 'balance', period_kind: 'annual', period_end: '2025-12-31',
    is_estimate: false,
    line_items: { total_equity: 1000, total_debt: 500, cash: 100, avg_earning_assets: 1000 },
  });

  await new KeyRatiosRecompute(createRichDb(rs)).run();
  const p = rs.fake.objects.find((o) => o.object_type === 'COMPUTED.RATIOS')!.payload as Record<string, number | null>;
  assert.equal(p.gross_margin, null);
  assert.equal(p.ev_ebitda, null);
  assert.equal(p.net_debt_ebitda, null);
  assert.equal(p.nim, 0.03); // 30 / 1000 kept
  assert.equal(p.net_margin, 0.2); // still valid
});

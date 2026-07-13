import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyRatiosRecompute } from './key-ratios.js';
import { createFakeDb, newState, type FakeState } from './fake-db.js';

function seedSecurity(state: FakeState, over: { id?: string; shares?: string | null } = {}): string {
  const id = over.id ?? '5001';
  state.securities.push({
    id,
    venue_code: 'TDWL',
    ticker: '7010',
    shares_outstanding: over.shares === undefined ? '1000' : over.shares,
    status: 'listed',
  });
  return id;
}

test('recompute writes key_ratios + a VERIFIED COMPUTED.RATIOS lake object with lineage', async () => {
  const state = newState();
  const id = seedSecurity(state, { shares: '1000' });
  state.quotesLatest.set(id, '50'); // last 50 → market cap 50_000
  state.statements.push({
    security_id: id, statement_type: 'income', period_kind: 'ttm', period_end: '2026-06-30',
    is_estimate: false, line_items: { net_income: 5000, revenue: 20000 },
  });
  state.statements.push({
    security_id: id, statement_type: 'balance', period_kind: 'annual', period_end: '2025-12-31',
    is_estimate: false, line_items: { total_equity: 25000 },
  });
  state.dividends.push({ security_id: id, state: 'live', dps: 2, ex_date: '2026-03-01' });

  const summary = await new KeyRatiosRecompute(createFakeDb(state)).run();
  assert.equal(summary.rowsWritten, 1);

  const kr = state.keyRatios.get(id)!;
  assert.ok(kr.source_object_id, 'key_ratios row carries lineage to the COMPUTED object');

  const computed = state.objects.find((o) => o.object_type === 'COMPUTED.RATIOS' && o.superseded_by === null)!;
  assert.equal(computed.state, 'VERIFIED');
  assert.equal(computed.verified_by, 'sys-0000');
  assert.equal(computed.numeric_value, '50000'); // market cap retained on the COMPUTED object for lineage
  // The COMPUTED.RATIOS payload carries NO metric_key, so in the live DB the 0007
  // datapoint fan-out short-circuits (market cap is never projected into
  // public.datapoints). The fake-db mirror does not model that gate; this count
  // reflects the PENDING→VERIFIED update, not a real datapoint write.
  assert.equal(state.datapointFanoutCalls.length, 1);
  assert.equal((computed.payload as Record<string, unknown>).metric_key, undefined); // no series binding
});

test('all-null inputs ⇒ no row written, no object', async () => {
  const state = newState();
  seedSecurity(state, { shares: null });
  // no quote, no statements, no dividends
  const summary = await new KeyRatiosRecompute(createFakeDb(state)).run();
  assert.equal(summary.rowsWritten, 0);
  assert.equal(summary.rowsSkippedAllNull, 1);
  assert.equal(state.objects.length, 0);
  assert.equal(state.keyRatios.size, 0);
});

test('second nightly run supersedes the prior COMPUTED object (one live per key)', async () => {
  const state = newState();
  const id = seedSecurity(state, { shares: '1000' });
  state.quotesLatest.set(id, '50');
  const run = () => new KeyRatiosRecompute(createFakeDb(state)).run();

  await run();
  const first = state.objects.find((o) => o.superseded_by === null)!;
  assert.equal(first.revision, 1);

  // price moves → recompute
  state.quotesLatest.set(id, '60');
  await run();

  const live = state.objects.filter((o) => o.object_type === 'COMPUTED.RATIOS' && o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].revision, 2);
  assert.equal(live[0].numeric_value, '60000');
  const retired = state.objects.find((o) => o.id === first.id)!;
  assert.equal(retired.state, 'RETIRED');
});

test('securityIds slice restricts the recompute set', async () => {
  const state = newState();
  const a = seedSecurity(state, { id: '1', shares: '10' });
  state.securities.push({ id: '2', venue_code: 'TDWL', ticker: 'OTHER', shares_outstanding: '10', status: 'listed' });
  state.quotesLatest.set(a, '5');
  state.quotesLatest.set('2', '5');

  const summary = await new KeyRatiosRecompute(createFakeDb(state)).run([1]);
  assert.equal(summary.securitiesConsidered, 1);
  assert.equal(state.keyRatios.has('1'), true);
  assert.equal(state.keyRatios.has('2'), false);
});

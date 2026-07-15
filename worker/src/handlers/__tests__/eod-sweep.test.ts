import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEodSweep, eodCloseGate } from '../eod-sweep.js';
import { makeFakeSql, makeCtx, makeFakeRuntime, makeSource, makeRunResult, activeAgentRows } from './fakes.js';

/**
 * Canned close-gate row that puts now() exactly at the venue close on the trade
 * date, i.e. inside the post-close window (eodCloseGate ⇒ open). The query is
 * matched by the `public.market_sessions` substring.
 */
function openCloseGateRows(tradeDate = '2026-07-13', closeLocal = '13:00:00') {
  return [
    {
      local_time: closeLocal,
      local_date: tradeDate,
      close_local: closeLocal,
      venue_active: true,
      trading_day: true,
      holiday: false,
    },
  ];
}

/** One canned gate row = the open row with field overrides. */
function gateRow(overrides: Record<string, unknown> = {}) {
  return [{ ...openCloseGateRows()[0]!, ...overrides }];
}

test('eod_sweep: runs eod sources for the venue with the trade date threaded through', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('public.market_sessions', openCloseGateRows());
  fakeSql.on('iam.agent_accounts', activeAgentRows());

  const runtime = makeFakeRuntime({
    eodSourcesForVenue: async (venue) => [makeSource({ id: 301, venue, dataType: 'eod_bulletin' })],
  });

  await makeEodSweep(runtime)(
    { handler: 'eod_sweep', venue: 'BHB', tradeDate: '2026-07-13' },
    makeCtx(fakeSql.sql),
  );

  assert.equal(runtime.calls.runTask.length, 1);
  assert.equal(runtime.calls.runTask[0]!.tradeDate, '2026-07-13', 'tradeDate passed to runTask');
});

test('eod_sweep: enqueues cross_check for staged EOD keys with 2 sources', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('public.market_sessions', openCloseGateRows());
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  const key = { naturalKey: 'OHLCV.CLOSE:BHB:BATELCO:2026-07-13', objectType: 'OHLCV.CLOSE' };
  const runtime = makeFakeRuntime({
    runTask: async () => makeRunResult({ stagedKeys: [key] }),
    countStagingSources: async () => 2,
  });

  await makeEodSweep(runtime)(
    { handler: 'eod_sweep', venue: 'BHB', tradeDate: '2026-07-13' },
    makeCtx(fakeSql.sql),
  );
  assert.equal(fakeSql.queries.filter((q) => q.text.includes('pgmq.send')).length, 1);
});

test('eod_sweep: bad tradeDate throws', async () => {
  const fakeSql = makeFakeSql();
  await assert.rejects(
    () =>
      makeEodSweep(makeFakeRuntime())(
        { handler: 'eod_sweep', venue: 'BHB', tradeDate: 'yesterday' } as never,
        makeCtx(fakeSql.sql),
      ),
    /invalid tradeDate/,
  );
});

test('eod_sweep: no active eod sources ⇒ no-op', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('public.market_sessions', openCloseGateRows());
  const runtime = makeFakeRuntime({
    eodSourcesForVenue: async () => [makeSource({ active: false, dataType: 'eod_bulletin' })],
  });
  await makeEodSweep(runtime)(
    { handler: 'eod_sweep', venue: 'BHB', tradeDate: '2026-07-13' },
    makeCtx(fakeSql.sql),
  );
  assert.equal(runtime.calls.runTask.length, 0);
});

test('eod_sweep: outside the post-close window ⇒ skipped, no fetch', async () => {
  const fakeSql = makeFakeSql();
  // now() is well before the venue close on the trade date ⇒ gate closed.
  fakeSql.on('public.market_sessions', gateRow({ local_time: '09:30:00' }));
  const runtime = makeFakeRuntime();
  await makeEodSweep(runtime)(
    { handler: 'eod_sweep', venue: 'BHB', tradeDate: '2026-07-13' },
    makeCtx(fakeSql.sql),
  );
  assert.equal(runtime.calls.runTask.length, 0, 'no fetch outside post-close window');
});

test('eodCloseGate: open at close, closed before close and past window', async () => {
  const openSql = makeFakeSql();
  openSql.on('public.market_sessions', openCloseGateRows('2026-07-13', '13:00:00'));
  assert.deepEqual(await eodCloseGate(openSql.sql, 'BHB', '2026-07-13'), { open: true });

  const beforeSql = makeFakeSql();
  beforeSql.on('public.market_sessions', gateRow({ local_time: '12:59:00' }));
  const before = await eodCloseGate(beforeSql.sql, 'BHB', '2026-07-13');
  assert.equal(before.open, false);

  const pastSql = makeFakeSql();
  pastSql.on('public.market_sessions', gateRow({ local_time: '18:00:00' }));
  const past = await eodCloseGate(pastSql.sql, 'BHB', '2026-07-13');
  assert.equal(past.open, false);

  const wrongDaySql = makeFakeSql();
  wrongDaySql.on('public.market_sessions', gateRow({ local_time: '13:30:00', local_date: '2026-07-14' }));
  const wrongDay = await eodCloseGate(wrongDaySql.sql, 'BHB', '2026-07-13');
  assert.equal(wrongDay.open, false);
});

test('eodCloseGate: closed on weekends and market holidays even inside the post-close window', async () => {
  // The eod_bulletin schedule is session_only=false, so the gate is the ONLY
  // calendar check: a BHB Friday (dow ∉ trading_days) or a seeded holiday must
  // close the gate even at close+30, or the sweep fetches the PREVIOUS
  // session's bulletin stamped with the non-trading tradeDate.
  const weekendSql = makeFakeSql();
  weekendSql.on('public.market_sessions', gateRow({ trading_day: false }));
  const weekend = await eodCloseGate(weekendSql.sql, 'BHB', '2026-07-13');
  assert.deepEqual(weekend, { open: false, reason: 'non_trading_day' });

  const holidaySql = makeFakeSql();
  holidaySql.on('public.market_sessions', gateRow({ holiday: true }));
  const holiday = await eodCloseGate(holidaySql.sql, 'BHB', '2026-07-13');
  assert.deepEqual(holiday, { open: false, reason: 'market_holiday' });

  // And the gate query must actually consult the calendar tables.
  const q = weekendSql.queries.find((x) => x.text.includes('public.market_sessions'));
  assert.ok(q!.text.includes('trading_days'), 'gate reads venues.trading_days');
  assert.ok(q!.text.includes('public.market_holidays'), 'gate reads market_holidays');
});

test('eodCloseGate: date/time columns are cast to text in SQL (postgres.js Date-object regression)', async () => {
  // postgres.js parses bare date/timestamp columns into JS Date objects, which
  // can never === a 'YYYY-MM-DD' tradeDate string — that mismatch kept the gate
  // permanently closed in production (zero eod_bulletin fetches ever). Guard the
  // fix: the gate query must produce local_date/local_time via to_char and cast
  // close_local to text, so the driver returns strings end-to-end.
  const fakeSql = makeFakeSql();
  fakeSql.on('public.market_sessions', openCloseGateRows());
  await eodCloseGate(fakeSql.sql, 'BHB', '2026-07-13');
  const gateQuery = fakeSql.queries.find((q) => q.text.includes('public.market_sessions'));
  assert.ok(gateQuery, 'gate query recorded');
  assert.match(gateQuery!.text, /to_char\(\(select ts from now_local\), 'HH24:MI:SS'\)/);
  assert.match(gateQuery!.text, /to_char\(\(select ts from now_local\)::date, 'YYYY-MM-DD'\)/);
  assert.match(gateQuery!.text, /close_local::text/);
});

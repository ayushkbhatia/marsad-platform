import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOhlcvAccrual } from '../ohlcv-accrual.js';
import { makeFakeSql, makeCtx } from './fakes.js';

test('ohlcv_accrual invokes accrue_ohlcv_from_quotes with the payload trade date', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('accrue_ohlcv_from_quotes', [{ n: 123 }]);

  await makeOhlcvAccrual()({ handler: 'ohlcv_accrual', tradeDate: '2026-07-13' }, makeCtx(fakeSql.sql));

  const call = fakeSql.queries.find((q) => q.text.includes('accrue_ohlcv_from_quotes'));
  assert.ok(call, 'accrual function was invoked');
  assert.deepEqual(call!.values, ['2026-07-13']);

  // heartbeat run + ok were written
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ops.job_heartbeats') && q.text.includes('last_ok_at')),
    'heartbeatOk written on success',
  );
});

test('ohlcv_accrual defaults to the current UTC date when tradeDate is absent', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('accrue_ohlcv_from_quotes', [{ n: 0 }]);
  const today = new Date().toISOString().slice(0, 10);

  await makeOhlcvAccrual()({ handler: 'ohlcv_accrual' }, makeCtx(fakeSql.sql));

  const call = fakeSql.queries.find((q) => q.text.includes('accrue_ohlcv_from_quotes'));
  assert.deepEqual(call!.values, [today]);
});

test('ohlcv_accrual rejects a malformed tradeDate and falls back to today (no bogus date reaches SQL)', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('accrue_ohlcv_from_quotes', [{ n: 0 }]);
  const today = new Date().toISOString().slice(0, 10);

  await makeOhlcvAccrual()({ handler: 'ohlcv_accrual', tradeDate: 'not-a-date' }, makeCtx(fakeSql.sql));

  const call = fakeSql.queries.find((q) => q.text.includes('accrue_ohlcv_from_quotes'));
  assert.deepEqual(call!.values, [today]);
});

test('ohlcv_accrual writes an error heartbeat and rethrows on SQL failure', async () => {
  // A fake sql that throws on the accrual call but records heartbeat writes.
  const writes: string[] = [];
  const tag = (strings: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    writes.push(text);
    if (text.includes('accrue_ohlcv_from_quotes')) return Promise.reject(new Error('boom'));
    return Promise.resolve([]);
  };
  const ctx = makeCtx(tag as never);

  await assert.rejects(
    () => makeOhlcvAccrual()({ handler: 'ohlcv_accrual', tradeDate: '2026-07-13' }, ctx),
    /boom/,
  );
  assert.ok(writes.some((t) => t.includes('ops.job_heartbeats') && t.includes('consecutive_failures')),
    'error heartbeat written');
});

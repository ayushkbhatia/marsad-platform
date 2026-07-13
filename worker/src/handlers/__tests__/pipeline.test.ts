import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCrossCheck } from '../cross-check.js';
import { makeKeyRatiosRecompute } from '../key-ratios-recompute.js';
import { makeFakeSql, makeCtx, makeFakeRuntime } from './fakes.js';

test('cross_check: resolves under the pipeline principal', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('pause_all_agents', [{ globally_paused: false }]);

  const runtime = makeFakeRuntime();
  await makeCrossCheck(runtime)(
    { handler: 'cross_check', naturalKey: 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1', objectType: 'DIVIDEND.EXDATE' },
    makeCtx(fakeSql.sql),
  );

  assert.equal(runtime.calls.crossCheckResolve.length, 1);
  assert.equal(runtime.calls.crossCheckResolve[0]!.objectType, 'DIVIDEND.EXDATE');
  // GUCs set to the pipeline principal
  assert.ok(
    fakeSql.queries.some(
      (q) => q.text.includes('set_config') && q.values.includes('00000000-0000-0000-0000-000000000001'),
    ),
  );
});

test('cross_check: globally paused ⇒ skip, no resolve', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('pause_all_agents', [{ globally_paused: true }]);
  const runtime = makeFakeRuntime();
  await makeCrossCheck(runtime)(
    { handler: 'cross_check', naturalKey: 'k', objectType: 't' },
    makeCtx(fakeSql.sql),
  );
  assert.equal(runtime.calls.crossCheckResolve.length, 0);
});

test('cross_check: missing keys throws', async () => {
  const fakeSql = makeFakeSql();
  await assert.rejects(
    () => makeCrossCheck(makeFakeRuntime())({ handler: 'cross_check' } as never, makeCtx(fakeSql.sql)),
    /missing naturalKey/,
  );
});

test('key_ratios_recompute: full rebuild when no securityIds', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('pause_all_agents', [{ globally_paused: false }]);
  const runtime = makeFakeRuntime();
  await makeKeyRatiosRecompute(runtime)({ handler: 'key_ratios_recompute' }, makeCtx(fakeSql.sql));
  assert.equal(runtime.calls.recomputeKeyRatios.length, 1);
  assert.equal(runtime.calls.recomputeKeyRatios[0], undefined);
});

test('key_ratios_recompute: scoped rebuild passes securityIds through', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('pause_all_agents', [{ globally_paused: false }]);
  const runtime = makeFakeRuntime();
  await makeKeyRatiosRecompute(runtime)(
    { handler: 'key_ratios_recompute', securityIds: [7010, 2222] },
    makeCtx(fakeSql.sql),
  );
  assert.deepEqual(runtime.calls.recomputeKeyRatios[0], [7010, 2222]);
});

test('key_ratios_recompute: globally paused ⇒ skip', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('pause_all_agents', [{ globally_paused: true }]);
  const runtime = makeFakeRuntime();
  await makeKeyRatiosRecompute(runtime)({ handler: 'key_ratios_recompute' }, makeCtx(fakeSql.sql));
  assert.equal(runtime.calls.recomputeKeyRatios.length, 0);
});

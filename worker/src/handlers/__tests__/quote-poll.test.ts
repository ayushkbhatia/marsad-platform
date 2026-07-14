import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuotePoll } from '../quote-poll.js';
import {
  makeFakeSql,
  makeCtx,
  makeFakeRuntime,
  makeSource,
  makeRunResult,
  activeAgentRows,
} from './fakes.js';

test('quote_poll: runs the task under the resolved agent principal, with no held identity tx', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows('pid-QE'));

  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 101, venue: 'QE' }),
  });

  const handler = makeQuotePoll(runtime);
  await handler({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));

  // runTask was invoked for the source, and the resolved agent principal is threaded to it as a
  // VALUE (the runtime sets its own identity from it — the handler no longer holds an identity tx).
  assert.equal(runtime.calls.runTask.length, 1);
  assert.equal(runtime.calls.runTask[0]!.sourceId, 101);
  assert.equal(runtime.calls.runTask[0]!.agentPrincipalId, 'pid-QE');

  // No handler-side set_config: the old runAsAgent tx held a connection idle across the WHOLE
  // runTask (pool-deadlock under concurrency), and its GUC never reached runTask's own connection.
  assert.ok(
    !fakeSql.queries.some((q) => q.text.includes('set_config')),
    'no handler-side identity tx / set_config',
  );
});

test('quote_poll: enqueues cross_check only when >=2 independent sources stage a key', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());

  const key = { naturalKey: 'QUOTE.LAST:QE:QNBK', objectType: 'QUOTE.LAST' };
  let count = 2;
  const runtime = makeFakeRuntime({
    runTask: async () => makeRunResult({ stagedKeys: [key] }),
    countStagingSources: async () => count,
  });

  const handler = makeQuotePoll(runtime);
  await handler({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));

  const sends = fakeSql.queries.filter((q) => q.text.includes('pgmq.send'));
  assert.equal(sends.length, 1, 'one cross_check enqueued at 2 sources');

  // Now with a single source: no enqueue.
  const fakeSql2 = makeFakeSql();
  fakeSql2.on('iam.agent_accounts', activeAgentRows());
  count = 1;
  await makeQuotePoll(runtime)({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql2.sql));
  const sends2 = fakeSql2.queries.filter((q) => q.text.includes('pgmq.send'));
  assert.equal(sends2.length, 0, 'single source ⇒ no cross_check');
});

test('quote_poll: de-dups the same staged key across tasks into one cross_check', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());

  const key = { naturalKey: 'QUOTE.LAST:QE:QNBK', objectType: 'QUOTE.LAST' };
  let countCalls = 0;
  const runtime = makeFakeRuntime({
    // two tasks (quotes + indices) both stage the same key
    tasksForSource: () =>
      [
        { dataType: 'quotes', parserVersion: 1, fetch: async () => [], parse: () => ({ rows: [], parserVersion: 1 }) },
        { dataType: 'indices', parserVersion: 1, fetch: async () => [], parse: () => ({ rows: [], parserVersion: 1 }) },
      ] as never,
    runTask: async () => makeRunResult({ stagedKeys: [key] }),
    countStagingSources: async () => {
      countCalls += 1;
      return 2;
    },
  });

  await makeQuotePoll(runtime)({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));
  const sends = fakeSql.queries.filter((q) => q.text.includes('pgmq.send'));
  assert.equal(sends.length, 1, 'duplicate key enqueued once');
  assert.equal(countCalls, 1, 'counted the distinct key exactly once (deduped across tasks)');
});

test('quote_poll: agent paused ⇒ clean skip, no runTask, no throw', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', [{ principal_id: 'p', run_enabled: false, globally_paused: false }]);

  const runtime = makeFakeRuntime();
  await makeQuotePoll(runtime)({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));

  assert.equal(runtime.calls.runTask.length, 0, 'paused agent does not fetch');
  const skips = fakeSql.queries.filter((q) => q.text.includes('ingest.fetch_log'));
  assert.ok(skips.length >= 1, 'a skip fetch_log row is written');
});

test('quote_poll: globally paused ⇒ clean skip', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', [{ principal_id: 'p', run_enabled: true, globally_paused: true }]);
  const runtime = makeFakeRuntime();
  await makeQuotePoll(runtime)({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));
  assert.equal(runtime.calls.runTask.length, 0);
});

test('quote_poll: inactive source ⇒ skip before agent resolution', async () => {
  const fakeSql = makeFakeSql();
  const runtime = makeFakeRuntime({ loadSource: async () => makeSource({ active: false }) });
  await makeQuotePoll(runtime)({ handler: 'quote_poll', sourceId: 101 }, makeCtx(fakeSql.sql));
  assert.equal(runtime.calls.runTask.length, 0);
  // never queried iam identity
  assert.ok(!fakeSql.queries.some((q) => q.text.includes('iam.agent_accounts')));
});

test('quote_poll: missing sourceId throws (bad envelope)', async () => {
  const fakeSql = makeFakeSql();
  const runtime = makeFakeRuntime();
  await assert.rejects(
    () => makeQuotePoll(runtime)({ handler: 'quote_poll' } as never, makeCtx(fakeSql.sql)),
    /missing\/invalid sourceId/,
  );
});

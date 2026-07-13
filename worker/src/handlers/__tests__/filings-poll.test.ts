import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFilingsPoll } from '../filings-poll.js';
import { makeFakeSql, makeCtx, makeFakeRuntime, makeSource, makeRunResult, activeAgentRows } from './fakes.js';

test('filings_poll: new external_ids ⇒ pending seen_items + single filing_detail wake-up', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  // seen_items insert RETURNING external_id yields the genuinely-new ids that
  // drive the single wake-up enqueue.
  fakeSql.on('ingest.seen_items', [
    { external_id: 'CG-1-2026-4471' },
    { external_id: 'CG-1-2026-4472' },
  ]);

  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 200, venue: 'TDWL', dataType: 'filings_list' }),
    agentAccountForSource: () => 'DATA-FILINGS',
    filingDetailSourceId: async () => 201,
    runTask: async () => makeRunResult({ newExternalIds: ['CG-1-2026-4471', 'CG-1-2026-4472'] }),
  });

  await makeFilingsPoll(runtime)({ handler: 'filings_poll', sourceId: 200 }, makeCtx(fakeSql.sql));

  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ingest.seen_items')),
    'records pending seen_items for list-diff (the per-id detail targets)',
  );
  const jobQueueInserts = fakeSql.queries.filter((q) => q.text.includes('into ingest.job_queue'));
  assert.equal(jobQueueInserts.length, 1, 'exactly one filing_detail wake-up row (not N)');
});

test('filings_poll: no new ids ⇒ no seen_items / no enqueue', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ dataType: 'filings_list' }),
    agentAccountForSource: () => 'DATA-FILINGS',
    runTask: async () => makeRunResult({ newExternalIds: [] }),
  });

  await makeFilingsPoll(runtime)({ handler: 'filings_poll', sourceId: 200 }, makeCtx(fakeSql.sql));
  assert.ok(!fakeSql.queries.some((q) => q.text.includes('ingest.seen_items')));
  assert.ok(!fakeSql.queries.some((q) => q.text.includes('into ingest.job_queue')));
});

test('filings_poll: venue without a filing_detail source records seen_items but enqueues nothing', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ dataType: 'filings_list' }),
    agentAccountForSource: () => 'DATA-FILINGS',
    filingDetailSourceId: async () => null,
    runTask: async () => makeRunResult({ newExternalIds: ['X-1'] }),
  });

  await makeFilingsPoll(runtime)({ handler: 'filings_poll', sourceId: 200 }, makeCtx(fakeSql.sql));
  assert.ok(fakeSql.queries.some((q) => q.text.includes('ingest.seen_items')), 'still records seen');
  assert.ok(!fakeSql.queries.some((q) => q.text.includes('into ingest.job_queue')), 'no detail source ⇒ no enqueue');
});

test('filings_poll: dedups repeated external ids before enqueue', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  fakeSql.on('into ingest.job_queue', [{ id: '1' }]);
  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ dataType: 'filings_list' }),
    agentAccountForSource: () => 'DATA-FILINGS',
    filingDetailSourceId: async () => 201,
    runTask: async () => makeRunResult({ newExternalIds: ['DUP', 'DUP'] }),
  });

  await makeFilingsPoll(runtime)({ handler: 'filings_poll', sourceId: 200 }, makeCtx(fakeSql.sql));
  const seen = fakeSql.queries.find((q) => q.text.includes('ingest.seen_items'));
  assert.ok(seen, 'seen_items written');
  // the deduped array marker carries exactly one element
  const arrayArg = seen!.values.find((v) => v && typeof v === 'object' && '__array' in (v as object)) as
    | { __array: string[] }
    | undefined;
  assert.deepEqual(arrayArg?.__array, ['DUP']);
});

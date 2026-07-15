import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoragePurge, type StorageDeleteTransport } from '../storage-purge.js';
import type { HandlerContext } from '../index.js';
import type { WorkerConfig } from '../../config.js';
import { makeFakeSql, makeSilentLogger } from './fakes.js';

interface DeleteCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  prefixes: string[];
}

/** A fake Storage transport that records DELETE calls and returns a canned status. */
function fakeTransport(status = 200): { transport: StorageDeleteTransport; calls: DeleteCall[] } {
  const calls: DeleteCall[] = [];
  const transport: StorageDeleteTransport = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      prefixes: (JSON.parse(init.body) as { prefixes: string[] }).prefixes,
    });
    return { status, text: async () => (status >= 300 ? 'boom' : '') };
  };
  return { transport, calls };
}

function makeCtx(sql: HandlerContext['sql'], configOver: Partial<WorkerConfig> = {}): HandlerContext {
  return {
    sql,
    log: makeSilentLogger(),
    config: {
      workerId: 'test-worker',
      supabaseUrl: 'https://proj.supabase.co',
      supabaseServiceRoleKey: 'svc-key',
      ...configOver,
    } as unknown as WorkerConfig,
    queue: 'q_maintenance',
    msgId: '1',
    readCt: 0,
  };
}

test('storage_purge deletes a batch via the Storage API and stamps deleted_at', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('select storage_path', [
    { storage_path: 'raw/a.gz', bucket: 'lake-raw' },
    { storage_path: 'raw/b.gz', bucket: 'lake-raw' },
  ]);
  const { transport, calls } = fakeTransport();

  await makeStoragePurge({ transport })({ handler: 'storage_purge' }, makeCtx(fakeSql.sql));

  assert.equal(calls.length, 1, 'one bulk delete for the single bucket');
  assert.equal(calls[0]!.url, 'https://proj.supabase.co/storage/v1/object/lake-raw');
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.headers.authorization, 'Bearer svc-key');
  assert.deepEqual(calls[0]!.prefixes, ['raw/a.gz', 'raw/b.gz']);

  const stamp = fakeSql.queries.find(
    (q) => q.text.includes('update ops.storage_purge_queue') && q.text.includes('set deleted_at'),
  );
  assert.ok(stamp, 'deleted_at stamped for the batch');
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ops.job_heartbeats') && q.text.includes('last_ok_at')),
    'heartbeatOk written on success',
  );
});

test('storage_purge issues one delete per distinct bucket', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('select storage_path', [
    { storage_path: 'raw/a.gz', bucket: 'lake-raw' },
    { storage_path: 'pdf/x.pdf', bucket: 'filings-pdf' },
    { storage_path: 'raw/b.gz', bucket: 'lake-raw' },
  ]);
  const { transport, calls } = fakeTransport();

  await makeStoragePurge({ transport })({ handler: 'storage_purge' }, makeCtx(fakeSql.sql));

  assert.equal(calls.length, 2, 'grouped into two per-bucket deletes');
  const lakeRaw = calls.find((c) => c.url.endsWith('/lake-raw'));
  const filings = calls.find((c) => c.url.endsWith('/filings-pdf'));
  assert.deepEqual(lakeRaw!.prefixes, ['raw/a.gz', 'raw/b.gz']);
  assert.deepEqual(filings!.prefixes, ['pdf/x.pdf']);
});

test('storage_purge self-chains a follow-up when a full batch exhausts maxBatches', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('select storage_path', [
    { storage_path: 'raw/a.gz', bucket: 'lake-raw' },
    { storage_path: 'raw/b.gz', bucket: 'lake-raw' },
  ]);
  const { transport } = fakeTransport();

  await makeStoragePurge({ transport })(
    { handler: 'storage_purge', limit: 2, maxBatches: 1 },
    makeCtx(fakeSql.sql),
  );

  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('pgmq.send')),
    'self-chained a follow-up storage_purge message',
  );
});

test('storage_purge drains empty queue as a no-op (no delete, heartbeat ok)', async () => {
  const fakeSql = makeFakeSql(); // no canned rows ⇒ select returns []
  const { transport, calls } = fakeTransport();

  await makeStoragePurge({ transport })({ handler: 'storage_purge' }, makeCtx(fakeSql.sql));

  assert.equal(calls.length, 0, 'nothing to delete');
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ops.job_heartbeats') && q.text.includes('last_ok_at')),
    'heartbeatOk still written',
  );
  assert.ok(!fakeSql.queries.some((q) => q.text.includes('pgmq.send')), 'no self-chain when drained');
});

test('storage_purge skips (no throw) when Storage credentials are unconfigured', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('select storage_path', [{ storage_path: 'raw/a.gz', bucket: 'lake-raw' }]);
  const { transport, calls } = fakeTransport();

  await makeStoragePurge({ transport })(
    { handler: 'storage_purge' },
    makeCtx(fakeSql.sql, { supabaseServiceRoleKey: undefined }),
  );

  assert.equal(calls.length, 0, 'no Storage call attempted');
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ops.job_heartbeats') && q.text.includes('consecutive_failures')),
    'error heartbeat written',
  );
  assert.ok(
    !fakeSql.queries.some((q) => q.text.includes('set deleted_at')),
    'nothing stamped when it cannot delete',
  );
});

test('storage_purge throws + error-heartbeats on a non-2xx Storage response (rows stay queued)', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('select storage_path', [{ storage_path: 'raw/a.gz', bucket: 'lake-raw' }]);
  const { transport } = fakeTransport(500);

  await assert.rejects(
    () => makeStoragePurge({ transport })({ handler: 'storage_purge' }, makeCtx(fakeSql.sql)),
    /storage_purge delete failed \(500\)/,
  );
  assert.ok(
    !fakeSql.queries.some((q) => q.text.includes('set deleted_at')),
    'no stamp after a failed delete — rows remain for retry',
  );
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes('ops.job_heartbeats') && q.text.includes('consecutive_failures')),
    'error heartbeat written',
  );
});

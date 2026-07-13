import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runParse } from './parse-harness.js';
import type {
  TaskSpec,
  StoredSnapshot,
  ParseRunRecorder,
  NormalizedQuote,
} from './types.js';

function fakeRecorder(): { recorder: ParseRunRecorder; last: () => any } {
  let last: any = null;
  return {
    recorder: {
      async record(input) {
        last = input;
        return 42;
      },
    },
    last: () => last,
  };
}

const snapshot: StoredSnapshot = {
  snapshotId: 7,
  sourceId: 1,
  venue: 'QE',
  dataType: 'quotes',
  contentType: 'application/json',
  externalId: null,
  body: Buffer.from('{"rows":[{"Symbol":"QNBK","LastPrice":16.1}]}'),
  fetchedAt: '2026-07-13T12:00:00.000Z',
  meta: {},
};

function makeTask(
  parse: TaskSpec<NormalizedQuote>['parse'],
  parserVersion = 1,
): TaskSpec<NormalizedQuote> {
  return {
    dataType: 'quotes',
    parserVersion,
    async fetch() {
      return [];
    },
    parse,
  };
}

test('runParse: ok path records status ok + row count', async () => {
  const { recorder, last } = fakeRecorder();
  const task = makeTask((s) => {
    const parsed = JSON.parse(s.body.toString());
    return {
      parserVersion: 1,
      rows: parsed.rows.map((r: any) => ({
        venue: 'QE' as const,
        ticker: r.Symbol,
        last: r.LastPrice,
        change: null,
        changePct: null,
        open: null,
        high: null,
        low: null,
        volume: null,
        asOf: s.fetchedAt,
      })),
    };
  });
  const res = await runParse(task, snapshot, { recorder });
  assert.equal(res.status, 'ok');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]!.ticker, 'QNBK');
  assert.equal(last().status, 'ok');
  assert.equal(last().rowsEmitted, 1);
  assert.equal(res.parseRunId, 42);
});

test('runParse: zero rows on a stored (changed) snapshot ⇒ drift_zero_rows', async () => {
  const { recorder, last } = fakeRecorder();
  const task = makeTask(() => ({ parserVersion: 1, rows: [] }));
  const res = await runParse(task, snapshot, { recorder });
  assert.equal(res.status, 'drift_zero_rows');
  assert.equal(last().status, 'drift_zero_rows');
  assert.equal(last().rowsEmitted, 0);
});

test('runParse: parser throwing ⇒ status error, no rethrow', async () => {
  const { recorder, last } = fakeRecorder();
  const task = makeTask(() => {
    throw new Error('boom');
  });
  const res = await runParse(task, snapshot, { recorder });
  assert.equal(res.status, 'error');
  assert.match(res.error ?? '', /boom/);
  assert.equal(last().status, 'error');
});

test('runParse: parserVersion mismatch ⇒ error (contract guard)', async () => {
  const { recorder } = fakeRecorder();
  const task = makeTask(
    () => ({ parserVersion: 9, rows: [{} as NormalizedQuote] }),
    1,
  );
  const res = await runParse(task, snapshot, { recorder });
  assert.equal(res.status, 'error');
  assert.match(res.error ?? '', /mismatch/);
});

test('runParse: parse is pure — must not read wall clock (contract note)', async () => {
  // We cannot fully enforce purity, but we assert parse receives ONLY the
  // snapshot and no context object with now()/http.
  const { recorder } = fakeRecorder();
  const task = makeTask((s) => {
    // parse receives only the snapshot — no transport, no clock injected.
    assert.equal((s as unknown as { http?: unknown }).http, undefined);
    assert.equal((s as unknown as { now?: unknown }).now, undefined);
    return { parserVersion: 1, rows: [{ ticker: 'X' } as NormalizedQuote] };
  });
  const res = await runParse(task, snapshot, { recorder });
  assert.equal(res.status, 'ok');
});

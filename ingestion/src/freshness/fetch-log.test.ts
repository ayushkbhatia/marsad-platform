import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFetchLogWriter, formatFetchError, outcomeEscalates } from './fetch-log.js';
import type { SqlLike } from './fetch-log.js';
import type { FetchOutcome } from './types.js';
import { FetchError } from './types.js';

/** A recording fake of the postgres.js tagged-template Sql. */
function fakeSql() {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql: SqlLike = (<T,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([] as T[]);
  }) as SqlLike;
  return { sql, calls };
}

const base: Omit<FetchOutcome, 'error' | 'changed'> = {
  sourceId: 7,
  venue: 'QE',
  httpStatus: 200,
  durationMs: 123,
};

test('success advances last_success_at and zeroes consecutive_failures', async () => {
  const { sql, calls } = fakeSql();
  const w = createFetchLogWriter({ sql });
  await w.record({ ...base, changed: true });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.text, /insert into ingest.fetch_log/);
  assert.match(calls[1]!.text, /update ingest.sources/);
  assert.match(calls[1]!.text, /last_success_at = now\(\)/);
  assert.match(calls[1]!.text, /consecutive_failures = 0/);
});

test('UNCHANGED (deduped) success still advances last_success_at', async () => {
  // Critical: off-peak quiet boards dedupe; without this write the venue would
  // drift to offline despite the feed being healthy.
  const { sql, calls } = fakeSql();
  const w = createFetchLogWriter({ sql });
  await w.record({ ...base, changed: false });
  assert.equal(calls[0]!.values.includes(false), true); // changed=false logged
  assert.match(calls[1]!.text, /last_success_at = now\(\)/);
});

test('failure increments consecutive_failures and logs the class', async () => {
  const { sql, calls } = fakeSql();
  const w = createFetchLogWriter({ sql });
  await w.record({
    ...base,
    httpStatus: 404,
    changed: false,
    error: new FetchError('HTTP_4XX', 'not found', { status: 404 }),
  });
  // error string present in the fetch_log insert values
  const errVal = calls[0]!.values.find((v) => typeof v === 'string' && v.includes('HTTP_4XX'));
  assert.ok(errVal, 'expected formatted error in fetch_log values');
  assert.match(calls[1]!.text, /consecutive_failures = consecutive_failures \+ 1/);
});

test('fetch_log write failure never throws (telemetry must not kill the job)', async () => {
  const throwingSql: SqlLike = (() => Promise.reject(new Error('db down'))) as SqlLike;
  const warnings: string[] = [];
  const w = createFetchLogWriter({
    sql: throwingSql,
    logger: { warn: (m) => warnings.push(m) },
  });
  await assert.doesNotReject(w.record({ ...base, changed: true }));
  assert.ok(warnings.length >= 1);
});

test('formatFetchError shape: CLASS[status]: message', () => {
  assert.equal(
    formatFetchError(new FetchError('HTTP_5XX', 'bad gateway', { status: 502 })),
    'HTTP_5XX[502]: bad gateway',
  );
  assert.equal(
    formatFetchError(new FetchError('NETWORK', 'ETIMEDOUT')),
    'NETWORK: ETIMEDOUT',
  );
});

test('outcomeEscalates: quality errors escalate, transient do not', () => {
  assert.equal(
    outcomeEscalates({ ...base, changed: true, error: new FetchError('PARSE_DRIFT', 'x') }),
    true,
  );
  assert.equal(
    outcomeEscalates({ ...base, changed: true, error: new FetchError('HTTP_5XX', 'x') }),
    false,
  );
  assert.equal(outcomeEscalates({ ...base, changed: true }), false);
});

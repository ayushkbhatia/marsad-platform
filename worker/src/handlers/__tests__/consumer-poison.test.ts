import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startQueueConsumer } from '../../consumer.js';
import { registerHandler, resolveHandler, type Handler } from '../index.js';
import type { Sql } from '../../db.js';
import type { WorkerConfig } from '../../config.js';
import type { HeartbeatWriter } from '../../heartbeat.js';
import { makeFakeSql } from './fakes.js';

/**
 * Poison-message handling in the pgmq consumer (P1 fix B).
 *
 * A message with no matching registered handler — an unknown handler name, the
 * {"task":X} alias for a not-yet-built stage, or no handler/task key at all —
 * must be ARCHIVED with a WARN, NOT thrown. Throwing leaves it invisible and
 * pgmq redelivers it every vt until MAX_READ_CT (infinite-redelivery poison
 * loop). This suite drives startQueueConsumer with a fake sql that yields one
 * scripted message on the first read, then empties.
 */

const READ_SUBSTR = 'pgmq.read_with_poll';
const ARCHIVE_SUBSTR = 'pgmq.archive';
const INCIDENTS_SUBSTR = 'ops.incidents';

function config(): WorkerConfig {
  return { workerId: 'test-worker' } as unknown as WorkerConfig;
}

function makeHeartbeatSpy(): {
  hb: HeartbeatWriter;
  successes: string[];
  failures: string[];
} {
  const successes: string[] = [];
  const failures: string[] = [];
  const hb: HeartbeatWriter = {
    start: () => {},
    stop: () => {},
    recordSuccess: async (jobName) => {
      successes.push(jobName);
    },
    recordFailure: async (jobName) => {
      failures.push(jobName);
    },
  };
  return { hb, successes, failures };
}

/**
 * Wrap a fake `sql` so the pgmq read query yields to the event loop (a tiny
 * async delay). The real pgmq.read_with_poll blocks server-side up to 5s per
 * empty read; the fake resolves instantly, so without this the consumer loop
 * would busy-spin (and OOM) while the test waits. The delay only applies to the
 * read query; every other query passes straight through.
 */
function slowRead(base: Sql): Sql {
  const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const result = (base as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(
      strings,
      ...values,
    );
    if (text.includes(READ_SUBSTR)) {
      return new Promise((resolve) => setTimeout(() => resolve(result), 3));
    }
    return result;
  }) as unknown as Record<string, unknown>;
  // Preserve postgres.js-style helpers used by handlers.
  const b = base as unknown as Record<string, unknown>;
  wrapped.json = b.json;
  wrapped.array = b.array;
  wrapped.begin = b.begin;
  return wrapped as unknown as Sql;
}

/** Run the consumer through exactly one scripted message then stop it. */
async function runOneMessage(message: unknown) {
  const fakeSql = makeFakeSql();
  fakeSql.on(READ_SUBSTR, [{ msg_id: '42', read_ct: 0, message }]);
  const { hb, successes, failures } = makeHeartbeatSpy();

  const consumer = startQueueConsumer('q_dispatch', slowRead(fakeSql.sql), config(), hb);
  // Wait until the archive for our message appears (or a short timeout).
  await waitFor(() => fakeSql.queries.some((q) => q.text.includes(ARCHIVE_SUBSTR)), 1000).catch(
    () => {},
  );
  consumer.stop();
  await consumer.done;
  return { fakeSql, successes, failures };
}

test('consumer: unknown handler name is archived, not errored or looped', async () => {
  const { fakeSql, failures } = await runOneMessage({ handler: 'does_not_exist', x: 1 });

  assert.ok(
    fakeSql.queries.some((q) => q.text.includes(ARCHIVE_SUBSTR) && q.values.includes('42')),
    'poison message archived',
  );
  assert.ok(
    !fakeSql.queries.some((q) => q.text.includes(INCIDENTS_SUBSTR)),
    'unknown handler is not an ops.incidents error',
  );
  assert.equal(failures.length, 0, 'no handler-failure heartbeat recorded');
});

test('consumer: {"task":X} future-phase envelope with no handler is archived (not looped)', async () => {
  const { fakeSql } = await runOneMessage({ task: 'notify_drain', payload: {} });
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes(ARCHIVE_SUBSTR) && q.values.includes('42')),
    'task-alias poison message archived',
  );
  assert.ok(
    !fakeSql.queries.some((q) => q.text.includes(INCIDENTS_SUBSTR)),
    'not an incident',
  );
});

test('consumer: message with no handler/task key is archived', async () => {
  const { fakeSql } = await runOneMessage({ some: 'payload' });
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes(ARCHIVE_SUBSTR) && q.values.includes('42')),
    'keyless poison message archived',
  );
});

test('consumer: {"task":X} that names a REGISTERED handler runs it (alias accepted)', async () => {
  const seen: Array<Record<string, unknown>> = [];
  if (!resolveHandler('task_alias_probe')) {
    const h: Handler = async (payload) => {
      seen.push(payload as Record<string, unknown>);
    };
    registerHandler('task_alias_probe', h);
  }

  const { fakeSql, successes } = await runOneMessage({ task: 'task_alias_probe', n: 7 });

  assert.equal(seen.length, 1, 'aliased handler ran');
  // Both envelope keys stripped: payload has neither handler nor task.
  assert.deepEqual(seen[0], { n: 7 });
  assert.ok(
    fakeSql.queries.some((q) => q.text.includes(ARCHIVE_SUBSTR) && q.values.includes('42')),
    'processed message archived on success',
  );
  assert.ok(successes.length >= 1, 'success heartbeat recorded');
});

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

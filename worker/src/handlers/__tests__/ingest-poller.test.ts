import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startIngestPoller } from '../../ingest-poller.js';
import { registerHandler, resolveHandler, type Handler } from '../index.js';
import type { WorkerConfig } from '../../config.js';
import { makeFakeSql } from './fakes.js';

/**
 * Unit tests for the scheduler→worker bridge (ingest.job_queue claim loop).
 *
 * The poller reuses the registered ingestion handlers via resolveHandler. The
 * registry is a process singleton and registerHandler throws on duplicates, so
 * we register each of the three real handler NAMES exactly once (guarded) with a
 * test spy, and drive the poller with a fake `sql` whose claim query returns a
 * scripted batch. A spy throws for a poison sourceId so we can exercise the
 * failure→'failed' path deterministically.
 */

const POISON_SOURCE_ID = 500;
const spies: Record<string, Array<Record<string, unknown>>> = {
  quote_poll: [],
  filings_poll: [],
  eod_sweep: [],
};

function ensureHandler(name: string): void {
  if (resolveHandler(name)) return;
  const spy: Handler = async (payload) => {
    const p = payload as Record<string, unknown>;
    if (name === 'quote_poll' && p.sourceId === POISON_SOURCE_ID) {
      throw new Error('boom');
    }
    spies[name]!.push(p);
  };
  registerHandler(name, spy);
}

function ensureAllHandlers(): void {
  ensureHandler('quote_poll');
  ensureHandler('filings_poll');
  ensureHandler('eod_sweep');
}

function pollerConfig(): WorkerConfig {
  return {
    workerId: 'test-worker',
    ingestPollIntervalMs: 5,
    ingestBatchSize: 20,
    ingestConcurrency: 4,
    shutdownGraceMs: 1000,
  } as unknown as WorkerConfig;
}

/** Claim / finish query fingerprints for makeFakeSql substring matching. */
const CLAIM_SUBSTR = 'update ingest.job_queue jq';
// The claim UPDATE also literally contains "set status = 'running'", so match the
// terminal update on a fragment unique to finishJob().
const FINISH_SUBSTR = 'finished_at = now()';

test('ingest poller: claims due rows and dispatches by data_type (quotes→quote_poll, filings_list→filings_poll, eod_bulletin→eod_sweep)', async () => {
  ensureAllHandlers();
  spies.quote_poll!.length = 0;
  spies.filings_poll!.length = 0;
  spies.eod_sweep!.length = 0;

  const fakeSql = makeFakeSql();
  fakeSql.on(CLAIM_SUBSTR, [
    { id: '1', source_id: '101', venue: 'QE', data_type: 'quotes', venue_local_date: '2026-07-13' },
    { id: '2', source_id: '102', venue: 'TDWL', data_type: 'filings_list', venue_local_date: '2026-07-13' },
    { id: '3', source_id: '103', venue: 'BHB', data_type: 'eod_bulletin', venue_local_date: '2026-07-13' },
  ]);

  const poller = startIngestPoller(fakeSql.sql, pollerConfig());
  await waitFor(
    () => spies.quote_poll!.length + spies.filings_poll!.length + spies.eod_sweep!.length >= 3,
  );
  poller.stop();
  await poller.done;

  assert.deepEqual(spies.quote_poll![0], { handler: 'quote_poll', sourceId: 101 });
  assert.deepEqual(spies.filings_poll![0], { handler: 'filings_poll', sourceId: 102 });
  assert.deepEqual(spies.eod_sweep![0], {
    handler: 'eod_sweep',
    venue: 'BHB',
    tradeDate: '2026-07-13',
  });

  const finishes = fakeSql.queries.filter((q) => q.text.includes(FINISH_SUBSTR));
  assert.ok(finishes.length >= 3, 'each claimed job is marked terminal');
  assert.ok(
    finishes.every((q) => q.values.includes('ok')),
    'all three succeeded ⇒ status ok',
  );
});

test('ingest poller: unknown data_type is marked failed, never dispatched', async () => {
  ensureAllHandlers();
  const beforeQuote = spies.quote_poll!.length;

  const fakeSql = makeFakeSql();
  fakeSql.on(CLAIM_SUBSTR, [
    { id: '9', source_id: '900', venue: 'QE', data_type: 'financials', venue_local_date: '2026-07-13' },
  ]);

  const poller = startIngestPoller(fakeSql.sql, pollerConfig());
  await waitFor(() => fakeSql.queries.some((q) => q.text.includes(FINISH_SUBSTR)));
  poller.stop();
  await poller.done;

  assert.equal(spies.quote_poll!.length, beforeQuote, 'unknown data_type not dispatched');
  const finish = fakeSql.queries.find((q) => q.text.includes(FINISH_SUBSTR));
  assert.ok(finish!.values.includes('failed'), 'unknown data_type ⇒ status failed');
});

test('ingest poller: a throwing handler marks the row failed (not ok)', async () => {
  ensureAllHandlers();

  const fakeSql = makeFakeSql();
  fakeSql.on(CLAIM_SUBSTR, [
    {
      id: '7',
      source_id: String(POISON_SOURCE_ID),
      venue: 'QE',
      data_type: 'quotes',
      venue_local_date: '2026-07-13',
    },
  ]);

  const poller = startIngestPoller(fakeSql.sql, pollerConfig());
  await waitFor(() => fakeSql.queries.some((q) => q.text.includes(FINISH_SUBSTR)));
  poller.stop();
  await poller.done;

  const finish = fakeSql.queries.find((q) => q.text.includes(FINISH_SUBSTR));
  assert.ok(finish, 'row finished');
  assert.ok(finish!.values.includes('failed'), 'throwing handler ⇒ status failed');
});

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

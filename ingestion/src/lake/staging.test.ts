import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LakeStagingEmitter } from './staging.js';
import { createFakeDb, newState } from './fake-db.js';
import type { StagingRow } from './contract-types.js';

function row(over: Partial<StagingRow<Record<string, unknown>>> = {}): StagingRow<Record<string, unknown>> {
  return {
    objectType: 'DIVIDEND.EXDATE',
    naturalKey: 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1',
    venue: 'TDWL',
    sourceId: 1,
    snapshotId: 100,
    externalId: 'CG-1-2026-4471',
    sourceRank: 20,
    payload: { dps: 0.55, ccy: 'SAR' },
    numericValue: 0.55,
    unit: 'SAR',
    effectiveDate: '2026-07-28',
    priceSensitive: true,
    extractedAt: '2026-07-13T12:00:00Z',
    ...over,
  };
}

test('emit writes one staging row', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await emitter.emit([row()]);
  assert.equal(state.staging.length, 1);
  assert.equal(state.staging[0].natural_key, 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1');
});

test('re-emitting identical content is idempotent (dedupe key)', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await emitter.emit([row()]);
  await emitter.emit([row()]); // retry
  assert.equal(state.staging.length, 1);
});

test('same source + external_id but changed payload ⇒ a new staging row (a revision)', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await emitter.emit([row({ payload: { dps: 0.5 } })]);
  await emitter.emit([row({ payload: { dps: 0.55 } })]);
  assert.equal(state.staging.length, 2);
});

test('two independent sources for the same natural_key coexist', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await emitter.emit([row({ sourceId: 1, sourceRank: 20 })]);
  await emitter.emit([row({ sourceId: 2, sourceRank: 10, externalId: null })]);
  assert.equal(state.staging.length, 2);
});

test('empty batch is a no-op', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await emitter.emit([]);
  assert.equal(state.staging.length, 0);
});

test('missing naturalKey throws', async () => {
  const state = newState();
  const emitter = new LakeStagingEmitter(createFakeDb(state));
  await assert.rejects(() => emitter.emit([row({ naturalKey: '' })]));
});

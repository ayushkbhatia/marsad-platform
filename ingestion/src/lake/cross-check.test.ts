import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LakeCrossCheck } from './cross-check.js';
import { LakeStagingEmitter } from './staging.js';
import { createFakeDb, newState, type FakeState } from './fake-db.js';
import type { StagingRow } from './contract-types.js';

const NK = 'DIVIDEND.DPS:TDWL:7010:2026-INT1';
const OT = 'DISCLOSURE.DPS';

function stg(over: Partial<StagingRow<Record<string, unknown>>>): StagingRow<Record<string, unknown>> {
  return {
    objectType: OT,
    naturalKey: NK,
    venue: 'TDWL',
    sourceId: 1,
    snapshotId: 100,
    externalId: null,
    sourceRank: 20,
    payload: { dps: 0.55, ticker: '7010' },
    numericValue: 0.55,
    unit: 'SAR',
    effectiveDate: '2026-07-28',
    priceSensitive: false,
    extractedAt: '2026-07-13T12:00:00Z',
    ...over,
  };
}

async function seed(state: FakeState, rows: StagingRow<Record<string, unknown>>[]): Promise<void> {
  const sql = createFakeDb(state);
  await new LakeStagingEmitter(sql).emit(rows);
}

function withSecurity(state: FakeState): void {
  state.securities.push({ id: '5001', venue_code: 'TDWL', ticker: '7010', shares_outstanding: '1000', status: 'listed' });
}

test('single source ⇒ PENDING object created, not verified', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [stg({ sourceId: 1 })]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'PENDING');
  assert.equal(state.objects.length, 1);
  assert.equal(state.objects[0].state, 'PENDING');
  assert.equal(state.objects[0].security_id, '5001'); // ticker resolved
  assert.equal(state.datapointFanoutCalls.length, 0);
});

test('two independent agreeing sources ⇒ VERIFIED with fan-out; primary rank wins', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.55, payload: { dps: 0.55, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5501, payload: { dps: 0.5501, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'VERIFIED');
  assert.equal(res.revision, 1);
  const live = state.objects.find((o) => o.superseded_by === null)!;
  assert.equal(live.state, 'VERIFIED');
  assert.equal(live.verified_by, 'sys-0000');
  assert.equal(live.source_rank, 10); // registrar primary won
  assert.equal(state.datapointFanoutCalls.length, 1); // fan-out fired once
  // both staging rows consumed
  assert.equal(state.staging.every((s) => s.consumed_at !== null), true);
});

test('two independent disagreeing sources ⇒ CONFLICT + object_conflicts row', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.55, payload: { dps: 0.55, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.75, payload: { dps: 0.75, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'CONFLICT');
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.conflicts[0].policy, 'primary_wins');
  const live = state.objects.find((o) => o.superseded_by === null)!;
  assert.equal(live.state, 'CONFLICT');
  assert.equal(state.datapointFanoutCalls.length, 0);
});

test('price-sensitive agreement ⇒ stays PENDING, conflict/desk row raised (no human)', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, priceSensitive: true }),
    stg({ sourceId: 10, sourceRank: 10, priceSensitive: true }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'PENDING');
  assert.equal(state.objects[0].state, 'PENDING');
  assert.equal(state.conflicts.length, 1); // desk item raised
  assert.equal(state.datapointFanoutCalls.length, 0);
});

test('value change on a VERIFIED key ⇒ supersede-then-insert new revision, one live row, revision pair', async () => {
  const state = newState();
  withSecurity(state);
  // First: verify 0.50
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: NK, objectType: OT });
  const firstLive = state.objects.find((o) => o.superseded_by === null)!;
  assert.equal(firstLive.revision, 1);

  // Correction: 0.55 arrives from two sources
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.55, payload: { dps: 0.55, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.55, payload: { dps: 0.55, ticker: '7010' } }),
  ]);
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'VERIFIED');
  assert.equal(res.revision, 2);

  const liveRows = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(liveRows.length, 1); // one-live-per-key held
  assert.equal(liveRows[0].revision, 2);
  assert.equal(liveRows[0].numeric_value, '0.55');

  const retired = state.objects.find((o) => o.id === firstLive.id)!;
  assert.equal(retired.state, 'RETIRED');
  assert.equal(retired.superseded_by, liveRows[0].id);

  assert.equal(state.revisions.length, 1);
  assert.equal(state.revisions[0].reason, 'source_update');
  // fan-out fired twice total (rev1 verify + rev2 verify)
  assert.equal(state.datapointFanoutCalls.length, 2);
});

test('re-confirming the same VERIFIED value ⇒ no new revision, no supersession', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: NK, objectType: OT });
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
  ]);
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.revision, 1);
  assert.equal(state.objects.filter((o) => o.superseded_by === null).length, 1);
  assert.equal(state.revisions.length, 0);
});

test('fresh disagreement on an already-VERIFIED key does NOT retire it', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: NK, objectType: OT });

  // A registrar (rank 10) source is among the disagreeing set, so this is a
  // genuine CONFLICT (not a dividend "await registrar" hold, §7).
  await seed(state, [
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.6, payload: { dps: 0.6, ticker: '7010' } }),
    stg({ sourceId: 30, sourceRank: 90, numericValue: 0.9, payload: { dps: 0.9, ticker: '7010' } }),
  ]);
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'VERIFIED'); // untouched
  const live = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].numeric_value, '0.5');
  assert.equal(state.conflicts.length, 1); // conflict parked against it
});

test('idempotent re-run with no new staging ⇒ reports current live object', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: NK, objectType: OT });
  const again = await cc.resolve({ naturalKey: NK, objectType: OT }); // staging consumed
  assert.equal(again.state, 'VERIFIED');
  assert.equal(again.revision, 1);
  assert.equal(state.objects.filter((o) => o.superseded_by === null).length, 1);
});

test('single-source PENDING then a second agreeing source ⇒ promoted VERIFIED in place, no new revision', async () => {
  const state = newState();
  withSecurity(state);
  // Pass 1: one source only ⇒ PENDING object.
  await seed(state, [stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } })]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const p1 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(p1.state, 'PENDING');
  const pendingId = state.objects.find((o) => o.superseded_by === null)!.id;

  // Pass 2: a second independent source agrees with the same value.
  await seed(state, [stg({ sourceId: 10, sourceRank: 10, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } })]);
  const p2 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(p2.state, 'VERIFIED');
  assert.equal(p2.revision, 1); // same value → no new revision
  const live = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, pendingId); // same row, promoted in place
  assert.equal(live[0].state, 'VERIFIED');
  assert.equal(state.revisions.length, 0);
  assert.equal(state.datapointFanoutCalls.length, 1); // fan-out fires on promotion
});

test('a SECOND poll of the SAME source does NOT auto-VERIFY a single-source fact (independence)', async () => {
  const state = newState();
  withSecurity(state);
  // Pass 1: one source ⇒ PENDING. Its staging row is retained (not consumed) so
  // a genuinely distinct source could later corroborate it.
  await seed(state, [stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } })]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const p1 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(p1.state, 'PENDING');

  // Pass 2: the SAME source (20) re-emits the SAME value but with changed content
  // (different snapshot) so it is a new staging row. Still ONE independent source
  // ⇒ must remain PENDING, never VERIFIED (CONTRACT §7: ≥2 DISTINCT source_ids).
  await seed(state, [stg({ sourceId: 20, sourceRank: 20, snapshotId: 999, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010', pass: 2 } })]);
  const p2 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(p2.state, 'PENDING');
  const live = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].state, 'PENDING');
  assert.equal(state.datapointFanoutCalls.length, 0); // never verified
});

test('dividend disagreement with NO registrar source ⇒ stays PENDING (await registrar), not CONFLICT', async () => {
  const state = newState();
  withSecurity(state);
  // Two disclosure/press sources (ranks 20 and 90) disagree; no registrar (≤10)
  // has confirmed yet ⇒ CONTRACT §7 holds it PENDING pending registrar, no conflict.
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.55, payload: { dps: 0.55, ticker: '7010' } }),
    stg({ sourceId: 30, sourceRank: 90, numericValue: 0.75, payload: { dps: 0.75, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(res.state, 'PENDING');
  assert.equal(state.conflicts.length, 0); // no CONFLICT raised
  const live = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].state, 'PENDING');
  assert.equal(state.datapointFanoutCalls.length, 0);
});

test('a CONFLICT that later gains consensus ⇒ VERIFIED + conflicts resolved', async () => {
  const state = newState();
  withSecurity(state);
  // Pass 1: two sources disagree ⇒ CONFLICT.
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.5, payload: { dps: 0.5, ticker: '7010' } }),
    stg({ sourceId: 10, sourceRank: 10, numericValue: 0.9, payload: { dps: 0.9, ticker: '7010' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const c1 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(c1.state, 'CONFLICT');
  const objId = state.objects.find((o) => o.superseded_by === null)!.id;
  const liveState = state.objects.find((o) => o.superseded_by === null)!.state;
  // The live object holds the primary (0.9) value now.
  assert.equal(liveState, 'CONFLICT');

  // Pass 2: two sources now agree on the value the live row carries (0.9).
  await seed(state, [
    stg({ sourceId: 20, sourceRank: 20, numericValue: 0.9, payload: { dps: 0.9, ticker: '7010' } }),
    stg({ sourceId: 30, sourceRank: 90, numericValue: 0.9, payload: { dps: 0.9, ticker: '7010' } }),
  ]);
  const c2 = await cc.resolve({ naturalKey: NK, objectType: OT });
  assert.equal(c2.state, 'VERIFIED');
  assert.equal(state.objects.find((o) => o.id === objId)!.state, 'VERIFIED');
  assert.equal(state.conflicts.every((c) => c.status === 'resolved_primary'), true);
});

test('unknown verifier handle throws', async () => {
  const state = newState();
  const cc = new LakeCrossCheck(createFakeDb(state), { verifierHandle: 'NO-SUCH' });
  await seed(state, [stg({})]);
  await assert.rejects(() => cc.resolve({ naturalKey: NK, objectType: OT }));
});

// ── QUOTE.LAST live-latest refresh (single-source intraday feed) ─────────────
// Regression guard: single-source QUOTE.LAST must NOT freeze at the day's first
// print. Each poll refreshes the day-keyed live object IN PLACE with the newest
// print (no new revision, no supersession), and its staging rows are consumed so
// the next poll gathers only genuinely-new prints.
const QNK = 'QUOTE.LAST:TDWL:7010:2026-07-15';
const QOT = 'QUOTE.LAST';

function qstg(over: Partial<StagingRow<Record<string, unknown>>>): StagingRow<Record<string, unknown>> {
  return stg({
    objectType: QOT,
    naturalKey: QNK,
    sourceId: 1,
    sourceRank: 20,
    unit: 'SAR',
    effectiveDate: '2026-07-15',
    priceSensitive: false,
    ...over,
  });
}

test('QUOTE.LAST single source ⇒ first print creates PENDING object, staging consumed', async () => {
  const state = newState();
  withSecurity(state);
  await seed(state, [qstg({ numericValue: 10.0, payload: { last: 10.0, ticker: '7010' } })]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: QNK, objectType: QOT });
  assert.equal(res.state, 'PENDING');
  assert.equal(state.objects.length, 1);
  assert.equal(Number(state.objects[0].numeric_value), 10.0);
  // live feed consumes each pass (no corroboration hold) so the next poll is fresh
  assert.equal(state.staging.every((s) => s.consumed_at !== null), true);
});

test('QUOTE.LAST second poll ⇒ live object refreshed IN PLACE to NEWEST print, no new revision', async () => {
  const state = newState();
  withSecurity(state);
  // Poll 1: first print of the day.
  await seed(state, [qstg({ numericValue: 10.0, payload: { last: 10.0, ticker: '7010' } })]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: QNK, objectType: QOT });
  const firstId = state.objects[0].id;

  // Poll 2: two new prints since — the feed must land on the NEWEST (10.9), not
  // the oldest (10.6, which primaryOf would otherwise pick).
  await seed(state, [
    qstg({ numericValue: 10.6, payload: { last: 10.6, ticker: '7010' } }),
    qstg({ numericValue: 10.9, payload: { last: 10.9, ticker: '7010' } }),
  ]);
  const res = await cc.resolve({ naturalKey: QNK, objectType: QOT });

  assert.equal(state.objects.length, 1);                    // no new object / no supersession
  const live = state.objects[0];
  assert.equal(live.id, firstId);                           // same object, refreshed in place
  assert.equal(live.superseded_by, null);
  assert.equal(live.state, 'PENDING');                      // still single-source PENDING
  assert.equal(res.revision, 1);                            // a tick, not a correction
  assert.equal(Number(live.numeric_value), 10.9);           // NEWEST print won
  assert.equal((live.payload as Record<string, unknown>).last, 10.9);
  assert.equal(state.datapointFanoutCalls.length, 0);       // PENDING ⇒ no fan-out
  assert.equal(state.staging.every((s) => s.consumed_at !== null), true);
});

// ── INDEX.LEVEL live-latest refresh (single-source index tape) ───────────────
// Regression guard mirroring the QUOTE.LAST case: a single-source INDEX.LEVEL is
// the venue's own headline index (no second exchange to corroborate), so it must
// NOT freeze at the day's first print. Each poll refreshes the day-keyed live
// object IN PLACE with the newest level (no new revision, no supersession) so
// lake.fn_index_level_project advances public.index_levels / index_levels_daily;
// its staging rows are consumed so the next poll gathers only genuinely-new prints.
const INK = 'INDEX.LEVEL:TDWL:TASI:2026-07-15';
const IOT = 'INDEX.LEVEL';

function istg(over: Partial<StagingRow<Record<string, unknown>>>): StagingRow<Record<string, unknown>> {
  return stg({
    objectType: IOT,
    naturalKey: INK,
    sourceId: 1,
    sourceRank: 20,
    unit: null,
    effectiveDate: '2026-07-15',
    priceSensitive: false,
    // Index objects carry no ticker → resolveSecurityId leaves security_id null (indices
    // are not securities); the projection keys on payload.indexCode, not security_id.
    ...over,
  });
}

test('INDEX.LEVEL single source ⇒ first print creates PENDING object, staging consumed', async () => {
  const state = newState();
  await seed(state, [
    istg({ numericValue: 11000.0, payload: { indexCode: 'TASI', level: 11000.0, asOf: '2026-07-15T11:00:00Z' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  const res = await cc.resolve({ naturalKey: INK, objectType: IOT });
  assert.equal(res.state, 'PENDING');
  assert.equal(state.objects.length, 1);
  assert.equal(Number(state.objects[0].numeric_value), 11000.0);
  assert.equal(state.objects[0].security_id, null);           // an index is not a security
  // live tape consumes each pass (no corroboration hold) so the next poll is fresh
  assert.equal(state.staging.every((s) => s.consumed_at !== null), true);
});

test('INDEX.LEVEL second poll ⇒ live object refreshed IN PLACE to NEWEST print, no new revision', async () => {
  const state = newState();
  // Poll 1: first print of the day.
  await seed(state, [
    istg({ numericValue: 11000.0, payload: { indexCode: 'TASI', level: 11000.0, asOf: '2026-07-15T11:00:00Z' } }),
  ]);
  const cc = new LakeCrossCheck(createFakeDb(state));
  await cc.resolve({ naturalKey: INK, objectType: IOT });
  const firstId = state.objects[0].id;

  // Poll 2: two new prints since — the tape must land on the NEWEST (11090), not
  // the oldest (11060, which primaryOf would otherwise pick).
  await seed(state, [
    istg({ numericValue: 11060.0, payload: { indexCode: 'TASI', level: 11060.0, asOf: '2026-07-15T11:15:00Z' } }),
    istg({ numericValue: 11090.0, payload: { indexCode: 'TASI', level: 11090.0, asOf: '2026-07-15T11:30:00Z' } }),
  ]);
  const res = await cc.resolve({ naturalKey: INK, objectType: IOT });

  assert.equal(state.objects.length, 1);                    // no new object / no supersession
  const live = state.objects[0];
  assert.equal(live.id, firstId);                           // same object, refreshed in place
  assert.equal(live.superseded_by, null);
  assert.equal(live.state, 'PENDING');                      // still single-source PENDING
  assert.equal(res.revision, 1);                            // a tick, not a correction
  assert.equal(Number(live.numeric_value), 11090.0);        // NEWEST print won
  assert.equal((live.payload as Record<string, unknown>).level, 11090.0);
  assert.equal(state.datapointFanoutCalls.length, 0);       // PENDING ⇒ no fan-out
  assert.equal(state.staging.every((s) => s.consumed_at !== null), true);
});

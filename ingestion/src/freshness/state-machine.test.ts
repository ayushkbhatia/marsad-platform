/**
 * §8 transition assertions for the pure venue state machine. Run with the
 * ingestion package's test script (tsx loader resolves the NodeNext .js
 * specifiers to their .ts sources); zero test-framework deps — node:test only.
 *
 * These lock the machine to ingest.sweep_feed_status() (0005). Cadence C = 10,
 * so thresholds are 15 / 30 / 45 min.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveVenueState,
  isEscalatingTransition,
  isRecoveryTransition,
  DEFAULT_THRESHOLDS,
} from './state-machine.js';
import type { VenueFreshnessSignal } from './types.js';

const NOW = new Date('2026-07-13T11:00:00Z'); // a Monday, mid-session for GCC venues

/** Build a signal with `lastSync` set `agoMin` minutes before NOW. */
function openSignal(agoMin: number | null, override?: 'halted' | 'auction' | null): VenueFreshnessSignal {
  return {
    venue: 'TDWL',
    isOpen: true,
    lastQuotesSuccessAt: agoMin === null ? null : new Date(NOW.getTime() - agoMin * 60_000),
    now: NOW,
    marketOverride: override ?? null,
  };
}

test('live: last success within 15 min', () => {
  assert.equal(deriveVenueState(openSignal(0)).state, 'live');
  assert.equal(deriveVenueState(openSignal(10)).state, 'live');
  assert.equal(deriveVenueState(openSignal(15)).state, 'live'); // boundary: ≤15 is live
});

test('reconnecting: 15–30 min', () => {
  assert.equal(deriveVenueState(openSignal(15.1)).state, 'reconnecting');
  assert.equal(deriveVenueState(openSignal(20)).state, 'reconnecting');
  assert.equal(deriveVenueState(openSignal(30)).state, 'reconnecting'); // boundary ≤30
});

test('delayed: 30–45 min', () => {
  assert.equal(deriveVenueState(openSignal(30.1)).state, 'delayed');
  assert.equal(deriveVenueState(openSignal(40)).state, 'delayed');
  assert.equal(deriveVenueState(openSignal(45)).state, 'delayed'); // boundary ≤45
});

test('offline: > 45 min or never', () => {
  assert.equal(deriveVenueState(openSignal(45.1)).state, 'offline');
  assert.equal(deriveVenueState(openSignal(120)).state, 'offline');
  assert.equal(deriveVenueState(openSignal(null)).state, 'offline'); // never synced
});

test('the consecutive-failure escalation ladder live→reconnecting→delayed→offline', () => {
  // At C=10, each successive missed poll advances the age; the ladder walks the
  // four states in order as staleness grows (the "6 consecutive failures" clause
  // is dead — the 45-min clock fires first, matching the SQL).
  const ages = [5, 20, 35, 60];
  const states = ages.map((a) => deriveVenueState(openSignal(a)).state);
  assert.deepEqual(states, ['live', 'reconnecting', 'delayed', 'offline']);
});

test('closed: outside session, never offline — even if never synced', () => {
  const sig: VenueFreshnessSignal = {
    venue: 'TDWL',
    isOpen: false,
    lastQuotesSuccessAt: null,
    now: NOW,
  };
  assert.equal(deriveVenueState(sig).state, 'closed');
  assert.equal(deriveVenueState(sig).minutesSinceSync, null);
});

test('closed wins over a stale in-session clock when venue_is_open=false (weekend/holiday)', () => {
  // Even with a very old last-sync (would be offline if open), a closed calendar
  // forces 'closed' — the weekend/holiday case must never read as 'offline'.
  const sig: VenueFreshnessSignal = {
    venue: 'DFM',
    isOpen: false,
    lastQuotesSuccessAt: new Date(NOW.getTime() - 5000 * 60_000),
    now: NOW,
  };
  assert.equal(deriveVenueState(sig).state, 'closed');
});

test('halted override preserved while market open', () => {
  assert.equal(deriveVenueState(openSignal(5, 'halted')).state, 'halted');
  // preserved even when the freshness clock would say live
  assert.equal(deriveVenueState(openSignal(0, 'halted')).state, 'halted');
});

test('auction override preserved while market open', () => {
  assert.equal(deriveVenueState(openSignal(2, 'auction')).state, 'auction');
});

test('closed overrides a lingering halted/auction (SQL: excluded.state = closed wins)', () => {
  const sig: VenueFreshnessSignal = {
    venue: 'TDWL',
    isOpen: false,
    lastQuotesSuccessAt: new Date(NOW.getTime() - 5 * 60_000),
    now: NOW,
    marketOverride: 'halted',
  };
  assert.equal(deriveVenueState(sig).state, 'closed');
});

test('minutesSinceSync is reported for badge rendering', () => {
  assert.equal(deriveVenueState(openSignal(22)).minutesSinceSync, 22);
  assert.match(deriveVenueState(openSignal(22)).detail, /22m/);
});

test('custom thresholds are honored (tightened cadence)', () => {
  const t = { liveMax: 7, reconnectingMax: 14, delayedMax: 21 };
  assert.equal(deriveVenueState(openSignal(10), t).state, 'reconnecting');
  assert.equal(deriveVenueState(openSignal(22), t).state, 'offline');
});

test('escalation fires only on transition INTO offline', () => {
  assert.equal(isEscalatingTransition('delayed', 'offline'), true);
  assert.equal(isEscalatingTransition(null, 'offline'), true);
  assert.equal(isEscalatingTransition('offline', 'offline'), false); // already offline
  assert.equal(isEscalatingTransition('live', 'reconnecting'), false);
});

test('recovery fires only when leaving offline for a healthy state', () => {
  assert.equal(isRecoveryTransition('offline', 'live'), true);
  assert.equal(isRecoveryTransition('offline', 'reconnecting'), true);
  assert.equal(isRecoveryTransition('offline', 'offline'), false);
  assert.equal(isRecoveryTransition('delayed', 'live'), false);
});

test('DEFAULT_THRESHOLDS match the SQL sweep (15/30/45)', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { liveMax: 15, reconnectingMax: 30, delayedMax: 45 });
});

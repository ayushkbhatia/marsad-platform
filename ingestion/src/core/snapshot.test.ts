import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageKey } from './snapshot.js';

test('storageKey: content-addressed {venue}/{type}/{y}/{m}/{d}/{sha}.{ext}.gz (UTC)', () => {
  const k = storageKey('TDWL', 'quotes', '2026-07-13T21:30:00.000Z', 'deadbeef', 'json');
  assert.equal(k, 'TDWL/quotes/2026/07/13/deadbeef.json.gz');
});

test('storageKey: zero-pads month/day and uses UTC calendar date', () => {
  // 2026-01-05T23:59Z stays Jan 5 in UTC.
  const k = storageKey('BHB', 'eod_bulletin', '2026-01-05T23:59:00.000Z', 'abc', 'xlsx');
  assert.equal(k, 'BHB/eod_bulletin/2026/01/05/abc.xlsx.gz');
});

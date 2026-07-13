import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceMultiplier } from './scheduler.js';

test('cadenceMultiplier: 1x below 3 failures, doubles up to cap 4x (§10)', () => {
  assert.equal(cadenceMultiplier(0), 1);
  assert.equal(cadenceMultiplier(2), 1, 'still 1x at 2 failures');
  assert.equal(cadenceMultiplier(3), 2, '3 failures ⇒ 2x');
  assert.equal(cadenceMultiplier(4), 4, '4 failures ⇒ 4x');
  assert.equal(cadenceMultiplier(10), 4, 'capped at 4x');
});

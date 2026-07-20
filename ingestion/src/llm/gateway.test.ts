import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBudgetDemotion } from './gateway.js';

// PART C — the budget-ladder seam. When spend is degraded/halted the worker passes
// budgetDegraded=true; the gateway drops the premium PRIMARY target so the role runs on its
// cheaper fallback chain — but only when a fallback exists, so a role is never stranded.

const chain = ['premium-primary', 'cheap-fallback-1', 'cheap-fallback-2'];

test('budget ok (undefined) leaves the chain unchanged — primary first', () => {
  assert.deepEqual(applyBudgetDemotion(chain, undefined), chain);
  assert.deepEqual(applyBudgetDemotion(chain, false), chain);
});

test('budget degraded drops the premium primary, keeping the fallback chain', () => {
  assert.deepEqual(applyBudgetDemotion(chain, true), ['cheap-fallback-1', 'cheap-fallback-2']);
});

test('degraded never strands a role with no fallback (single-target chain kept)', () => {
  assert.deepEqual(applyBudgetDemotion(['only-target'], true), ['only-target']);
});

test('degraded on an empty chain is a no-op (defensive)', () => {
  assert.deepEqual(applyBudgetDemotion([], true), []);
});

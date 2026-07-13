import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHttpFailure,
  classifyThrown,
  classifyParseDrift,
  policyFor,
} from './taxonomy.js';
import { FetchError } from './types.js';

test('429 → HTTP_5XX (mirrors transport), carries Retry-After', () => {
  // The frozen §10 taxonomy has no RATE_LIMITED class: the transport folds 429
  // into HTTP_5XX (retry with backoff, honoring Retry-After). This module mirrors
  // that so the logged class never contradicts what core threw.
  const e = classifyHttpFailure(429, { retryAfterMs: 30_000 });
  assert.equal(e.errorClass, 'HTTP_5XX');
  assert.equal(e.retryAfterMs, 30_000);
  assert.equal(policyFor(e.errorClass).retryable, true);
  assert.equal(policyFor(e.errorClass).qualityError, false);
});

test('403 / 401 → WAF_CHALLENGE', () => {
  assert.equal(classifyHttpFailure(403).errorClass, 'WAF_CHALLENGE');
  assert.equal(classifyHttpFailure(401).errorClass, 'WAF_CHALLENGE');
});

test('explicit waf flag on any status → WAF_CHALLENGE', () => {
  assert.equal(classifyHttpFailure(200, { waf: true }).errorClass, 'WAF_CHALLENGE');
});

test('5xx → HTTP_5XX (retryable, not a quality error)', () => {
  const e = classifyHttpFailure(503);
  assert.equal(e.errorClass, 'HTTP_5XX');
  const p = policyFor(e.errorClass);
  assert.equal(p.retryable, true);
  assert.equal(p.qualityError, false);
});

test('4xx (non-429/403/401) → HTTP_4XX (no retry, quality error, escalates)', () => {
  const e = classifyHttpFailure(404);
  assert.equal(e.errorClass, 'HTTP_4XX');
  const p = policyFor(e.errorClass);
  assert.equal(p.retryable, false);
  assert.equal(p.qualityError, true);
  assert.equal(p.escalate, true);
});

test('classifyHttpFailure returns a throwable core FetchError', () => {
  const e = classifyHttpFailure(404);
  assert.ok(e instanceof FetchError);
  assert.equal(e.status, 404);
});

test('thrown transport error → NETWORK', () => {
  assert.equal(classifyThrown(new Error('ETIMEDOUT')).errorClass, 'NETWORK');
  assert.equal(classifyThrown('socket hang up').errorClass, 'NETWORK');
});

test('classifyThrown passes an already-classified core FetchError through', () => {
  const original = new FetchError('WAF_CHALLENGE', 'challenge', { status: 403 });
  assert.equal(classifyThrown(original), original);
});

test('PARSE_DRIFT only on a CHANGED snapshot with zero rows', () => {
  assert.equal(classifyParseDrift(true, 0)?.errorClass, 'PARSE_DRIFT');
  // zod failure on a changed snapshot also drifts, even with rows
  assert.equal(classifyParseDrift(true, 5, true)?.errorClass, 'PARSE_DRIFT');
  // unchanged snapshot with zero rows is NOT drift (nothing to re-emit)
  assert.equal(classifyParseDrift(false, 0), null);
  // changed snapshot with rows is healthy
  assert.equal(classifyParseDrift(true, 42), null);
});

test('PARSE_DRIFT policy: no retry, quality error, escalates', () => {
  const p = policyFor('PARSE_DRIFT');
  assert.equal(p.retryable, false);
  assert.equal(p.qualityError, true);
  assert.equal(p.escalate, true);
});

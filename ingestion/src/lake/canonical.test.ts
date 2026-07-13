import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentHash } from './canonical.js';

test('key order does not change the canonical form or hash', () => {
  const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
  const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(contentHash(a), contentHash(b));
});

test('array order IS significant', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test('undefined properties dropped; null kept', () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test('different values ⇒ different hash', () => {
  assert.notEqual(contentHash({ dps: 0.5 }), contentHash({ dps: 0.55 }));
});

test('hash is stable hex sha256', () => {
  const h = contentHash({ dps: 0.55, ccy: 'SAR' });
  assert.match(h, /^[0-9a-f]{64}$/);
});

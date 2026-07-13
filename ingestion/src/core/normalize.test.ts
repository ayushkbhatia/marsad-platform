import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keySortJson,
  normalizeForHash,
  contentHash,
  sha256Hex,
} from './normalize.js';
import type { NormalizeRule } from './types.js';

test('keySortJson: deterministic regardless of key order', () => {
  const a = keySortJson({ b: 1, a: { d: 4, c: 3 } });
  const b = keySortJson({ a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b);
});

test('normalizeForHash: JSON key reordering dedupes to same hash', () => {
  const rules: NormalizeRule[] = [];
  const ct = 'application/json';
  const h1 = contentHash(Buffer.from('{"x":1,"y":2}'), rules, ct).sha256;
  const h2 = contentHash(Buffer.from('{"y":2,"x":1}'), rules, ct).sha256;
  assert.equal(h1, h2, 'key order must not change the content hash');
});

test('normalizeForHash: strips volatile timestamp before hashing', () => {
  // TDWL-style: content is identical except a server print time. A rule that
  // blanks the transactionDate must make both hash equal.
  const rules: NormalizeRule[] = [
    { pattern: '"transactionDate":"[^"]*"', replacement: '"transactionDate":""', flags: 'g' },
  ];
  const a = Buffer.from('{"transactionDate":"Jul 13, 2026 3:18:51 PM","lastTradePrice":51.5}');
  const b = Buffer.from('{"transactionDate":"Jul 13, 2026 3:59:00 PM","lastTradePrice":51.5}');
  const ct = 'text/html'; // TDWL sends text/html for JSON — sniffed as JSON anyway
  assert.equal(contentHash(a, rules, ct).sha256, contentHash(b, rules, ct).sha256);
});

test('normalizeForHash: different data still hashes differently', () => {
  const rules: NormalizeRule[] = [
    { pattern: '"transactionDate":"[^"]*"', replacement: '"transactionDate":""' },
  ];
  const a = Buffer.from('{"transactionDate":"t1","lastTradePrice":51.5}');
  const b = Buffer.from('{"transactionDate":"t2","lastTradePrice":52.0}');
  assert.notEqual(contentHash(a, rules, 'application/json').sha256, contentHash(b, rules, 'application/json').sha256);
});

test('normalizeForHash: malformed regex rule is skipped, never throws', () => {
  const rules: NormalizeRule[] = [{ pattern: '([unclosed', replacement: 'x' }];
  const r = normalizeForHash(Buffer.from('hello'), rules, 'text/html');
  assert.equal(r.appliedRules, 0, 'bad rule not applied');
  assert.equal(r.normalized.toString(), 'hello');
});

test('normalizeForHash: non-JSON HTML passes through, cache-buster rule applies', () => {
  const rules: NormalizeRule[] = [{ pattern: '_=\\d+', replacement: '_=0' }];
  const r = normalizeForHash(Buffer.from('<a href="x?_=1699999999">'), rules, 'text/html');
  assert.match(r.normalized.toString(), /_=0/);
});

test('sha256Hex: known digest', () => {
  assert.equal(
    sha256Hex(Buffer.from('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

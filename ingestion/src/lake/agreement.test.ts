import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, pricesAgree, candidatesAgree, primaryOf, type Candidate } from './agreement.js';

function cand(p: Partial<Candidate> & { sourceId: number }): Candidate {
  return {
    stagingId: p.stagingId ?? p.sourceId,
    sourceId: p.sourceId,
    sourceRank: p.sourceRank ?? 20,
    numericValue: p.numericValue ?? null,
    comparableText: p.comparableText ?? '',
    priceSensitive: p.priceSensitive ?? false,
  };
}

test('pricesAgree: within 0.5% agrees, beyond disagrees', () => {
  assert.equal(pricesAgree(100, 100.4), true); // 0.4%
  assert.equal(pricesAgree(100, 100.6), false); // 0.6%
  assert.equal(pricesAgree(100, 100), true);
  assert.equal(pricesAgree(0, 0), true);
});

test('candidatesAgree: numeric uses tolerance, non-numeric exact', () => {
  assert.equal(candidatesAgree(cand({ sourceId: 1, numericValue: 51.5 }), cand({ sourceId: 2, numericValue: 51.6 })), true);
  assert.equal(candidatesAgree(cand({ sourceId: 1, numericValue: 51.5 }), cand({ sourceId: 2, numericValue: 55 })), false);
  assert.equal(
    candidatesAgree(cand({ sourceId: 1, comparableText: '2026-07-28' }), cand({ sourceId: 2, comparableText: '2026-07-28' })),
    true,
  );
  assert.equal(
    candidatesAgree(cand({ sourceId: 1, comparableText: '2026-07-28' }), cand({ sourceId: 2, comparableText: '2026-07-29' })),
    false,
  );
});

test('primaryOf: lowest source_rank wins, ties by sourceId', () => {
  const p = primaryOf([
    cand({ sourceId: 3, sourceRank: 90 }),
    cand({ sourceId: 1, sourceRank: 10 }),
    cand({ sourceId: 2, sourceRank: 10 }),
  ]);
  assert.equal(p.sourceId, 1);
});

test('decide: single source ⇒ PENDING single_source', () => {
  const d = decide([cand({ sourceId: 1, numericValue: 10 })]);
  assert.equal(d.kind, 'PENDING');
  assert.equal(d.kind === 'PENDING' && d.reason, 'single_source');
});

test('decide: two sources from the SAME source id ⇒ still single_source', () => {
  const d = decide([
    cand({ sourceId: 1, stagingId: 1, numericValue: 10 }),
    cand({ sourceId: 1, stagingId: 2, numericValue: 10 }),
  ]);
  assert.equal(d.kind, 'PENDING');
});

test('decide: two independent sources agree ⇒ VERIFIED, primary wins', () => {
  const d = decide([
    cand({ sourceId: 20, sourceRank: 20, numericValue: 51.5 }),
    cand({ sourceId: 10, sourceRank: 10, numericValue: 51.6 }),
  ]);
  assert.equal(d.kind, 'VERIFIED');
  if (d.kind === 'VERIFIED') {
    assert.equal(d.winner.sourceId, 10); // registrar rank 10 wins
    assert.deepEqual(new Set(d.agreeingSourceIds), new Set([10, 20]));
  }
});

test('decide: two independent sources disagree ⇒ CONFLICT', () => {
  const d = decide([
    cand({ sourceId: 20, sourceRank: 20, numericValue: 51.5 }),
    cand({ sourceId: 10, sourceRank: 10, numericValue: 60 }),
  ]);
  assert.equal(d.kind, 'CONFLICT');
  if (d.kind === 'CONFLICT') assert.equal(d.winner.sourceId, 10);
});

test('decide: price-sensitive agreement ⇒ PENDING price_sensitive_hold (human required)', () => {
  const d = decide([
    cand({ sourceId: 20, numericValue: 0.55, priceSensitive: true }),
    cand({ sourceId: 10, numericValue: 0.55, priceSensitive: true }),
  ]);
  assert.equal(d.kind, 'PENDING');
  assert.equal(d.kind === 'PENDING' && d.reason, 'price_sensitive_hold');
});

test('decide: 2 agree + 1 outlier ⇒ VERIFIED on the majority cluster', () => {
  const d = decide([
    cand({ sourceId: 1, sourceRank: 20, numericValue: 100 }),
    cand({ sourceId: 2, sourceRank: 20, numericValue: 100.2 }),
    cand({ sourceId: 3, sourceRank: 90, numericValue: 120 }),
  ]);
  assert.equal(d.kind, 'VERIFIED');
  if (d.kind === 'VERIFIED') assert.deepEqual(new Set(d.agreeingSourceIds), new Set([1, 2]));
});

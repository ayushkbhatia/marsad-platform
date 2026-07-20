import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMarkNumbers } from './automark.js';
import { parseMagnitude } from './text.js';
import { runRules } from './engine.js';
import type { CitationRow, EngineOptions, RuleContext } from './types.js';

const BASE_OPTS: EngineOptions = { rulesetVersion: 9, bannedPhrases: [], headlineMaxChars: 90, autoWordCap: 40 };

/** A VERIFIED citation with a frozen numeric value (R-03/R-04 read cited_value). */
function cite(claim_key: string, cited_value: unknown): CitationRow {
  return {
    claim_key, lake_object_id: '00000000-0000-0000-0000-000000000001',
    cited_value, cited_hash: 'h', object_state: 'VERIFIED', object_payload: null,
  };
}

/** Minimal single-block/dek context so we can run R-03 over an auto-marked surface. */
function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    content_id: 'cid', content_type: 'WIRE', template_key: 'TPL-01',
    headline: 'A qualitative headline with no bare number', dek: null, word_count: 12, is_premium: false,
    blocks: [], citations: [], tickers: [{ security_id: 1, ticker: 'DPS', resolved_listed: true }],
    has_disclaimer_block: true, open_correction: false, distinct_lineage_roots: 2, ...over,
  };
}

function r03Of(r: Awaited<ReturnType<typeof runRules>>) { return r.results.find((x) => x.rule_key === 'R-03')!; }

// (a) dek "total assets crossing QAR 1.44 trillion" + a citation at 1.44e12 → marker appended,
//     then R-03 over the marked dek passes.
test('automark (a): appends a marker to a trillion-scale dek number, then R-03 passes', async () => {
  const cites = [{ key: 'c1', mag: parseMagnitude('QAR 1.44 trillion') }];
  assert.equal(cites[0].mag, 1.44e12, 'trillion must parse to 1.44e12 (aligns cite + sentence magnitudes)');

  const dek = 'Total assets crossing QAR 1.44 trillion.';
  const { text, added } = autoMarkNumbers(dek, cites);
  assert.ok(/QAR 1\.44 trillion \[c1\]/.test(text), `marker not appended: ${text}`);
  assert.deepEqual(added, [{ key: 'c1', mag: 1.44e12 }]);

  const r = await runRules(ctx({ dek: text, citations: [cite('c1', 'QAR 1.44 trillion')] }), BASE_OPTS);
  assert.equal(r03Of(r).outcome, 'passed', JSON.stringify(r03Of(r).detail));
  // Bonus: the injected marker cannot create an R-04 mismatch (both parse to 1.44e12).
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed');
});

// (b) body sentence restating c1 with no marker → c1 appended.
test('automark (b): appends the reused key to a restated figure', async () => {
  const cites = [{ key: 'c1', mag: 6_250_000_000 }];
  const body = 'The lender again posted a net profit of QAR 6.25bn for the quarter.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.ok(/QAR 6\.25bn \[c1\]/.test(text), text);
  assert.deepEqual(added, [{ key: 'c1', mag: 6_250_000_000 }]);

  const r = await runRules(ctx({
    blocks: [{ seq: 1, block_kind: 'text', body: text, bound_object_id: null, gated: false }],
    citations: [cite('c1', 6_250_000_000)],
  }), BASE_OPTS);
  assert.equal(r03Of(r).outcome, 'passed');
});

// (c) number with NO matching citation → NOT marked AND R-03 still blocks (the load-bearing test).
test('automark (c): leaves a genuinely unsourced number bare — R-03 still blocks', async () => {
  const cites = [{ key: 'c1', mag: 6_250_000_000 }]; // 6.25bn — does NOT match 400bn
  const body = 'Customer deposits rose to QAR 400bn over the year.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(text, body, 'unsourced number must be left byte-identical');
  assert.equal(added.length, 0);

  const r = await runRules(ctx({
    blocks: [{ seq: 1, block_kind: 'text', body: text, bound_object_id: null, gated: false }],
    citations: [cite('c1', 6_250_000_000)],
  }), BASE_OPTS);
  assert.equal(r03Of(r).outcome, 'blocked');
  assert.equal((r03Of(r).detail as { violations: { kind: string }[] }).violations[0].kind, 'number_without_citation');
});

// (d) already-marked sentence unchanged (idempotent).
test('automark (d): a number already followed by its matching marker is untouched', () => {
  const cites = [{ key: 'c1', mag: 6_250_000_000 }];
  const body = 'QNB reported net profit of QAR 6.25bn [c1].';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(text, body);
  assert.equal(added.length, 0);
  // Re-running the pass is a no-op (idempotent).
  assert.equal(autoMarkNumbers(text, cites).text, body);
});

// (e) two candidate citations for one number → left bare (ambiguous).
test('automark (e): an ambiguous number (2+ matching cites) is left bare', () => {
  const cites = [{ key: 'c1', mag: 6_250_000_000 }, { key: 'c2', mag: 6_250_000_000 }];
  const body = 'Net profit reached QAR 6.25bn.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(text, body);
  assert.equal(added.length, 0);
});

// Extra: only the FIRST occurrence of a repeated magnitude gets a marker (one marker satisfies R-03).
test('automark: a magnitude repeated in one sentence is marked once', () => {
  const cites = [{ key: 'c1', mag: 6_250_000_000 }];
  const body = 'Profit was QAR 6.25bn and the QAR 6.25bn figure held.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(added.length, 1);
  assert.equal((text.match(/\[c1\]/g) ?? []).length, 1, text);
});

// Extra: a bare year is never treated as a citable number.
test('automark: a bare year is ignored', () => {
  const cites = [{ key: 'c1', mag: 2026 }];
  const body = 'The board met in 2026 to review strategy.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(text, body);
  assert.equal(added.length, 0);
});

// Extra: a null-magnitude cite (a non-numeric label) is filtered out and marks nothing.
test('automark: a non-numeric citation cannot mark a number', () => {
  const cites = [{ key: 'c1', mag: parseMagnitude('unaudited') }];
  assert.equal(cites[0].mag, null);
  const body = 'Revenue climbed to QAR 12bn last year.';
  const { text, added } = autoMarkNumbers(body, cites);
  assert.equal(text, body);
  assert.equal(added.length, 0);
});

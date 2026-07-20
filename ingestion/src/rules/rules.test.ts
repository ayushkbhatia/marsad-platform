import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from './engine.js';
import type { CitationRow, EngineOptions, RuleContext } from './types.js';

const BASE_OPTS: EngineOptions = { rulesetVersion: 9, bannedPhrases: ['guaranteed returns', 'sure thing'], headlineMaxChars: 90, autoWordCap: 40 };

function cite(over: Partial<CitationRow> = {}): CitationRow {
  return { claim_key: 'c1', lake_object_id: '00000000-0000-0000-0000-000000000001', cited_value: 6_250_000_000, cited_hash: 'h', object_state: 'VERIFIED', object_payload: null, ...over };
}

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    content_id: 'cid', content_type: 'WIRE', template_key: 'TPL-01',
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    dek: null, word_count: 12, is_premium: false,
    blocks: [{ seq: 1, block_kind: 'text', body: 'QNB reported net profit of QAR 6.25bn [c1].', bound_object_id: null, gated: false }],
    citations: [cite()],
    tickers: [{ security_id: 1, ticker: 'QNBK', resolved_listed: true }],
    has_disclaimer_block: true, open_correction: false, distinct_lineage_roots: 2,
    ...over,
  };
}

test('clean wire passes all rules', async () => {
  const r = await runRules(ctx(), BASE_OPTS);
  assert.equal(r.passed, true, JSON.stringify(r.results.filter((x) => x.outcome === 'blocked')));
});

test('R-02 blocks an unresolved ticker', async () => {
  const r = await runRules(ctx({ tickers: [{ security_id: null, ticker: 'ZZZZ', resolved_listed: false }] }), BASE_OPTS);
  assert.equal(r.passed, false);
  assert.ok(r.results.find((x) => x.rule_key === 'R-02' && x.outcome === 'blocked'));
});

test('R-03 blocks a number with no citation marker', async () => {
  const r = await runRules(ctx({ blocks: [{ seq: 1, block_kind: 'text', body: 'QNB reported net profit of QAR 6.25bn this quarter.', bound_object_id: null, gated: false }] }), BASE_OPTS);
  assert.equal(r.passed, false);
  const r03 = r.results.find((x) => x.rule_key === 'R-03')!;
  assert.equal(r03.outcome, 'blocked');
  assert.equal((r03.detail as { violations: { kind: string }[] }).violations[0].kind, 'number_without_citation');
});

test('R-03 blocks a marker citing a non-VERIFIED object', async () => {
  const r = await runRules(ctx({ citations: [cite({ object_state: 'PENDING' })] }), BASE_OPTS);
  assert.equal(r.passed, false);
  assert.ok(r.results.find((x) => x.rule_key === 'R-03' && x.outcome === 'blocked'));
});

test('R-04 blocks a number that disagrees with the citation beyond 0.5%', async () => {
  // sentence says 6.25bn, citation frozen at 9.99bn → mismatch
  const r = await runRules(ctx({ citations: [cite({ cited_value: 9_990_000_000 })] }), BASE_OPTS);
  assert.equal(r.passed, false);
  assert.ok(r.results.find((x) => x.rule_key === 'R-04' && x.outcome === 'blocked'));
});

test('R-04 passes a number within 0.5% of the citation', async () => {
  const r = await runRules(ctx({ citations: [cite({ cited_value: 6_260_000_000 })] }), BASE_OPTS); // 0.16% off
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed');
});

test('R-05 blocks a banned phrase (diacritic/case-normalized)', async () => {
  const r = await runRules(ctx({ headline: 'QNB: Guaranteed  Returns for holders', word_count: 6, citations: [], blocks: [] }), BASE_OPTS);
  assert.ok(r.results.find((x) => x.rule_key === 'R-05' && x.outcome === 'blocked'));
});

test('R-10 auto-fixes a clickbait headline via the llm seam', async () => {
  const opts: EngineOptions = { ...BASE_OPTS, llm: { rewriteHeadline: async () => 'QNB posts QAR 6.25bn quarterly profit' } };
  const r = await runRules(ctx({ headline: 'SHOCKING: QNB profit will BLOW YOUR MIND [c1]', citations: [cite()], blocks: [] }), opts);
  const r10 = r.results.find((x) => x.rule_key === 'R-10')!;
  assert.equal(r10.outcome, 'passed_after_fix');
  assert.equal(r.finalHeadline, 'QNB posts QAR 6.25bn quarterly profit');
});

test('R-10 blocks when the rewrite still fails (or no llm)', async () => {
  const r = await runRules(ctx({ headline: 'x'.repeat(120), citations: [], blocks: [] }), BASE_OPTS);
  assert.equal(r.passed, false);
  assert.ok(r.results.find((x) => x.rule_key === 'R-10' && x.outcome === 'blocked'));
});

test('auto-publish eligible only with TPL-01 + ≤40w + ≥2 roots + no correction', async () => {
  assert.equal((await runRules(ctx(), BASE_OPTS)).autoPublishEligible, true);
  // one lineage root → not eligible, but still PASSES (drops to approval, never blocked)
  const oneRoot = await runRules(ctx({ distinct_lineage_roots: 1 }), BASE_OPTS);
  assert.equal(oneRoot.passed, true);
  assert.equal(oneRoot.autoPublishEligible, false);
  // open correction → not eligible
  assert.equal((await runRules(ctx({ open_correction: true }), BASE_OPTS)).autoPublishEligible, false);
  // non-wire template → not eligible
  assert.equal((await runRules(ctx({ template_key: 'TPL-03', word_count: 600 }), BASE_OPTS)).autoPublishEligible, false);
});

test('R-01 auto-fixes a missing disclaimer without blocking', async () => {
  const r = await runRules(ctx({ has_disclaimer_block: false }), BASE_OPTS);
  assert.equal(r.passed, true);
  assert.equal(r.results.find((x) => x.rule_key === 'R-01')!.outcome, 'auto_fixed');
});

test('R-06 warns (never blocks) on a stretched metric in a TAKE', async () => {
  const r = await runRules(ctx({ content_type: 'TAKE', template_key: 'TPL-07',
    headline: 'A closer look at the QNB payout', word_count: 6,
    citations: [cite({ cited_value: 180 })],
    blocks: [{ seq: 1, block_kind: 'text', body: 'The payout ratio of 180% is a concern [c1].', bound_object_id: null, gated: false }] }), BASE_OPTS);
  assert.equal(r.passed, true, JSON.stringify(r.results.filter((x) => x.outcome === 'blocked')));
  assert.equal(r.results.find((x) => x.rule_key === 'R-06')!.outcome, 'warned');
});

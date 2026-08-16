import { hasNumber } from './text.js';
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

// ── R-03 provenance floor (09 §3.2) ────────────────────────────────────────────────────
// The floor replaced a blanket `state === 'VERIFIED'` demand that contradicted PE.6 intake:
// the system admitted PENDING FILING.FINANCIALS and then refused to let anyone cite them, so
// every admissible piece was guaranteed to block. These pin the new behaviour in both
// directions — what it now allows, and what it must still refuse.

const FLOOR_OPTS: EngineOptions = {
  ...BASE_OPTS,
  rulesetVersion: 10,
  citableStatesByType: {
    'FILING.FINANCIALS': ['VERIFIED', 'PENDING'],
    'COMPUTED.RATIOS': ['VERIFIED'],
  },
};

test('R-03 admits a PENDING object whose type allows it and whose lineage succeeded', async () => {
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'PENDING', object_type: 'FILING.FINANCIALS', parse_run_ok: true })] }),
    FLOOR_OPTS,
  );
  assert.equal(r.passed, true, JSON.stringify(r.results.filter((x) => x.outcome === 'blocked')));
});

test('R-03 fails closed for a type with no citable_states entry', async () => {
  // EARNINGS.VERDICT is not in FLOOR_OPTS: an unregistered family must not become citable
  // just because it exists. Mirrors lake.fn_intake_eligible_state's unknown-type fallback.
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'PENDING', object_type: 'EARNINGS.VERDICT', parse_run_ok: true })] }),
    FLOOR_OPTS,
  );
  assert.equal(r.passed, false);
  const v = (r.results.find((x) => x.rule_key === 'R-03')!.detail as { violations: { kind: string }[] }).violations;
  assert.equal(v[0].kind, 'cited_object_state_not_citable');
});

test('R-03 blocks a CONFLICT object even when its type allows the state', async () => {
  // Two sources disagree about this number, so there is no fact to cite. Never configurable.
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'CONFLICT', object_type: 'FILING.FINANCIALS', parse_run_ok: true })] }),
    { ...FLOOR_OPTS, citableStatesByType: { 'FILING.FINANCIALS': ['VERIFIED', 'PENDING', 'CONFLICT'] } },
  );
  assert.equal(r.passed, false);
  const v = (r.results.find((x) => x.rule_key === 'R-03')!.detail as { violations: { kind: string }[] }).violations;
  assert.equal(v[0].kind, 'cited_object_in_conflict');
});

test('R-03 blocks a superseded object', async () => {
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'VERIFIED', object_type: 'FILING.FINANCIALS', parse_run_ok: true, superseded: true })] }),
    FLOOR_OPTS,
  );
  assert.equal(r.passed, false);
  const v = (r.results.find((x) => x.rule_key === 'R-03')!.detail as { violations: { kind: string }[] }).violations;
  assert.equal(v[0].kind, 'cited_object_superseded');
});

test('R-03 blocks an object whose parse-run lineage did not succeed', async () => {
  // The load-bearing clause: without it "traceable to a primary document" is asserted, not checked.
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'PENDING', object_type: 'FILING.FINANCIALS', parse_run_ok: false })] }),
    FLOOR_OPTS,
  );
  assert.equal(r.passed, false);
  const v = (r.results.find((x) => x.rule_key === 'R-03')!.detail as { violations: { kind: string }[] }).violations;
  assert.equal(v[0].kind, 'cited_object_lineage_unproven');
});

test('R-03 keeps failing closed when no allowlist is injected at all', async () => {
  // An older caller that does not pass citableStatesByType must not silently widen the floor.
  const r = await runRules(
    ctx({ citations: [cite({ object_state: 'PENDING', object_type: 'FILING.FINANCIALS', parse_run_ok: true })] }),
    BASE_OPTS,
  );
  assert.equal(r.passed, false);
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

test('R-04 recognises a trillion-scale figure and matches its citation', async () => {
  // "QAR 1.44 trillion" must parse to 1.44e12 so it matches a cite frozen at that value
  // (regression guard for the trillion/tn unit added for the QNBK total-assets dek).
  const r = await runRules(ctx({
    headline: 'QNB total assets pass a milestone', word_count: 14,
    dek: 'Total assets crossed QAR 1.44 trillion [c1].',
    blocks: [{ seq: 1, block_kind: 'text', body: 'Total assets reached QAR 1.44 trillion [c1].', bound_object_id: null, gated: false }],
    citations: [cite({ cited_value: 'QAR 1.44 trillion' })],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-03')!.outcome, 'passed', JSON.stringify(r.results.find((x) => x.rule_key === 'R-03')!.detail));
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed', JSON.stringify(r.results.find((x) => x.rule_key === 'R-04')!.detail));
});

// ── R-04 unit handling ─────────────────────────────────────────────────────────────────
// The lake stores growth as a fraction; the writer renders it as a percent. Comparing the
// two directly blocked EVERY percentage story — the single highest-frequency real failure
// in the recorded violations.

test('R-04 matches a lake fraction against its percent rendering in prose', async () => {
  const r = await runRules(ctx({
    headline: 'QNB revenue rises 11.6% in the quarter',
    blocks: [{ seq: 1, block_kind: 'text', body: 'Revenue rose 11.6% year on year [c1].', bound_object_id: null, gated: false }],
    citations: [cite({ cited_value: 0.1159 })],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  assert.equal(r04.outcome, 'passed', JSON.stringify(r04.detail));
});

test('R-04 still blocks a percent that is off by a factor of ten', async () => {
  // 0.1159 is 11.59%, not 1.159% — the equivalence must not become a free pass.
  const r = await runRules(ctx({
    headline: 'QNB revenue rises 1.159% in the quarter',
    blocks: [{ seq: 1, block_kind: 'text', body: 'Revenue rose 1.159% year on year [c1].', bound_object_id: null, gated: false }],
    citations: [cite({ cited_value: 0.1159 })],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'blocked');
});

test('R-04 matches a negative fraction against its percent rendering', async () => {
  const r = await runRules(ctx({
    headline: 'QNB margin narrows',
    blocks: [{ seq: 1, block_kind: 'text', body: 'Net margin fell 5.86% year on year [c1].', bound_object_id: null, gated: false }],
    citations: [cite({ cited_value: -0.0586 })],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed');
});

test('R-04 still catches a direction error when the prose asserts a sign', async () => {
  // Unsigned comparison must not become a free pass: if the writer wrote "-5.86%" against a
  // cited +0.0586, they have asserted a direction the lake contradicts.
  const r = await runRules(ctx({
    headline: 'QNB margin moves',
    blocks: [{ seq: 1, block_kind: 'text', body: 'Net margin moved -5.86% year on year [c1].', bound_object_id: null, gated: false }],
    citations: [cite({ cited_value: 0.0586 })],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'blocked');
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

// ── R-04 every-numeral (the `some` → `every` fix) ─────────────────────────────────────────────
// Each of these pins one half of the trade-off: the first proves the defect is caught, the rest
// prove the stricter rule does not false-block honest copy. A BLOCK rule that fires on everything
// gets switched off, which is worse than the gap it closed.

test('R-04 blocks the free-riding numbers that shipped live', async () => {
  // The actual published QNB sentence. c1 = QAR 4.43bn matched, so the OLD rule passed it —
  // and 4.22bn (sourced to nothing) and 11.2% (cited to a NET PROFIT object) rode along.
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 4.43bn net profit',
    citations: [cite({ cited_value: 4_430_000_000 })],
    blocks: [{ seq: 1, block_kind: 'text', bound_object_id: null, gated: false,
      body: 'QNB reported net profit of QAR 4.43bn for Q2 2026 [c1], up from QAR 4.22bn a year earlier, with revenue rising 11.2% [c1].' }],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  assert.equal(r04.outcome, 'blocked');
  const v = (r04.detail as { violations: { kind: string; value?: number }[] }).violations
    .filter((x) => x.kind === 'number_unaccounted');
  assert.equal(v.length, 2, JSON.stringify(v));
  // float tolerance: 4.22 * 1e9 is 4219999999.9999995, not 4.22e9 exactly
  const near = (a: number, b: number) => Math.abs(a - b) / b < 1e-9;
  assert.ok(v.some((x) => near(x.value!, 4_220_000_000)), 'the uncited prior-year figure');
  assert.ok(v.some((x) => near(x.value!, 11.2)), 'the growth % cited to a net-profit object');
});

test('R-04 allows a second number when it IS cited', async () => {
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    citations: [cite(), cite({ claim_key: 'c2', cited_value: 1_440_000_000_000 })],
    blocks: [{ seq: 1, block_kind: 'text', bound_object_id: null, gated: false,
      body: 'QNB reported net profit of QAR 6.25bn [c1]. Total assets reached QAR 1.44 trillion [c2].' }],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed',
    JSON.stringify(r.results.find((x) => x.rule_key === 'R-04')!.detail));
});

test('R-04 does not block incidental integers or a year', async () => {
  // "three of the four", "8 rows", "Q2 2026" — prose, not claims. Requiring these to resolve to a
  // lake value would refuse most honest copy.
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    blocks: [{ seq: 1, block_kind: 'text', bound_object_id: null, gated: false,
      body: 'In Q2 2026 QNB reported net profit of QAR 6.25bn [c1], the 3 of 4 quarters it has grown.' }],
  }), BASE_OPTS);
  assert.equal(r.results.find((x) => x.rule_key === 'R-04')!.outcome, 'passed',
    JSON.stringify(r.results.find((x) => x.rule_key === 'R-04')!.detail));
});

test('R-04 leaves an UNMARKED sentence to R-03 rather than double-blocking', async () => {
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    blocks: [{ seq: 1, block_kind: 'text', bound_object_id: null, gated: false,
      body: 'QNB reported net profit of QAR 6.25bn [c1]. Revenue rose 11.2% last year.' }],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  const unaccounted = (r04.detail as { violations?: { kind: string }[] }).violations
    ?.filter((x) => x.kind === 'number_unaccounted') ?? [];
  assert.equal(unaccounted.length, 0, 'the unmarked 11.2% is R-03 number_without_citation');
  assert.ok(r.results.find((x) => x.rule_key === 'R-03' && x.outcome === 'blocked'));
});

test('R-04 no longer calls an unrelated payload value "drift"', async () => {
  // The recorded live failure: findPayloadMagnitude matched a FISCAL YEAR (2026) against a
  // QAR 4.43bn profit and declared drift, blocking every citation in both real drafts.
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 4.43bn net profit',
    citations: [cite({ cited_value: 4_430_000_000, object_payload: { fiscal_year: 2026, period: 'Q2' } })],
    blocks: [{ seq: 1, block_kind: 'text', bound_object_id: null, gated: false,
      body: 'QNB reported net profit of QAR 4.43bn [c1].' }],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  const drift = (r04.detail as { violations?: { kind: string }[] }).violations
    ?.filter((x) => x.kind === 'lake_drift') ?? [];
  assert.equal(drift.length, 0, JSON.stringify(drift));
});

test('R-04 still reports REAL drift on the field the citation names', async () => {
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    citations: [cite({
      cited_value: 6_250_000_000,
      object_payload: { net_income: 6_400_000_000 },
      payload_path: 'net_income',
    })],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  const drift = (r04.detail as { violations?: { kind: string }[] }).violations
    ?.filter((x) => x.kind === 'lake_drift') ?? [];
  assert.equal(drift.length, 1, 'a 2.4% move on the cited field is drift and must still block');
});

test('R-04 does not compare a growth rate against the P/E that sits beside it', async () => {
  // Item 3, live: citation c15 reads "trailing twelve-month revenue growth rate · 10.6%" against
  // a COMPUTED.RATIOS object holding pb, pe, ps, roe, eps_ttm and a dozen more. The old probe
  // returned 9.5957 — the P/E — and called the 10% gap drift. They are different quantities;
  // their proximity is a coincidence, and no tolerance band can tell that from a real move.
  const r = await runRules(ctx({
    headline: 'QNB revenue growth reaches 10.6%',
    citations: [cite({
      cited_value: 10.6,
      object_payload: { pb: 1.193, pe: 9.5956938, ps: 4.4446, roe: 0.1344, eps_ttm: 1.756 },
      payload_path: 'revenue_growth_ttm',   // present in the citation, absent from the payload
    })],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  const d = r04.detail as { violations?: { kind: string }[]; unchecked?: { kind: string }[] };
  assert.equal((d.violations ?? []).filter((x) => x.kind === 'lake_drift').length, 0);
  // And it is reported as UNCHECKED, not silently passed — the check could not run.
  assert.ok((d.unchecked ?? []).some((x) => x.kind === 'lake_drift_unchecked'));
});

test('a citation with no payload_path is unchecked, never passed', async () => {
  const r = await runRules(ctx({
    headline: 'QNB posts QAR 6.25bn quarterly profit',
    citations: [cite({ cited_value: 6_250_000_000, object_payload: { net_income: 6_400_000_000 } })],
  }), BASE_OPTS);
  const r04 = r.results.find((x) => x.rule_key === 'R-04')!;
  const d = r04.detail as { violations?: { kind: string }[]; unchecked?: { kind: string; why?: string }[] };
  assert.equal((d.violations ?? []).filter((x) => x.kind === 'lake_drift').length, 0);
  assert.match((d.unchecked ?? [])[0]?.why ?? '', /no payload_path/);
});

test("R-03's trigger and R-04's materiality test agree on what a number is", () => {
  // Live block:3 on item 3: "QNB Q2 2026 net profit for the quarter ended 30 June 2026".
  // A composed block's caption is almost entirely period labels — the figure itself is a
  // BINDING, not typed prose — so a trigger that fires on the `2` in Q2 and the `30` in a date
  // demanded a citation for a sentence that asserts nothing, and blocked every composed piece.
  assert.equal(hasNumber("QNB Q2 2026 net profit for the quarter ended 30 June 2026"), false);
  assert.equal(hasNumber("Results for the quarter ended 30 June 2026"), false);

  // What must still trigger: anything carrying a unit, a separator, or a magnitude.
  assert.equal(hasNumber("Net profit was QAR 4.43bn"), true);
  assert.equal(hasNumber("Operating income rose 11.2%"), true);
  assert.equal(hasNumber("Assets reached 1,013,707"), true);
  assert.equal(hasNumber("The bank booked 4430000000 in profit"), true);
});

/**
 * PD.8 — the fit stage's refusal surface.
 *
 * The three fixtures the phase is specified against (09 §6, BRIDGE-BUILD-PLAN PD.8):
 *   · a piece carrying a block that is not in the vocabulary  → refused, code named
 *   · a `requires_binding` block with no citation             → refused, block named
 *   · prose that says 12.4% while its bound object says 12.1% → refused, both values named
 * plus the judgement calls: legacy codes, the AI piece-type axis, `payload_schema` null,
 * and the constraint parser's refusal to guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFit, parseConstraint, isMaterialNumeral, resolvePieceType, isChassisKind,
  type FitBlock, type FitCitation, type FitInput, type RegistryBlock,
} from '../newsroom/fit-engine.js';
import { makeFitStage } from '../newsroom/fit.js';
import { makeRulesStage } from '../newsroom/rules-stage.js';
import { makeCtx, makeFakeSql } from './fakes.js';

// ---------------------------------------------------------------------------
// Fixtures — mirrors of the live ops.story_blocks rows (verified 2026-07-27).
// ---------------------------------------------------------------------------

function reg(over: Partial<RegistryBlock> & { key: string }): RegistryBlock {
  return {
    status: 'active', family: null, piece_types: ['ALL'], requires_binding: false,
    binds_to: null, constraints: null, payload_schema: null, ...over,
  };
}

const REGISTRY: Record<string, RegistryBlock> = Object.fromEntries([
  reg({ key: 'BLK-FINTABLE', family: 'C', piece_types: ['DEEP DIVE', 'NOTE'], requires_binding: true, binds_to: 'filing.financials',
        constraints: ['MAX 8 ROWS INLINE — longer tables go to the XLSX', 'Fixed column widths 62px, mono tabular numerals right-aligned'] }),
  reg({ key: 'BLK-STATSTRIP', family: 'C', requires_binding: true, constraints: ['3–5 CELLS MAX', 'ONE FACT EACH'] }),
  reg({ key: 'BLK-BIGNUM', family: 'B', requires_binding: true, constraints: ['ONE PER PIECE'] }),
  reg({ key: 'BLK-CITE', family: 'A', piece_types: ['AI', 'NOTE'], requires_binding: true, binds_to: 'lake.object.id', constraints: ['Mandatory on every AI factual claim'] }),
  reg({ key: 'BLK-TIMELINE', family: 'E', piece_types: ['EXPLAINER', 'IPO'], constraints: ['EXACTLY ONE STAGE IN RED — THE ONE THAT COSTS MONEY IF MISSED'] }),
  reg({ key: 'BLK-CUT', family: 'H', constraints: ['THE CUT FALLS AFTER A COMPLETE THOUGHT, NEVER MID-SENTENCE (R-09)'] }),
  reg({ key: 'BLK-TABLE', status: 'legacy', piece_types: null }),
  reg({ key: 'BLK-CHART', status: 'legacy', piece_types: null }),
].map((r) => [r.key, r]));

// Version nibble 4, variant nibble 8 — i.e. a real RFC 9562 v4, not just 8-4-4-4-12 hex. It has to
// be: `lake.objects.id` defaults to gen_random_uuid() and 20,000/20,000 live ids are strict v4
// (checked 2026-07-27), so `z.uuid()` in the binding schema is strict too. The old all-1s constant
// was a shape the DB would accept but the D-8 binding rule would refuse.
const OBJ = '11111111-1111-4111-8111-111111111111';

function block(over: Partial<FitBlock> & { seq: number; code: string }): FitBlock {
  return { payload: {}, bound_object_id: null, gated: false, ...over };
}

function cite(over: Partial<FitCitation> = {}): FitCitation {
  return { claim_key: 'c1', object_id: OBJ, quoted_value: null, object_state: 'VERIFIED', object_payload: null, ...over };
}

function input(over: Partial<FitInput> = {}): FitInput {
  return {
    content_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    content_type: 'ARTICLE',
    template_key: 'TPL-02',
    is_premium: false,
    word_count: 300,
    agent_authored: true,
    premium_cut_after_block: null,
    blocks: [block({ seq: 1, code: 'text', payload: { text: 'A plain paragraph with no figures at all.' } })],
    citations: [],
    registry: REGISTRY,
    pipelineTemplate: { key: 'TPL-02', block_keys: ['BLK-TICKER', 'BLK-DELTA', 'BLK-TABLE', 'BLK-CHART'], auto_publish_eligible: false, always_premium: false, max_words: null },
    layoutTemplate: null,
    ...over,
  };
}

const codes = (rs: { code: string }[]): string[] => rs.map((r) => r.code);

// ---------------------------------------------------------------------------
// 1. Out-of-vocabulary block
// ---------------------------------------------------------------------------

test('fit: refuses a block that is not in ops.story_blocks, naming the code', () => {
  const r = runFit(input({ blocks: [block({ seq: 1, code: 'BLK-INFOGRAPHIC' })] }));
  assert.equal(r.passed, false);
  const hit = r.refusals.find((x) => x.code === 'FIT-BLOCK-UNKNOWN');
  assert.ok(hit, `expected FIT-BLOCK-UNKNOWN, got ${codes(r.refusals).join(',')}`);
  assert.equal(hit.block_code, 'BLK-INFOGRAPHIC');
  assert.equal(hit.seq, 1);
  assert.match(String(hit.evidence.why), /no agent may invent a block/);
});

test('fit: chassis prose kinds are not design blocks and are never refused', () => {
  for (const kind of ['text', 'heading', 'pull_quote', 'pullquote', 'disclaimer']) {
    assert.equal(isChassisKind(kind), true, kind);
  }
  const r = runFit(input({ blocks: [block({ seq: 1, code: 'pull_quote', payload: { text: 'A human voice.' } })] }));
  assert.deepEqual(codes(r.refusals), []);
});

// ---------------------------------------------------------------------------
// 2. Legacy codes — the judgement call
// ---------------------------------------------------------------------------

test('fit: a piece that EMITS a legacy code is refused', () => {
  const r = runFit(input({ blocks: [block({ seq: 1, code: 'BLK-TABLE' })] }));
  const hit = r.refusals.find((x) => x.code === 'FIT-BLOCK-LEGACY');
  assert.ok(hit);
  assert.equal(hit.block_code, 'BLK-TABLE');
  assert.equal(hit.evidence.status, 'legacy');
});

test('fit: a TEMPLATE that merely names legacy keys warns — it does not refuse', () => {
  const r = runFit(input());   // TPL-02 declares BLK-TABLE + BLK-CHART, both legacy
  assert.equal(r.passed, true, `unexpected refusals: ${codes(r.refusals).join(',')}`);
  const w = r.warnings.find((x) => x.code === 'FIT-TEMPLATE-LEGACY-KEY');
  assert.ok(w);
  assert.deepEqual((w.evidence.legacy_keys as string[]).sort(), ['BLK-CHART', 'BLK-TABLE']);
});

// ---------------------------------------------------------------------------
// 3. Piece-type permission — the join lives on the BLOCK
// ---------------------------------------------------------------------------

test('fit: refuses a block whose piece_types exclude this piece type', () => {
  // BLK-FINTABLE is DEEP DIVE · NOTE; this is a WIRE.
  const r = runFit(input({
    content_type: 'WIRE', template_key: 'TPL-01',
    pipelineTemplate: { key: 'TPL-01', block_keys: ['BLK-TICKER'], auto_publish_eligible: true, always_premium: false, max_words: 40 },
    blocks: [block({ seq: 1, code: 'BLK-FINTABLE', bound_object_id: OBJ })],
    citations: [cite()],
    word_count: 30,
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-BLOCK-PIECE-TYPE');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.deepEqual(hit.evidence.piece_types_allowed, ['DEEP DIVE', 'NOTE']);
  assert.deepEqual(hit.evidence.piece_type_of_this_piece, ['WIRE', 'AI']);
});

test('fit: the AI axis is orthogonal — BLK-CITE is legal on an agent-written feature', () => {
  const r = runFit(input({
    blocks: [block({ seq: 1, code: 'BLK-CITE', bound_object_id: OBJ })],
    citations: [cite()],
  }));
  assert.ok(!r.refusals.some((x) => x.code === 'FIT-BLOCK-PIECE-TYPE'), codes(r.refusals).join(','));
});

test('fit: the same block on a HUMAN-written feature is refused (AI is not implied)', () => {
  const r = runFit(input({
    agent_authored: false,
    blocks: [block({ seq: 1, code: 'BLK-CITE', bound_object_id: OBJ })],
    citations: [cite()],
  }));
  assert.ok(r.refusals.some((x) => x.code === 'FIT-BLOCK-PIECE-TYPE'));
});

test('fit: refuses when no design piece type resolves', () => {
  const r = runFit(input({ content_type: 'NEWSLETTER', template_key: null, pipelineTemplate: null }));
  assert.ok(r.refusals.some((x) => x.code === 'FIT-PIECE-TYPE-UNRESOLVED'));
  assert.equal(resolvePieceType('NEWSLETTER', null), null);
  assert.equal(resolvePieceType('ARTICLE', 'TPL-08'), 'DEEP DIVE');   // template axis wins
  assert.equal(resolvePieceType('ARTICLE', null), 'FEATURE');
});

// ---------------------------------------------------------------------------
// 4. Binding
// ---------------------------------------------------------------------------

test('fit: refuses a requires_binding block with no bound object', () => {
  const r = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04',
    pipelineTemplate: { key: 'TPL-04', block_keys: ['BLK-FINTABLE'], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [block({ seq: 2, code: 'BLK-FINTABLE' })],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-BIND-MISSING');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.block_code, 'BLK-FINTABLE');
  assert.equal(hit.seq, 2);
  assert.equal(hit.evidence.binds_to, 'filing.financials');
});

test('fit: refuses a requires_binding block whose object has no lake.citations row', () => {
  const r = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04',
    pipelineTemplate: { key: 'TPL-04', block_keys: ['BLK-FINTABLE'], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [block({ seq: 3, code: 'BLK-FINTABLE', bound_object_id: OBJ, payload: { rows: [] } })],
    citations: [cite({ object_id: '99999999-9999-9999-9999-999999999999' })],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-BIND-UNCITED');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.block_code, 'BLK-FINTABLE');
  assert.equal(hit.evidence.bound_object_id, OBJ);
  assert.equal(hit.rule, 'R-03');
});

test('fit: refuses a binding whose lake object is not VERIFIED', () => {
  const r = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04',
    pipelineTemplate: { key: 'TPL-04', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [block({ seq: 1, code: 'BLK-FINTABLE', bound_object_id: OBJ })],
    citations: [cite({ object_state: 'PENDING' })],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-BIND-UNRESOLVED');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.evidence.object_state, 'PENDING');
});

// ---------------------------------------------------------------------------
// 5. Numeric consistency — "the prose says 12.4% and the bound object says 12.1%"
// ---------------------------------------------------------------------------

test('fit: refuses prose that says 12.4% when the bound object says 12.1%', () => {
  const r = runFit(input({
    blocks: [block({
      seq: 1, code: 'text', bound_object_id: OBJ,
      payload: { text: 'Net margin reached 12.4% in the quarter [c1].' },
    })],
    citations: [cite({ object_payload: { net_margin_pct: 12.1 } })],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-NUMBER-MISMATCH');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.rule, 'R-04');
  assert.equal(hit.evidence.prose_token, '12.4%');
  assert.equal(hit.evidence.prose_value, 12.4);
  assert.equal(hit.evidence.nearest_reachable_value, 12.1);
  assert.match(String(hit.evidence.nearest_source), /net_margin_pct/);
});

test('fit: accepts prose within the shared 0.5% tolerance, and a fraction-stored percent', () => {
  const ok = runFit(input({
    blocks: [block({ seq: 1, code: 'text', bound_object_id: OBJ, payload: { text: 'Net margin reached 12.1% [c1].' } })],
    citations: [cite({ object_payload: { net_margin_pct: 12.13 } })],
  }));
  assert.deepEqual(codes(ok.refusals), []);

  const asFraction = runFit(input({
    blocks: [block({ seq: 1, code: 'text', bound_object_id: OBJ, payload: { text: 'Net margin reached 12.1% [c1].' } })],
    citations: [cite({ object_payload: { net_margin: 0.121 } })],
  }));
  assert.deepEqual(codes(asFraction.refusals), []);
});

test('fit: refuses figures in a block with nothing to check them against', () => {
  const r = runFit(input({ blocks: [block({ seq: 1, code: 'text', payload: { text: 'Profit rose to SAR 6.25bn.' } })] }));
  const hit = r.refusals.find((x) => x.code === 'FIT-NUMBER-UNSOURCED');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.deepEqual(hit.evidence.numerals, ['SAR 6.25bn']);
});

test('fit: the materiality filter — years and bare small integers are reported, not refused', () => {
  assert.equal(isMaterialNumeral('2026'), false);
  assert.equal(isMaterialNumeral('8'), false);
  assert.equal(isMaterialNumeral('12.4%'), true);
  assert.equal(isMaterialNumeral('SAR 6.25bn'), true);
  assert.equal(isMaterialNumeral('11,801'), true);
  assert.equal(isMaterialNumeral('4500'), true);

  const r = runFit(input({ blocks: [block({ seq: 1, code: 'text', payload: { text: 'In 2026 the board named 3 priorities.' } })] }));
  assert.deepEqual(codes(r.refusals), []);
  const u = r.unchecked.find((x) => x.code === 'FIT-NUMBER-IMMATERIAL');
  assert.ok(u);
  assert.deepEqual(u.evidence.tokens, ['2026', '3']);
});

// ---------------------------------------------------------------------------
// 6. Per-block constraints, parsed from the registry's own prose
// ---------------------------------------------------------------------------

test('fit: BLK-FINTABLE refuses a 9-row inline table (max 8, from ops.story_blocks.constraints)', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ label: `row${i}` }));
  const r = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04',
    pipelineTemplate: { key: 'TPL-04', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [block({ seq: 1, code: 'BLK-FINTABLE', bound_object_id: OBJ, payload: { rows } })],
    citations: [cite()],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-CONSTRAINT-CARDINALITY');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.evidence.count, 9);
  assert.equal(hit.evidence.payload_field, 'rows');
  assert.match(String(hit.evidence.constraint), /MAX 8 ROWS/);

  const eight = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04',
    pipelineTemplate: { key: 'TPL-04', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [block({ seq: 1, code: 'BLK-FINTABLE', bound_object_id: OBJ, payload: { rows: rows.slice(0, 8) } })],
    citations: [cite()],
  }));
  assert.ok(!eight.refusals.some((x) => x.code === 'FIT-CONSTRAINT-CARDINALITY'));
});

test('fit: ONE PER PIECE is enforced across the whole piece', () => {
  const r = runFit(input({
    blocks: [
      block({ seq: 1, code: 'BLK-BIGNUM', bound_object_id: OBJ }),
      block({ seq: 2, code: 'BLK-BIGNUM', bound_object_id: OBJ }),
    ],
    citations: [cite()],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-CONSTRAINT-UNIQUE');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.evidence.instances, 2);
});

test('constraint parser: reads cardinality, and refuses to guess at everything else', () => {
  assert.deepEqual(parseConstraint('MAX 8 ROWS INLINE'), { kind: 'max', n: 8, noun: 'ROWS' });
  assert.deepEqual(parseConstraint('3–5 CELLS MAX'), { kind: 'range', min: 3, max: 5, noun: 'CELLS' });
  assert.deepEqual(parseConstraint('4 OR 8 CELLS'), { kind: 'oneof', ns: [4, 8], noun: 'CELLS' });
  assert.deepEqual(parseConstraint('EXACTLY THREE SCENARIOS'), { kind: 'exact', n: 3, noun: 'SCENARIOS' });
  // The suffix decides: ONLY is a count, MAX is a ceiling.
  assert.deepEqual(parseConstraint('TWO PERIODS ONLY'), { kind: 'exact', n: 2, noun: 'PERIODS' });
  assert.deepEqual(parseConstraint('THREE LABELS MAX'), { kind: 'max', n: 3, noun: 'LABELS' });
  assert.deepEqual(parseConstraint('NEVER STACK MORE THAN 3 AREAS'), { kind: 'max', n: 3, noun: 'AREAS' });
  assert.deepEqual(parseConstraint('ONE PER PIECE'), { kind: 'one_per_piece' });
  assert.deepEqual(parseConstraint('ONE PER 1,500 WORDS'), { kind: 'per_words', words: 1500 });
  // The clause-completeness guard: "one of the four stages is red" is NOT "there is one stage".
  assert.equal(parseConstraint('EXACTLY ONE STAGE IN RED'), null);
  assert.equal(parseConstraint('MAX 8×8'), null);
  assert.equal(parseConstraint('4-column CSS grid with hairline #dcd8cc cell borders'), null);
  assert.equal(parseConstraint('130px plot height'), null);
});

test('fit: an unparseable constraint is reported as unchecked, never as a pass', () => {
  const r = runFit(input({
    content_type: 'EXPLAINER', template_key: 'TPL-06',
    pipelineTemplate: { key: 'TPL-06', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null },
    // The payload must be VALID for this test to isolate what it is about. Once Zod became the
    // enforcer a stub `[{}, {}, {}, {}]` earns a real FIT-PAYLOAD-SCHEMA refusal, which would mask
    // the thing under test: that an unparseable *constraint* is reported, not silently passed.
    blocks: [block({ seq: 1, code: 'BLK-TIMELINE', payload: { stages: [
      { name: 'Ex-date', date: '2026-08-01', description: 'Buy before this date to receive the dividend.', is_critical: true },
      { name: 'Pay date', date: '2026-08-20', description: 'Cash settles to the holder of record.', is_critical: false },
    ] } })],
  }));
  assert.deepEqual(codes(r.refusals), []);
  const u = r.unchecked.find((x) => x.code === 'FIT-CONSTRAINT-PROSE');
  assert.ok(u);
  assert.match(String(u.evidence.constraint), /EXACTLY ONE STAGE IN RED/);
});

// ---------------------------------------------------------------------------
// 7. ops.templates policy — the values that were hard-coded three or four times
// ---------------------------------------------------------------------------

test('fit: reads the word cap from ops.templates.max_words rather than a literal 40', () => {
  const tpl = { key: 'TPL-01', block_keys: ['BLK-TICKER'], auto_publish_eligible: true, always_premium: false, max_words: 40 };
  const r = runFit(input({ content_type: 'WIRE', template_key: 'TPL-01', pipelineTemplate: tpl, word_count: 44 }));
  const hit = r.refusals.find((x) => x.code === 'FIT-TEMPLATE-MAXWORDS');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.evidence.source, 'ops.templates.max_words');
  assert.equal(hit.evidence.cap, 40);
  assert.equal(hit.evidence.word_count, 44);

  assert.ok(!runFit(input({ content_type: 'WIRE', template_key: 'TPL-01', pipelineTemplate: tpl, word_count: 40 }))
    .refusals.some((x) => x.code === 'FIT-TEMPLATE-MAXWORDS'));
});

test('fit: an always_premium template on a free piece is refused', () => {
  const r = runFit(input({
    template_key: 'TPL-08', is_premium: false,
    pipelineTemplate: { key: 'TPL-08', block_keys: [], auto_publish_eligible: false, always_premium: true, max_words: null },
  }));
  assert.ok(r.refusals.some((x) => x.code === 'FIT-TEMPLATE-PREMIUM'));
});

test('fit: an unknown template_key is refused', () => {
  const r = runFit(input({ template_key: 'TPL-99', pipelineTemplate: null }));
  const hit = r.refusals.find((x) => x.code === 'FIT-TEMPLATE-UNKNOWN');
  assert.ok(hit);
  assert.equal(hit.evidence.template_key, 'TPL-99');
});

// ---------------------------------------------------------------------------
// 8. The premium cut (R-09)
// ---------------------------------------------------------------------------

const FEATURE_1A = { id: '1a', piece_type: 'FEATURE', premium_cut: { present: true }, hard_rules: [] };
const NOTE_1B = { id: '1b', piece_type: 'NOTE', premium_cut: { present: false }, hard_rules: [] };

test('fit: refuses a cut with no data block above it (R-09)', () => {
  const r = runFit(input({
    layoutTemplate: FEATURE_1A,
    blocks: [
      block({ seq: 1, code: 'text', payload: { text: 'An opening paragraph.' } }),
      block({ seq: 2, code: 'text', gated: true, payload: { text: 'The gated continuation.' } }),
    ],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-CUT-NO-DATA');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.rule, 'R-09');
});

test('fit: refuses a cut that falls mid-sentence', () => {
  const r = runFit(input({
    layoutTemplate: FEATURE_1A,
    blocks: [
      block({ seq: 1, code: 'text', bound_object_id: OBJ, payload: { text: 'Revenue is the story here' } }),
      block({ seq: 2, code: 'text', gated: true, payload: { text: 'and the rest is gated.' } }),
    ],
    citations: [cite()],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-CUT-MID-SENTENCE');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.seq, 1);
});

test('fit: refuses a cut on a template that declares none (1b is gated at document level)', () => {
  const r = runFit(input({
    content_type: 'NOTE', template_key: 'TPL-04', layoutTemplate: NOTE_1B, is_premium: true,
    pipelineTemplate: { key: 'TPL-04', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null },
    blocks: [
      block({ seq: 1, code: 'text', bound_object_id: OBJ, payload: { text: 'The thesis, stated once.' } }),
      block({ seq: 2, code: 'text', gated: true, payload: { text: 'More.' } }),
    ],
    citations: [cite()],
  }));
  assert.ok(r.refusals.some((x) => x.code === 'FIT-CUT-NOT-PERMITTED'));
});

test('fit: places the cut two thirds through, after a complete thought and a data block', () => {
  const r = runFit(input({
    layoutTemplate: FEATURE_1A,
    blocks: [
      block({ seq: 1, code: 'text', payload: { text: 'One.' } }),
      block({ seq: 2, code: 'text', bound_object_id: OBJ, payload: { text: 'Two.' } }),
      block({ seq: 3, code: 'text', payload: { text: 'Three.' } }),
      block({ seq: 4, code: 'text', payload: { text: 'Four.' } }),
      block({ seq: 5, code: 'text', payload: { text: 'Five.' } }),
      block({ seq: 6, code: 'text', payload: { text: 'Six.' } }),
    ],
    citations: [cite()],
  }));
  assert.equal(r.passed, true, codes(r.refusals).join(','));
  assert.equal(r.cut.required, true);
  assert.equal(r.cut.placement_after_seq, 4);   // cut before block index 4 (seq 5)
});

test('fit: refuses when a cut is required and no legal position exists', () => {
  const r = runFit(input({
    layoutTemplate: FEATURE_1A,
    blocks: [
      block({ seq: 1, code: 'text', payload: { text: 'Only prose.' } }),
      block({ seq: 2, code: 'text', payload: { text: 'Still no evidence.' } }),
    ],
  }));
  assert.ok(r.refusals.some((x) => x.code === 'FIT-CUT-UNPLACEABLE'));
});

// ---------------------------------------------------------------------------
// 9. Payload schemas — Zod is the enforcer, ops.story_blocks.payload_schema is a projection
//
// These were written against the earlier contract, where the DB column drove validation through a
// hand-rolled walker. That walker could not see 486 of the generated constraints, so a block could
// pass a check that never really ran. The column is still emitted — the provider needs JSON Schema
// for constrained generation — but it is no longer what the fit stage trusts.
// ---------------------------------------------------------------------------

test('fit: a block with no Zod schema is unchecked, never a refusal', () => {
  // BLK-TABLE is one of the 8 legacy codes the design split (into BLK-FINTABLE et al). It has no
  // payload contract to state, so the fit stage must report the gap rather than invent a verdict.
  const r = runFit(input({
    blocks: [block({ seq: 1, code: 'BLK-TABLE', payload: { anything: 'goes' } })],
    citations: [cite()],
  }));
  assert.ok(!r.refusals.some((x) => x.code === 'FIT-PAYLOAD-SCHEMA'));
  const u = r.unchecked.find((x) => x.code === 'FIT-PAYLOAD-SCHEMA' && x.block_code === 'BLK-TABLE');
  assert.ok(u, 'expected an unchecked report for the legacy code');
  assert.match(String(u.evidence.reason), /no Zod schema/);
});

test('fit: the Zod schema is enforced regardless of what the DB column says', () => {
  // payload_schema stays null — under the old contract that alone meant "unchecked". The refusal
  // below proves the column is no longer the authority.
  const r = runFit(input({
    blocks: [block({ seq: 1, code: 'BLK-BIGNUM', bound_object_id: OBJ, payload: { caption: 'Net profit, Q2 FY26' } })],
    citations: [cite()],
  }));
  const hit = r.refusals.find((x) => x.code === 'FIT-PAYLOAD-SCHEMA');
  assert.ok(hit, codes(r.refusals).join(','));
  assert.equal(hit.evidence.source, 'ingestion/src/blocks (Zod)');
  const problems = (hit.evidence.problems as string[]).join(' | ');
  assert.match(problems, /context_line/);
  assert.match(problems, /value/);
});

test('fit: Zod catches the three classes the old JSON-Schema walker was blind to', () => {
  const bignum = (payload: Record<string, unknown>) => runFit(input({
    blocks: [block({ seq: 1, code: 'BLK-BIGNUM', bound_object_id: OBJ, payload })],
    citations: [cite()],
  })).refusals.find((x) => x.code === 'FIT-PAYLOAD-SCHEMA');

  const valid = {
    caption: 'Net profit, Q2 FY26',
    context_line: 'Up from the prior quarter.',
    value: { object_id: OBJ, field: 'numeric_value' },
  };
  assert.equal(bignum(valid), undefined, 'a well-formed payload must pass');

  // (a) D-8, as a `pattern` on object_id: a literal number where a binding belongs. This is the
  //     fabrication guard, and the old walker enforced none of it.
  assert.ok(bignum({ ...valid, value: 4.22e9 }), 'a literal in place of a binding must refuse');
  assert.ok(bignum({ ...valid, value: { object_id: 'FILING.PROFIT.2026', field: 'numeric_value' } }),
    'a non-uuid object_id must refuse');

  // (b) additionalProperties:false — the agent inventing a field it was never given.
  assert.ok(bignum({ ...valid, trend_arrow: 'up' }), 'an invented field must refuse');
});

// ---------------------------------------------------------------------------
// 10. The handler: refusal routes to a human; the rules stage hands off when switched on
// ---------------------------------------------------------------------------

test('pipeline_fit: a refusal transitions to reassigned_human with the evidence', async () => {
  const f = makeFakeSql();
  f.on('from ops.pipeline_items pi where pi.id', [{ id: 7, content_id: 'aaaaaaaa-0000-0000-0000-000000000001', stage: 'fit', trigger_object_id: null, priority: 'story', template_hint: null, rules_fail_loops: 0, security_id: 1 }]);
  f.on('iam.principals where handle', [{ id: 'ed-1' }]);
  f.on('from public.content_items ci', [{ content_type: 'ARTICLE', template_key: 'TPL-02', is_premium: false, word_count: 100, premium_cut_after_block: null, agent_authored: true }]);
  f.on('from public.content_blocks where content_id', [{ seq: 1, block_kind: 'BLK-INFOGRAPHIC', body: { text: 'invented' }, bound_object_id: null, gated: false }]);
  f.on('from lake.citations c left join', []);
  f.on('from ops.story_blocks', [{ key: 'BLK-FINTABLE', status: 'active', family: 'C', piece_types: ['NOTE'], requires_binding: true, binds_to: null, constraints: [], payload_schema: null }]);
  f.on('from ops.templates where key', [{ key: 'TPL-02', block_keys: [], auto_publish_eligible: false, always_premium: false, max_words: null }]);
  f.on('from ops.article_templates where piece_type', []);
  f.on("to_regclass('ops.fit_reports')", [{ ok: false }]);

  await makeFitStage()({ handler: 'pipeline_fit', pipeline_item_id: 7 }, makeCtx(f.sql));

  const t = f.queries.find((q) => q.text.includes('ops.fn_transition'));
  assert.ok(t, 'expected a transition');
  assert.equal(t.values[1], 'reassigned_human');
  const detail = JSON.stringify((t.values[3] as { __json: unknown }).__json);
  assert.match(detail, /FIT-BLOCK-UNKNOWN/);
  assert.match(detail, /BLK-INFOGRAPHIC/);
  // It refused before touching content — no repair, no fallback block.
  assert.ok(!f.queries.some((q) => q.text.includes('update public.content_items')));
});

test('pipeline_fit: not at the fit stage ⇒ no-op (redelivery safe)', async () => {
  const f = makeFakeSql();
  f.on('from ops.pipeline_items pi where pi.id', [{ id: 7, content_id: 'x', stage: 'approval', trigger_object_id: null, priority: null, template_hint: null, rules_fail_loops: 0, security_id: null }]);
  await makeFitStage()({ handler: 'pipeline_fit', pipeline_item_id: 7 }, makeCtx(f.sql));
  assert.ok(!f.queries.some((q) => q.text.includes('ops.fn_transition')));
});

test('pipeline_rules: hands off to fit when the switch is on, and not when it is off', async () => {
  const seed = (fitSwitch: boolean) => {
    const f = makeFakeSql();
    f.on('from ops.pipeline_items pi where pi.id', [{ id: 7, content_id: 'aaaaaaaa-0000-0000-0000-000000000001', stage: 'rules', trigger_object_id: null, priority: 'story', template_hint: null, rules_fail_loops: 0, security_id: 1 }]);
    f.on('iam.principals where handle', [{ id: 'ed-1' }]);
    f.on('from ops.rulesets where is_live', [{ version_no: 9 }]);
    f.on('from ops.banned_phrases', []);
    f.on('from public.content_items where id', [{ content_type: 'ARTICLE', template_key: 'TPL-02', headline: 'A plain headline', dek: null, word_count: 12, is_premium: false }]);
    f.on('from public.content_blocks where content_id', [{ seq: 1, block_kind: 'text', body: { text: 'A plain paragraph.' }, bound_object_id: null, gated: false }]);
    f.on('from lake.citations c join lake.objects', []);
    f.on('from public.content_tickers ct', []);
    // switchOn() passes the key as a BIND, so both switch reads have identical query
    // text — the canned rows are consumed in call order: fit switch first, then
    // auto_publish_wires.
    f.on('iam.global_switches', [{ v: fitSwitch }]);
    f.on('iam.global_switches', [{ v: false }]);
    return f;
  };

  const on = seed(true);
  await makeRulesStage()({ handler: 'pipeline_rules', pipeline_item_id: 7 }, makeCtx(on.sql));
  const tOn = on.queries.filter((q) => q.text.includes('ops.fn_transition'));
  assert.equal(tOn.at(-1)?.values[1], 'fit');
  assert.ok(on.queries.some((q) => q.text.includes('pgmq.send')));

  const off = seed(false);
  await makeRulesStage()({ handler: 'pipeline_rules', pipeline_item_id: 7 }, makeCtx(off.sql));
  assert.equal(off.queries.filter((q) => q.text.includes('ops.fn_transition')).at(-1)?.values[1], 'approval');
});

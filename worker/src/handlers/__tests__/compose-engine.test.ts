import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legalVocabulary, outlineSchema, spliceComposition, validateOutline, type StoryBlockRow,
} from '../newsroom/compose-engine.js';

const row = (over: Partial<StoryBlockRow> & { key: string }): StoryBlockRow => ({
  status: 'active', family: 'B', piece_types: ['ALL'], requires_binding: false,
  renderer_built: true, payload_schema: { type: 'object' }, constraints: null, ...over,
});

const REGISTRY: StoryBlockRow[] = [
  row({ key: 'BLK-THESIS' }),
  row({ key: 'BLK-BIGNUM', requires_binding: true, constraints: ['ONE PER PIECE'] }),
  row({ key: 'BLK-LINE', renderer_built: false }),          // designed, not drawable
  row({ key: 'BLK-CHART', status: 'legacy' }),               // retired
  row({ key: 'BLK-COVER', piece_types: ['IPO'] }),           // wrong piece type
];

test('the legal vocabulary is the template list narrowed by the registry', () => {
  const v = legalVocabulary(['BLK-THESIS', 'BLK-BIGNUM'], REGISTRY, 'FEATURE');
  assert.deepEqual(v.codes, ['BLK-THESIS', 'BLK-BIGNUM']);
  assert.deepEqual(v.excluded, []);
});

test('a block with no renderer is excluded, and the reason is reported', () => {
  // Composing it would put a MissingBlock on a published page. Loud is right for a bug; it is
  // not something to schedule on purpose.
  const v = legalVocabulary(['BLK-THESIS', 'BLK-LINE'], REGISTRY, 'FEATURE');
  assert.deepEqual(v.codes, ['BLK-THESIS']);
  assert.equal(v.excluded[0]?.code, 'BLK-LINE');
  assert.match(v.excluded[0]!.reason, /no renderer built/);
});

test('a retired code is excluded even when a template still names it', () => {
  // 7 of 8 templates named legacy codes before the re-cut; this is the belt to that braces.
  const v = legalVocabulary(['BLK-CHART'], REGISTRY, 'FEATURE');
  assert.deepEqual(v.codes, []);
  assert.match(v.excluded[0]!.reason, /status=legacy/);
});

test('piece_types gates the vocabulary, and AI is admitted for an agent-authored piece', () => {
  assert.deepEqual(legalVocabulary(['BLK-COVER'], REGISTRY, 'FEATURE').codes, []);
  assert.deepEqual(legalVocabulary(['BLK-COVER'], REGISTRY, 'IPO').codes, ['BLK-COVER']);
});

test('an unknown code in the outline is rejected before any fill call is paid for', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-WATERFALL', binding_object_id: null, one_line_intent: 'the bridge', after_paragraph: 1 }],
    ['BLK-THESIS'], new Set(), REGISTRY, 3,
  );
  assert.equal(r[0]?.kind, 'illegal_code');
});

test('an invented binding id is rejected — the whole point of binding is not typing', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-BIGNUM', binding_object_id: 'made-up', one_line_intent: 'the number', after_paragraph: 1 }],
    ['BLK-BIGNUM'], new Set(['real-id']), REGISTRY, 3,
  );
  assert.equal(r[0]?.kind, 'unknown_binding');
});

test('a binding-required block with no binding is rejected', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-BIGNUM', binding_object_id: null, one_line_intent: 'the number', after_paragraph: 1 }],
    ['BLK-BIGNUM'], new Set(), REGISTRY, 3,
  );
  assert.equal(r[0]?.kind, 'missing_binding');
});

test('a valid outline produces no rejections', () => {
  const r = validateOutline(
    [
      { block_code: 'BLK-THESIS', binding_object_id: null, one_line_intent: 'the argument', after_paragraph: 1 },
      { block_code: 'BLK-BIGNUM', binding_object_id: 'real-id', one_line_intent: 'the number', after_paragraph: 1 },
    ],
    ['BLK-THESIS', 'BLK-BIGNUM'], new Set(['real-id']), REGISTRY, 3,
  );
  assert.deepEqual(r, []);
});

test('the outline schema offers ONLY this piece\'s legal codes as the enum', () => {
  const s = outlineSchema(['BLK-THESIS', 'BLK-BIGNUM'], 3) as Record<string, never>;
  const enumv = JSON.parse(JSON.stringify(s)).properties.blocks.items.properties.block_code.enum;
  assert.deepEqual(enumv, ['BLK-THESIS', 'BLK-BIGNUM']);
});

test('ONE PER PIECE is enforced at outline time, where it is still free', () => {
  // Item 3 shipped two BLK-BIGNUMs into a fit refusal (FIT-CONSTRAINT-UNIQUE, seqs 2 and 8).
  // The constraint was legible to the checker and invisible to the author; both now read the
  // same column, and this one costs nothing to catch.
  const r = validateOutline(
    [
      { block_code: 'BLK-BIGNUM', binding_object_id: 'real-id', one_line_intent: 'the number', after_paragraph: 1 },
      { block_code: 'BLK-BIGNUM', binding_object_id: 'real-id', one_line_intent: 'again', after_paragraph: 2 },
    ],
    ['BLK-BIGNUM'], new Set(['real-id']), REGISTRY, 3,
  );
  assert.deepEqual(r, [{ kind: 'duplicate_unique', code: 'BLK-BIGNUM', n: 2 }]);
});

test('a repeated block with no such constraint is allowed', () => {
  const r = validateOutline(
    [
      { block_code: 'BLK-THESIS', binding_object_id: null, one_line_intent: 'one', after_paragraph: 1 },
      { block_code: 'BLK-THESIS', binding_object_id: null, one_line_intent: 'two', after_paragraph: 2 },
    ],
    ['BLK-THESIS'], new Set(), REGISTRY, 3,
  );
  assert.deepEqual(r, []);
});

test('an anchor past the end of the prose is rejected', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-THESIS', binding_object_id: null, one_line_intent: 'the argument', after_paragraph: 9 }],
    ['BLK-THESIS'], new Set(), REGISTRY, 3,
  );
  assert.equal(r[0]?.kind, 'anchor_out_of_range');
});

test('the splice keeps every paragraph, in order, with exhibits between them', () => {
  // The fault this exists to prevent: compose deleted all nine of item 3's blocks and wrote
  // back only exhibits. With no running prose, the numeral check had nothing to check and no
  // position satisfied R-09 — hence FIT-CUT-UNPLACEABLE on a piece that had prose all along.
  const out = spliceComposition(
    [
      { kind: 'text', body: { text: 'first' } },
      { kind: 'text', body: { text: 'second' } },
      { kind: 'disclaimer', body: { text: 'not advice' } },
    ],
    [
      { code: 'BLK-BIGNUM', payload: { v: 1 }, boundObjectId: 'o1', afterParagraph: 1 },
      { code: 'BLK-THESIS', payload: { v: 2 }, boundObjectId: null, afterParagraph: 0 },
    ],
  );
  assert.deepEqual(out.map((b) => b.blockKind), [
    'BLK-THESIS', 'text', 'BLK-BIGNUM', 'text', 'disclaimer',
  ]);
  assert.equal(out.filter((b) => b.kind === 'prose').length, 3);
});

test('the disclaimer is pinned last however the model anchored around it', () => {
  // An exhibit below the legal footer reads as being covered by it.
  const out = spliceComposition(
    [{ kind: 'text', body: { text: 'body' } }, { kind: 'disclaimer', body: { text: 'not advice' } }],
    [{ code: 'BLK-BIGNUM', payload: {}, boundObjectId: 'o1', afterParagraph: 1 }],
  );
  assert.equal(out[out.length - 1]!.blockKind, 'disclaimer');
});

test('exhibits sharing an anchor keep the outline order', () => {
  const out = spliceComposition(
    [{ kind: 'text', body: { text: 'body' } }],
    [
      { code: 'BLK-THESIS', payload: {}, boundObjectId: null, afterParagraph: 1 },
      { code: 'BLK-BIGNUM', payload: {}, boundObjectId: 'o1', afterParagraph: 1 },
    ],
  );
  assert.deepEqual(out.map((b) => b.blockKind), ['text', 'BLK-THESIS', 'BLK-BIGNUM']);
});

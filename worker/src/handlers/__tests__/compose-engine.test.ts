import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalVocabulary, outlineSchema, validateOutline, type StoryBlockRow } from '../newsroom/compose-engine.js';

const row = (over: Partial<StoryBlockRow> & { key: string }): StoryBlockRow => ({
  status: 'active', family: 'B', piece_types: ['ALL'], requires_binding: false,
  renderer_built: true, payload_schema: { type: 'object' }, ...over,
});

const REGISTRY: StoryBlockRow[] = [
  row({ key: 'BLK-THESIS' }),
  row({ key: 'BLK-BIGNUM', requires_binding: true }),
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
    [{ block_code: 'BLK-WATERFALL', binding_object_id: null, one_line_intent: 'the bridge' }],
    ['BLK-THESIS'], new Set(), REGISTRY,
  );
  assert.equal(r[0]?.kind, 'illegal_code');
});

test('an invented binding id is rejected — the whole point of binding is not typing', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-BIGNUM', binding_object_id: 'made-up', one_line_intent: 'the number' }],
    ['BLK-BIGNUM'], new Set(['real-id']), REGISTRY,
  );
  assert.equal(r[0]?.kind, 'unknown_binding');
});

test('a binding-required block with no binding is rejected', () => {
  const r = validateOutline(
    [{ block_code: 'BLK-BIGNUM', binding_object_id: null, one_line_intent: 'the number' }],
    ['BLK-BIGNUM'], new Set(), REGISTRY,
  );
  assert.equal(r[0]?.kind, 'missing_binding');
});

test('a valid outline produces no rejections', () => {
  const r = validateOutline(
    [
      { block_code: 'BLK-THESIS', binding_object_id: null, one_line_intent: 'the argument' },
      { block_code: 'BLK-BIGNUM', binding_object_id: 'real-id', one_line_intent: 'the number' },
    ],
    ['BLK-THESIS', 'BLK-BIGNUM'], new Set(['real-id']), REGISTRY,
  );
  assert.deepEqual(r, []);
});

test('the outline schema offers ONLY this piece\'s legal codes as the enum', () => {
  const s = outlineSchema(['BLK-THESIS', 'BLK-BIGNUM']) as Record<string, never>;
  const enumv = JSON.parse(JSON.stringify(s)).properties.blocks.items.properties.block_code.enum;
  assert.deepEqual(enumv, ['BLK-THESIS', 'BLK-BIGNUM']);
});

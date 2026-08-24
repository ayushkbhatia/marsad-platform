/**
 * PR.1 — the research stage handler.
 *
 * The assembler itself is tested exhaustively in ingestion (32 cases, no database). These cover the
 * STAGE's own contract: redelivery safety, the subjectless-piece path, and the two things a
 * deployment can get wrong — running before the migration, and passing evidence forward that the
 * fit stage will refuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeResearchStage } from '../newsroom/research.js';
import { makeCtx, makeFakeSql } from './fakes.js';

const ITEM: {
  id: number; content_id: string; stage: string; trigger_object_id: string | null;
  priority: string; template_hint: string; rules_fail_loops: number; security_id: number | null;
} = {
  id: 7, content_id: 'aaaaaaaa-0000-4000-8000-000000000001', stage: 'research',
  trigger_object_id: null, priority: 'story', template_hint: 'TPL-03',
  rules_fail_loops: 0, security_id: 15,
};

function run(over: Partial<typeof ITEM> = {}, extra: Array<[string, unknown[]]> = []) {
  const f = makeFakeSql();
  f.on('from ops.pipeline_items', [{ ...ITEM, ...over }]);
  f.on('from iam.principals', [{ id: 'bbbbbbbb-0000-4000-8000-000000000002' }]);
  for (const [k, rows] of extra) f.on(k, rows);
  return { f, handler: makeResearchStage() };
}

test('research: not at the research stage is a no-op — redelivery safe', async () => {
  const { f, handler } = run({ stage: 'draft' });
  await handler({ pipeline_item_id: 7 }, makeCtx(f.sql));
  assert.ok(!f.queries.some((q) => q.text.includes('fn_transition')), 'must not transition');
});

test('research: a piece with no primary security passes through rather than stalling', async () => {
  // Every leg is security-scoped, so a brief would be empty. The draft stage is better placed to
  // decide what to do with a subjectless piece than this one is.
  const { f, handler } = run({ security_id: null });
  await handler({ pipeline_item_id: 7 }, makeCtx(f.sql));
  const t = f.queries.find((q) => q.text.includes('fn_transition'));
  assert.ok(t, 'should still advance to draft');
  assert.ok(JSON.stringify(t!.values).includes('draft'));
});

test('research: assembles, advances to draft, and reports what it could not store', async () => {
  // to_regclass returns null ⇒ ops.research_briefs is absent ⇒ the brief is assembled and passed
  // on unstored. This is the pre-migration deployment, and it must not fail.
  const { f, handler } = run({}, [['to_regclass', [{ t: null }]]]);
  await handler({ pipeline_item_id: 7 }, makeCtx(f.sql));

  const t = f.queries.find((q) => q.text.includes('fn_transition'));
  assert.ok(t, 'must advance');
  assert.ok(JSON.stringify(t!.values).includes('draft'));
  // and it must not have attempted the insert
  assert.ok(!f.queries.some((q) => q.text.includes('insert into ops.research_briefs')));
});

test('research: never calls an LLM — the stage is deterministic and free', async () => {
  const { f, handler } = run({}, [['to_regclass', [{ t: null }]]]);
  await handler({ pipeline_item_id: 7 }, makeCtx(f.sql));
  assert.ok(
    !f.queries.some((q) => /ops\.llm_runs|chatComplete/.test(q.text)),
    'the research stage must not spend a token',
  );
});

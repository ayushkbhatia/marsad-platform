import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRevisionBrief, revisionSignature } from '../newsroom/revision.js';

/** The violations that actually killed pipeline item 3 on 2026-08-16. */
const REAL_BLOCKED = [
  {
    rule_key: 'R-03', outcome: 'blocked',
    detail: { violations: [{ key: 'c14', kind: 'cited_object_in_conflict', where: 'block:4', object_type: 'FILING.FINANCIALS' }] },
  },
  {
    rule_key: 'R-04', outcome: 'blocked',
    detail: { violations: [
      { keys: ['c15', 'c16', 'c17'], kind: 'number_unaccounted', token: '31 M', value: 31000000, where: 'block:4' },
      { keys: ['c15', 'c16', 'c17'], kind: 'number_unaccounted', token: '31 M', value: 31000000, where: 'block:4' },
    ] },
  },
];

test('the brief names the surface, so the writer is pointed at a sentence not a piece', () => {
  const b = renderRevisionBrief(REAL_BLOCKED, ['R-01', 'R-02'], 1, 2);
  assert.match(b, /block:4/);
  assert.match(b, /c14/);
  assert.match(b, /31 M/);
});

test('the brief names a remedy for each defect, not just a verdict', () => {
  const b = renderRevisionBrief(REAL_BLOCKED, [], 1, 2);
  // "R-03 blocked" is a verdict; the writer needs an instruction.
  assert.match(b, /two sources disagree about this figure/);
  assert.match(b, /not covered by any citation in its sentence/);
});

test('the brief pins what passed — without this the model rewrites clean prose', () => {
  const b = renderRevisionBrief(REAL_BLOCKED, ['R-02', 'R-05', 'R-10'], 1, 2);
  assert.match(b, /RULES THAT PASSED AND MUST NOT CHANGE: R-02, R-05, R-10/);
});

test('a repeated violation is stated once, not five times', () => {
  const b = renderRevisionBrief(REAL_BLOCKED, [], 1, 2);
  const occurrences = b.split('\n').filter((l) => l.includes('number_unaccounted')).length;
  assert.equal(occurrences, 1, 'identical defects on the same surface collapse to one instruction');
});

test('a desk note outranks the machine brief and says so', () => {
  const b = renderRevisionBrief(REAL_BLOCKED, [], 2, 2, 'Drop the Emirates NBD comparison entirely.');
  assert.match(b, /DESK NOTE/);
  assert.match(b, /authoritative/);
  assert.ok(b.indexOf('DESK NOTE') < b.indexOf('REVISION 2'), 'the human instruction comes first');
});

test('the revision number and cap are stated, so the writer knows the stakes', () => {
  assert.match(renderRevisionBrief(REAL_BLOCKED, [], 2, 2), /REVISION 2 of 2/);
});

test('the signature is stable for identical failures and moves when they change', () => {
  const a = revisionSignature(REAL_BLOCKED);
  assert.equal(a, revisionSignature(structuredClone(REAL_BLOCKED)));
  const fewer = [REAL_BLOCKED[0]!];
  assert.notEqual(a, revisionSignature(fewer), 'dropping a blocked rule must change the signature');
});

test('the signature distinguishes same rules with a different violation count', () => {
  const more = structuredClone(REAL_BLOCKED);
  (more[0]!.detail as { violations: unknown[] }).violations.push({ kind: 'marker_unresolved', key: 'c9', where: 'dek' });
  assert.notEqual(revisionSignature(REAL_BLOCKED), revisionSignature(more));
});

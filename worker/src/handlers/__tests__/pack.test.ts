import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, renderCitableFacts } from '../newsroom/pack.js';

/** A pack shaped like lake.fn_writer_context's real output, including the jsonb key order
 *  that made the old `.slice(0, 12000)` cut `statements` off on every single call. */
function pack(statementCount = 3, filingCount = 2) {
  return {
    price: { last: 26.56, change_pct: -0.15, return_3m: 0.041, return_12m: 0.118 },
    score: { source_object_id: '00000000-0000-4000-a000-0000000000s1', total: 61, sector_percentile: 48 },
    ratios: { source_object_id: '00000000-0000-4000-a000-0000000000r1', pe: 11.4, roe: 0.171 },
    filings: Array.from({ length: filingCount }, (_, i) => ({
      filing_id: 16862 - i, title: `Detailed report ${2026 - i}`, filing_type: 'RESULTS',
      source_object_id: `00000000-0000-4000-a000-00000000f${String(i).padStart(3, '0')}`,
      ai_summary: 'x'.repeat(400),
    })),
    identity: { ticker: 'QNBK', name: 'Qatar National Bank', venue: 'QE', sector: 'banks' },
    freshness: { pack_generated_at: '2026-08-16T00:00:00Z' },
    statements: Array.from({ length: statementCount }, (_, i) => ({
      statement_type: 'income', fiscal_period: `Q${(i % 4) + 1} ${2026 - Math.floor(i / 4)}`,
      period_end: '2026-06-30',
      source_object_id: `00000000-0000-4000-a000-00000000s${String(i).padStart(3, '0')}`,
      line_items: { revenue: 21_660_000_000, net_income: 4_430_000_000, filler: 'y'.repeat(600) },
    })),
    generated_for: 'writer_context/v1',
  };
}

test('the pack is always parseable JSON, even when it must be trimmed', () => {
  // The old code cut mid-token, so the writer received syntactically invalid JSON on EVERY
  // call (all 15 measured securities exceeded the 12,000-char budget).
  const built = buildPack(pack(40, 8), { maxChars: 4_000 });
  assert.doesNotThrow(() => JSON.parse(built.text));
  assert.ok(built.text.length <= 4_000, `pack is ${built.text.length} chars`);
});

test('statements survive a tight budget — they are the only citable section', () => {
  // jsonb orders keys by (length, bytes), putting `statements` LAST, so the old slice
  // discarded exactly the section carrying source_object_id on every fact.
  const built = buildPack(pack(40, 8), { maxChars: 4_000 });
  const parsed = JSON.parse(built.text) as Record<string, unknown>;
  assert.ok(Array.isArray(parsed.statements) && (parsed.statements as unknown[]).length > 0,
    'statements must never be the section that disappears');
  assert.ok(built.facts.some((f) => f.section === 'statements'));
});

test('a trim is reported, never silent', () => {
  const built = buildPack(pack(40, 8), { maxChars: 4_000 });
  assert.ok(built.dropped.length > 0);
  assert.ok(built.dropped.every((d) => d.n > 0));
});

test('an untrimmed pack reports nothing dropped and keeps every element', () => {
  const built = buildPack(pack(3, 2), { maxChars: 25_000 });
  assert.deepEqual(built.dropped, []);
  const parsed = JSON.parse(built.text) as { statements: unknown[]; filings: unknown[] };
  assert.equal(parsed.statements.length, 3);
  assert.equal(parsed.filings.length, 2);
});

test('the allow-set includes ratios, score and filings — not just statements', () => {
  // The old idsInPack collected only STRING values under four key names, so price, identity
  // and filings carried no citable id and a draft quoting a share price was reassigned as
  // though it had invented the number.
  const built = buildPack(pack(2, 2));
  const sections = new Set(built.facts.map((f) => f.section));
  assert.ok(sections.has('statements'));
  assert.ok(sections.has('filings'));
  assert.ok(sections.has('ratios'));
  assert.ok(sections.has('score'));
});

test('facts are de-duplicated by (object, field), not by object alone', () => {
  // The de-dupe key widened when facts became per-field. Keying on objectId alone would now
  // collapse a balance sheet's thirty line items into whichever one came first — the same
  // blindness that left R-04 with no field to check.
  const p = pack(2, 1) as Record<string, unknown>;
  // same object surfacing twice, as it legitimately can
  const filings = p.filings as Record<string, unknown>[];
  const statements = p.statements as Record<string, unknown>[];
  filings[0]!.source_object_id = statements[0]!.source_object_id;
  const built = buildPack(p);
  const keys = built.facts.map((f) => `${f.objectId}::${f.path ?? ''}`);
  assert.equal(new Set(keys).size, keys.length, 'no (object, field) pair appears twice');
});

test('an unrecognised section is kept, not silently discarded', () => {
  const built = buildPack({ ...pack(1, 1), peers: [{ ticker: 'QIBK', pe: 9.9 }] });
  const parsed = JSON.parse(built.text) as Record<string, unknown>;
  assert.ok('peers' in parsed, 'a new fn_writer_context section must survive');
});

test('renderCitableFacts lists ids the writer can copy rather than infer', () => {
  const built = buildPack(pack(2, 1));
  const idx = renderCitableFacts(built.facts);
  assert.match(idx, /CITABLE FACTS/);
  for (const f of built.facts) assert.ok(idx.includes(f.objectId));
});

test('an empty pack yields no citable facts and says so', () => {
  const built = buildPack(null);
  assert.equal(built.text, '{}');
  assert.equal(built.facts.length, 0);
  assert.match(renderCitableFacts(built.facts), /do not cite any number/);
});

test('a statement object yields one fact per line item, each with its path', () => {
  // The old collector emitted ONE fact per object, labelled "balance Q1 2026" — telling the
  // writer an object existed but not which of its thirty line items it was about. It then cited
  // the object and wrote whichever number it liked, and R-04 had no field to check against.
  const built = buildPack({
    statements: [{
      source_object_id: 'c1b608a0-a866-49dd-bff4-6cd0918bc962',
      statement_type: 'balance', fiscal_period: 'Q1 2026', period_end: '2026-03-31',
      row_id: 427, version: 1, currency: 'SAR',
      line_items: { total_assets: 537083416000, equity: 79164920000 },
    }],
  });
  const paths = built.facts.map((f) => f.path);
  assert.ok(paths.includes('line_items.total_assets'));
  assert.ok(paths.includes('line_items.equity'));
  // Bookkeeping is not a citable figure.
  assert.ok(!paths.includes('row_id'));
  assert.ok(!paths.includes('version'));
  // The object itself is still offered, for blocks that reference it rather than a number.
  assert.ok(paths.includes(null));
});

test('a null ratio is not offered as a fact', () => {
  // Offering it invites the writer to cite an empty field.
  const built = buildPack({ ratios: { source_object_id: '776e8337-4ff2-43a1-86f9-4752b5f50e11', pe: 6.494, nim: null } });
  const paths = built.facts.map((f) => f.path);
  assert.ok(paths.includes('pe'));
  assert.ok(!paths.includes('nim'));
});

test('the same object contributes its net_income AND its total_assets', () => {
  // The de-dupe used to key on objectId alone, which would now collapse every field of an
  // object into whichever one happened to come first.
  const built = buildPack({
    statements: [{
      source_object_id: 'c1b608a0-a866-49dd-bff4-6cd0918bc962',
      line_items: { net_income: 12_700_000_000, total_assets: 1_440_000_000_000 },
    }],
  });
  const paths = built.facts.filter((f) => f.path).map((f) => f.path);
  assert.deepEqual(paths.sort(), ['line_items.net_income', 'line_items.total_assets']);
});

test('one section cannot starve another', () => {
  // statements sits ahead of ratios in the editorial order; twelve periods of thirty line items
  // would otherwise push every citable ratio past the head-of-list cut.
  const statements = Array.from({ length: 12 }, (_, i) => ({
    source_object_id: `0000000${i}-0000-4000-a000-00000000000${i}`,
    fiscal_period: `Q${i}`,
    line_items: Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`item_${j}`, j + 1])),
  }));
  const built = buildPack({ statements, ratios: { source_object_id: '776e8337-4ff2-43a1-86f9-4752b5f50e11', pe: 6.494 } });
  assert.ok(built.facts.some((f) => f.section === 'ratios' && f.path === 'pe'),
    'the ratio survived the statements flood');
});

test('the rendered index prints the path beside the fact', () => {
  const line = renderCitableFacts([
    { objectId: 'obj-1', section: 'statements', label: 'balance Q1 2026', value: '537083416000', path: 'line_items.total_assets' },
  ]);
  assert.match(line, /path=line_items\.total_assets/);
});

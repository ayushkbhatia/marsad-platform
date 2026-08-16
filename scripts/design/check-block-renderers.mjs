#!/usr/bin/env node
/**
 * check-block-renderers — assert the renderer registry and the block vocabulary agree.
 *
 * ── THE TRAP THIS CLOSES ──────────────────────────────────────────────────────
 * ops.story_blocks.renderer_component is populated on all 69 rows — including BlockChart,
 * BlockThesis, BlockLine and BlockWaterfall, components that did not exist when the column was
 * seeded. The column reads as a capability ("this block can be drawn") and is really just a
 * name, so any consumer that trusts it concludes all 61 blocks are renderable. The real
 * resolution table is src/components/blocks/registry.tsx, and an unregistered code falls to
 * MissingBlock.
 *
 * This runs OFFLINE — no database — so it can gate every PR. It checks three things:
 *   1. every implemented code exists in the Zod vocabulary (catches a typo'd registry key);
 *   2. the implemented set matches the manifest below exactly, so adding or removing a
 *      renderer is a deliberate edit rather than a silent drift;
 *   3. every code is either implemented or explicitly listed as unbuilt — a new block cannot
 *      be added to the vocabulary and then forgotten.
 *
 *   node scripts/design/check-block-renderers.mjs          # verify (CI)
 *   node scripts/design/check-block-renderers.mjs --write  # refresh the manifest after building one
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registryPath = join(repoRoot, 'src', 'components', 'blocks', 'registry.tsx');
const codesPath = join(repoRoot, 'ingestion', 'src', 'blocks', 'codes.ts');
const manifestPath = join(repoRoot, 'src', 'components', 'blocks', 'renderer-manifest.json');

/** Every BLK-* code the registry maps to a component. */
function implementedCodes() {
  const src = readFileSync(registryPath, 'utf8');
  const body = src.slice(src.indexOf('BLOCK_RENDERERS'), src.indexOf('IMPLEMENTED_BLOCK_CODES'));
  return [...body.matchAll(/"(BLK-[A-Z]+)"\s*:/g)].map((m) => m[1]).sort();
}

/** The closed vocabulary, from the Zod side — the authority on what a block code IS. */
function vocabularyCodes() {
  const src = readFileSync(codesPath, 'utf8');
  return [...new Set([...src.matchAll(/"(BLK-[A-Z]+)"/g)].map((m) => m[1]))].sort();
}

const implemented = implementedCodes();
const vocabulary = vocabularyCodes();

if (vocabulary.length === 0) {
  console.error('check-block-renderers: found no codes in ingestion/src/blocks/codes.ts');
  process.exit(1);
}

const unknown = implemented.filter((c) => !vocabulary.includes(c));
if (unknown.length > 0) {
  console.error(`✗ registry maps codes that are not in the vocabulary: ${unknown.join(', ')}`);
  process.exit(1);
}

const unbuilt = vocabulary.filter((c) => !implemented.includes(c));
const manifest = { implemented, unbuilt };

if (process.argv.includes('--write')) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ wrote manifest — ${implemented.length} implemented, ${unbuilt.length} unbuilt`);
  process.exit(0);
}

let previous;
try {
  previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  console.error('✗ src/components/blocks/renderer-manifest.json is missing — run with --write');
  process.exit(1);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
if (!same(previous.implemented, implemented) || !same(previous.unbuilt, unbuilt)) {
  const added = implemented.filter((c) => !previous.implemented.includes(c));
  const removed = previous.implemented.filter((c) => !implemented.includes(c));
  console.error('✗ renderer coverage changed without updating the manifest.');
  if (added.length) console.error(`  built:   ${added.join(', ')}`);
  if (removed.length) console.error(`  removed: ${removed.join(', ')}`);
  console.error('  run: node scripts/design/check-block-renderers.mjs --write');
  process.exit(1);
}

console.log(`✓ block renderers in sync — ${implemented.length} of ${vocabulary.length} built, ${unbuilt.length} declared unbuilt`);

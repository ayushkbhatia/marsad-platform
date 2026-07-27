#!/usr/bin/env node
/**
 * PD.3 — project the Zod payload schemas into `ops.story_blocks.payload_schema`.
 *
 * `ingestion/src/blocks/` is the single source of truth; the DB column is a projection of it, the
 * same way `docs/design/*.json` is the source for the PD.2 registry seed. Regenerate and diff to
 * detect drift; never hand-edit a generated migration.
 *
 *   node scripts/design/generate-block-schemas.mjs            # write the migration
 *   node scripts/design/generate-block-schemas.mjs --check    # exit 1 if the committed file differs
 *
 * ONE file, unlike PD.2's three: this is a single `update … from jsonb_to_recordset(...)` over one
 * column, with no natural seam to split on — the payload is one artefact and a reviewer reads it as
 * one diff.
 *
 * Emitted with Zod 4's **native** `z.toJSONSchema()`. Not `zod-to-json-schema`, which was declared
 * unmaintained in Nov 2025 — see `docs/architecture/09-signal-to-article.md` §5.5.
 *
 * `io: "input"` is deliberate: the stored schema describes what a **writer agent may emit**, so
 * defaulted fields (the pinned house kickers and column headers) are optional rather than required.
 * The same document is what goes to the provider for constrained generation.
 *
 * `unrepresentable` is left at its default of "throw": if a schema ever grows a construct JSON
 * Schema cannot carry, this script fails loudly rather than silently shipping a weaker contract to
 * the model than the one TypeScript enforces.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { z } from 'zod';

// Registers an extensionless-`.ts` resolve hook, so the schemas can be imported without a build
// step. MUST come before the dynamic import below, and the import below must stay dynamic — a
// static one would be resolved during linking, before the hook exists.
import '../../ingestion/src/blocks/ts-resolve.mjs';

// Node warns once that a `.ts` file under a package.json without `"type": "module"` had to be
// reparsed as ESM. True, harmless, and it would be the only thing this script ever printed in CI.
process.removeAllListeners('warning');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'supabase/migrations/20260727161500_design_block_payload_schemas.sql');
const CHECK = process.argv.includes('--check');

const {
  BLOCK_CODES,
  BLOCK_PAYLOAD_SCHEMAS,
  BLOCK_BINDING_EXCEPTIONS,
  BLOCK_BINDING_STRICTER_THAN_REGISTRY,
  carriesObjectBinding,
} = await import(join(ROOT, 'ingestion/src/blocks/index') + '.ts');

const registry = JSON.parse(readFileSync(join(ROOT, 'docs/design/block-registry.json'), 'utf8'));

/**
 * The generator is also the drift check between the TypeScript vocabulary and the design JSON that
 * seeded the registry. If these two ever disagree, one of them is wrong and shipping either is
 * worse than failing here.
 */
const designCodes = registry.blocks.map((b) => b.code).sort();
const schemaCodes = [...BLOCK_CODES].sort();
const missing = designCodes.filter((c) => !schemaCodes.includes(c));
const extra = schemaCodes.filter((c) => !designCodes.includes(c));
if (missing.length || extra.length) {
  console.error(`✗ block vocabulary drift vs docs/design/block-registry.json`);
  if (missing.length) console.error(`  missing a schema: ${missing.join(', ')}`);
  if (extra.length) console.error(`  not in the design: ${extra.join(', ')}`);
  process.exit(1);
}

/**
 * `requires_binding` as the PD.2 seed computes it — restated here rather than read from the live DB
 * so the generator stays offline and deterministic. Kept identical to
 * `scripts/design/generate-registry-seed.mjs`.
 */
const requiresBinding = (b) => Boolean(b.binds_to) || b.family === 'C' || b.family === 'D';

const SCHEMA_VERSION = 1;

const rows = [];
for (const code of BLOCK_CODES) {
  const jsonSchema = z.toJSONSchema(BLOCK_PAYLOAD_SCHEMAS[code], { io: 'input' });
  if (!String(jsonSchema.title ?? '').startsWith(`${code} · `)) {
    console.error(`✗ ${code}: emitted schema is not named after its block (title: ${jsonSchema.title})`);
    process.exit(1);
  }
  rows.push({ key: code, payload_schema: jsonSchema, schema_version: SCHEMA_VERSION });
}

/**
 * Which blocks carry a resolvable `lake.objects` binding, and which deliberately do not. The SQL
 * asserts the same split with the same predicate, so the migration cannot land against a registry
 * whose `requires_binding` has drifted away from the schemas.
 */
const bound = new Set(rows.filter((r) => carriesObjectBinding(r.payload_schema)).map((r) => r.key));

const expectedUnbound = [];
for (const b of registry.blocks) {
  if (requiresBinding(b) && !bound.has(b.code)) {
    if (!Object.hasOwn(BLOCK_BINDING_EXCEPTIONS, b.code)) {
      console.error(`✗ ${b.code}: requires_binding, but its schema carries no object binding and it is not a declared exception`);
      process.exit(1);
    }
    expectedUnbound.push(b.code);
  }
  if (!requiresBinding(b) && bound.has(b.code) && !Object.hasOwn(BLOCK_BINDING_STRICTER_THAN_REGISTRY, b.code)) {
    console.error(`✗ ${b.code}: schema binds but the registry says requires_binding=false, and it is not a declared exception`);
    process.exit(1);
  }
}
const declaredExceptions = Object.keys(BLOCK_BINDING_EXCEPTIONS).sort();
if (expectedUnbound.sort().join(',') !== declaredExceptions.join(',')) {
  console.error(`✗ BLOCK_BINDING_EXCEPTIONS is stale: declared [${declaredExceptions}], actual [${expectedUnbound}]`);
  process.exit(1);
}

const stricter = Object.keys(BLOCK_BINDING_STRICTER_THAN_REGISTRY).sort();

const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => (v == null ? 'null' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`);

const boundKeys = [...bound].sort();

const SQL = [
  '-- PD.3 — GENERATED by scripts/design/generate-block-schemas.mjs. DO NOT HAND-EDIT.',
  `-- The JSON Schema each of the ${rows.length} active blocks validates its payload against.`,
  '-- Source of truth: ingestion/src/blocks/*.ts (Zod v4). This column is the PROJECTION —',
  '-- emitted with Zod 4 native z.toJSONSchema({ io: "input" }), which is also what goes to the',
  '-- provider for constrained generation, so the model, the DB and TypeScript cannot disagree.',
  '-- Regenerate and diff to detect drift:  node scripts/design/generate-block-schemas.mjs --check',
  '',
  '-- D-8: a writer agent emits a BINDING, never a number. In the emitted schemas that shows up as a',
  `-- nested object whose properties include object_id — present on ${boundKeys.length} of the ${rows.length} blocks. The`,
  '-- primitives are INLINED rather than hoisted into $defs, so a consumer that does not resolve $ref',
  '-- (today: worker/src/handlers/newsroom/fit-engine.ts) still checks them instead of skipping them.',
  '-- The blocks that are requires_binding WITHOUT one bind something that is not a lake object:',
  ...expectedUnbound.map((c) => `--   ${c.padEnd(14)} ${BLOCK_BINDING_EXCEPTIONS[c]}`),
  '-- The blocks that carry one DESPITE requires_binding=false are charts the seed heuristic missed:',
  ...stricter.map((c) => `--   ${c.padEnd(14)} ${BLOCK_BINDING_STRICTER_THAN_REGISTRY[c]}`),
  '',
  'update ops.story_blocks b',
  '   set payload_schema = s.payload_schema,',
  '       schema_version = s.schema_version',
  `  from jsonb_to_recordset(${j(rows)})`,
  '         as s(key text, payload_schema jsonb, schema_version int)',
  " where b.key = s.key and b.status = 'active';",
  '',
  'do $$',
  'declare',
  '  v_active int; v_filled int; v_legacy int; v_named int; v_bound int; v_missing text;',
  `  c_bound text[] := array[${boundKeys.map(q).join(', ')}];`,
  'begin',
  "  select count(*) into v_active from ops.story_blocks where status = 'active';",
  `  if v_active <> ${rows.length} then raise exception 'expected ${rows.length} active blocks, got %', v_active; end if;`,
  '',
  '  -- (1) every active block has a payload schema; PD.3 is not partially applied',
  "  select count(*) into v_filled from ops.story_blocks where status = 'active' and payload_schema is not null;",
  `  if v_filled <> ${rows.length} then`,
  "    select string_agg(key, ', ' order by key) into v_missing",
  "      from ops.story_blocks where status = 'active' and payload_schema is null;",
  "    raise exception 'blocks without a payload_schema: %', v_missing;",
  '  end if;',
  '',
  '  -- (2) the legacy vocabulary stays schema-less on purpose — the design SPLITS those keys',
  "  --     (BLK-CHART became 15 shapes), so there is no payload contract to state for them",
  "  select count(*) into v_legacy from ops.story_blocks where status = 'legacy' and payload_schema is not null;",
  "  if v_legacy <> 0 then raise exception '% legacy blocks were given a payload_schema', v_legacy; end if;",
  '',
  '  -- (3) each schema is named after its own block, so a validation error names the block',
  '  select count(*) into v_named from ops.story_blocks',
  '   where status = \'active\' and payload_schema->>\'title\' like key || \' · %\';',
  `  if v_named <> ${rows.length} then raise exception 'only % of ${rows.length} schemas are named after their block', v_named; end if;`,
  '',
  '  -- (4) D-8, asserted: every block whose schema carries an object binding is exactly the set the',
  '  --     generator computed, so the registry and the schemas cannot drift apart silently.',
  '  --     Same predicate as carriesObjectBinding() in ingestion/src/blocks/index.ts: an object',
  '  --     type whose properties include object_id, at any depth.',
  '  select count(*) into v_bound from ops.story_blocks',
  "   where status = 'active' and key = any(c_bound)",
  '     and jsonb_path_exists(payload_schema, \'$.**.properties.object_id\');',
  '  if v_bound <> array_length(c_bound, 1) then',
  "    raise exception 'expected % bound blocks, matched %', array_length(c_bound, 1), v_bound;",
  '  end if;',
  '',
  `  raise notice 'story_blocks.payload_schema: % schemas, % of them bound', v_filled, v_bound;`,
  'end $$;',
];

const sql = SQL.join('\n') + '\n';

if (CHECK) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== sql) {
    console.error('✗ payload_schema migration STALE vs ingestion/src/blocks — regenerate and review the diff');
    process.exit(1);
  }
  console.log(`✓ block payload schemas in sync (${rows.length} blocks, ${bound.size} bound)`);
} else {
  writeFileSync(OUT, sql);
  console.log(`✓ ${rows.length} schemas  ${String(sql.length).padStart(7)} bytes  ${OUT.split('/').pop()}`);
  console.log(`  bound: ${bound.size}   unbound-by-design: ${expectedUnbound.length}   stricter-than-registry: ${stricter.length}`);
}

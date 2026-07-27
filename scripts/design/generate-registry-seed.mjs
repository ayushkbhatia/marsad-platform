#!/usr/bin/env node
/**
 * PD.2 — generate the design-registry seed migrations from `docs/design/*.json`.
 *
 * The JSON is the single source of truth (it is the reviewed extraction of the design handoff HTML
 * in `docs/design/artifacts/`). This emits the SQL that puts it in Postgres, where the composing and
 * fitting agents on the VPS can actually reach it — they run against the DB, not against this repo.
 * Regenerate and diff to detect drift; never hand-edit a generated migration.
 *
 *   node scripts/design/generate-registry-seed.mjs            # write the migrations
 *   node scripts/design/generate-registry-seed.mjs --check    # exit 1 if any committed file differs
 *
 * THREE files, not one, and deliberately so: the payload is ~89 KB of genuine design data, past the
 * point where a single migration is reviewable. Splitting on the natural seams — blocks / templates /
 * chassis+tokens — also makes each independently re-runnable, which matters because a design handoff
 * is replaced wholesale rather than edited.
 *
 * Each emits DATA + one statement (`jsonb_to_recordset`), not N near-identical INSERTs: the payload
 * IS the design, so it should read as data and a reviewer should be diffing values, not SQL.
 *
 * Grandfathering: the 8 seed-only keys that predate the design vocabulary (BLK-QUOTE, BLK-TABLE,
 * BLK-CHART, BLK-SCORE, BLK-YIELD, BLK-COVERAGE, BLK-HOLDERS, BLK-FILING) are marked status='legacy'
 * and otherwise untouched. They carry `lake_object_type` bindings that `ops.templates.block_keys`
 * references, and the design deliberately SPLITS the coarse ones (BLK-CHART → 15 shapes, one per
 * question), so re-pointing the templates is an editorial decision, not a rename.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTS = {
  blocks: join(ROOT, 'supabase/migrations/20260727144500_design_registry_seed_blocks.sql'),
  templates: join(ROOT, 'supabase/migrations/20260727144600_design_registry_seed_templates.sql'),
  system: join(ROOT, 'supabase/migrations/20260727144700_design_registry_seed_system.sql'),
};
const CHECK = process.argv.includes('--check');

const blocks = JSON.parse(readFileSync(join(ROOT, 'docs/design/block-registry.json'), 'utf8'));
const templates = JSON.parse(readFileSync(join(ROOT, 'docs/design/article-templates.json'), 'utf8'));

const LEGACY_ONLY = ['BLK-QUOTE', 'BLK-TABLE', 'BLK-CHART', 'BLK-SCORE', 'BLK-YIELD', 'BLK-COVERAGE', 'BLK-HOLDERS', 'BLK-FILING'];

/**
 * `renderer_component` is NOT NULL. The existing rows are hand-humanised (BLK-EXDATE → BlockExDate),
 * so match that convention rather than emitting BlockExdate and creating two styles in one table.
 */
const WORD_SPLITS = {
  EXDATE: 'ExDate', FINTABLE: 'FinTable', PULLQUOTE: 'PullQuote', BIGNUM: 'BigNum',
  STATSTRIP: 'StatStrip', KEYSTATS: 'KeyStats', RANKROW: 'RankRow', BEATMISS: 'BeatMiss',
  TAPEROW: 'TapeRow', CHIPROW: 'ChipRow', VENUEHEAD: 'VenueHead', ALERTCTA: 'AlertCta',
};
const rendererFor = (code) => {
  const s = code.replace(/^BLK-/, '');
  return 'Block' + (WORD_SPLITS[s] ?? s.charAt(0) + s.slice(1).toLowerCase());
};

/**
 * requires_binding — the block may not publish without a resolvable object binding. True when the
 * card names a lake binding, and for every Tabular/Chart block (they ARE data, and design hard-rule
 * #2 says every number carries a provenance stamp). Statement/Mechanism/Gate blocks are
 * desk-authored prose and legitimately unbound.
 */
const requiresBinding = (b) => Boolean(b.binds_to) || b.family === 'C' || b.family === 'D';

/**
 * Normalise the design card's piece-type slot into queryable tokens. The slot is prose, and most of
 * what appears in it is NOT a piece type — RAIL, GATED, THE TAPE, ANY LIVE FIGURE, TRACKED SERIES,
 * RISK FRAMING are *contexts*. Only these seven are real piece types, and only they may narrow a
 * block's permission.
 */
const PIECE_TYPES = new Set(['FEATURE', 'NOTE', 'DEEP DIVE', 'EXPLAINER', 'WIRE', 'IPO', 'AI']);
const ALIASES = { NOTES: 'NOTE', 'NOTES ONLY': 'NOTE', EXPLAINERS: 'EXPLAINER', 'DEEP DIVES': 'DEEP DIVE' };

/**
 * The conservative rule, and the reason for it: **never invent a restriction from a token we did not
 * recognise.** A block whose slot says "RAIL" or "ANY LIVE FIGURE" has told us where it sits, not
 * which piece types exclude it — so it resolves to {ALL}. Guessing narrowly would make the fit stage
 * refuse legitimate blocks, a far worse failure than permitting broadly: a wrong refusal blocks
 * publication silently, a wrong permission is caught by the binding and payload checks downstream.
 *
 * Family D is always {ALL}: its slot carries the chart QUESTION, not a piece type, and exhibits are
 * permitted across the longform types by the chassis rule ("exhibits break the measure deliberately").
 */
function pieceTypesFor(b) {
  if (b.family === 'D') return ['ALL'];
  const toks = String(b.allowed_piece_types ?? '').split('·')
    .map((s) => s.trim().toUpperCase().replace(/^"|"$/g, '')).filter(Boolean);
  if (toks.some((t) => t === 'ALL' || t === 'ALL TYPES' || t === 'EVERY EXHIBIT')) return ['ALL'];
  const named = [...new Set(toks.map((t) => ALIASES[t] ?? t).filter((t) => PIECE_TYPES.has(t)))];
  return named.length ? named.sort() : ['ALL'];
}

/** Family D only — the question the shape answers, which IS the chart-selection contract. */
const chartQuestionFor = (b) =>
  b.family === 'D' && /\?/.test(String(b.allowed_piece_types ?? ''))
    ? String(b.allowed_piece_types).replace(/^"|"$/g, '') : null;

const TEMPLATE_PIECE_TYPE = { '1a': 'FEATURE', '1b': 'NOTE', '3a': 'DEEP DIVE', '3b': 'EXPLAINER' };

const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => (v == null ? 'null' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`);

const banner = (what, srcs) => [
  '-- PD.2 — GENERATED by scripts/design/generate-registry-seed.mjs. DO NOT HAND-EDIT.',
  `-- ${what}`,
  `-- Source of truth: ${srcs}`,
  '-- (the reviewed extraction of the design handoff HTML in docs/design/artifacts/)',
  '-- Regenerate and diff to detect drift:  node scripts/design/generate-registry-seed.mjs --check',
  '',
];

// ── (a) blocks ───────────────────────────────────────────────────────────────────────────────────
const blockRows = blocks.blocks.map((b) => ({
  key: b.code, name: b.name, renderer_component: rendererFor(b.code),
  family: b.family, family_name: b.family_name,
  allowed_piece_types: b.allowed_piece_types ?? null,
  piece_types: pieceTypesFor(b), chart_question: chartQuestionFor(b),
  binding_rule: b.binding_rule ?? null, binds_to: b.binds_to ?? null,
  required_payload_fields: b.required_payload_fields ?? null,
  constraints: b.constraints ?? null, requires_binding: requiresBinding(b),
  rule_id: b.rule_id ?? null, gating_related: Boolean(b.gating_related),
}));

const B = [
  ...banner(`The ${blockRows.length} design blocks in ${blocks.families.length} families — the closed vocabulary a writer agent may emit.`,
    'docs/design/block-registry.json'),
  '-- ON CONFLICT preserves lake_object_type and consuming_templates on the SIX keys that overlap the',
  '-- 2026-07-13 seed (BLK-TICKER, BLK-DELTA, BLK-EXDATE, BLK-VERDICT, BLK-TIMELINE, BLK-ESTIMATE) —',
  '-- those bindings are already correct and the design cards do not restate them.',
  'insert into ops.story_blocks (key, name, display_name, renderer_component, consuming_templates,',
  '  family, family_name, allowed_piece_types, piece_types, chart_question, binding_rule, binds_to,',
  '  required_payload_fields, constraints, requires_binding, rule_id, gating_related, status)',
  "select s.key, s.name, s.name, s.renderer_component, '{}'::text[],",
  '       s.family, s.family_name, s.allowed_piece_types,',
  '       array(select jsonb_array_elements_text(s.piece_types)), s.chart_question, s.binding_rule,',
  '       s.binds_to, s.required_payload_fields, s.constraints, s.requires_binding, s.rule_id,',
  "       s.gating_related, 'active'",
  `  from jsonb_to_recordset(${j(blockRows)}) as s(`,
  '    key text, name text, renderer_component text, family text, family_name text,',
  '    allowed_piece_types text, piece_types jsonb, chart_question text, binding_rule text,',
  '    binds_to text, required_payload_fields jsonb, constraints jsonb, requires_binding boolean,',
  '    rule_id text, gating_related boolean)',
  'on conflict (key) do update set',
  '  display_name = excluded.display_name, renderer_component = excluded.renderer_component,',
  '  family = excluded.family, family_name = excluded.family_name,',
  '  allowed_piece_types = excluded.allowed_piece_types, piece_types = excluded.piece_types,',
  '  chart_question = excluded.chart_question, binding_rule = excluded.binding_rule,',
  '  binds_to = excluded.binds_to, required_payload_fields = excluded.required_payload_fields,',
  '  constraints = excluded.constraints, requires_binding = excluded.requires_binding,',
  "  rule_id = excluded.rule_id, gating_related = excluded.gating_related, status = 'active';",
  '',
  `-- grandfather the ${LEGACY_ONLY.length} seed-only keys (see the file header for why they survive)`,
  `update ops.story_blocks set status = 'legacy' where key in (${LEGACY_ONLY.map(q).join(', ')});`,
  '',
  'do $$ declare v_a int; v_l int; begin',
  "  select count(*) into v_a from ops.story_blocks where status='active';",
  "  select count(*) into v_l from ops.story_blocks where status='legacy';",
  `  if v_a <> ${blockRows.length} then raise exception 'expected ${blockRows.length} active blocks, got %', v_a; end if;`,
  `  if v_l <> ${LEGACY_ONLY.length} then raise exception 'expected ${LEGACY_ONLY.length} legacy blocks, got %', v_l; end if;`,
  "  raise notice 'story_blocks: % active + % legacy', v_a, v_l;",
  'end $$;',
];

// ── (b) templates — agent-facing fields only ─────────────────────────────────────────────────────
const tplRows = templates.templates.map((t) => ({
  id: t.id, name: t.name, role: t.role ?? null,
  stated_read_length: t.stated_read_length ?? null, access_tier: t.access_tier ?? null,
  piece_type: TEMPLATE_PIECE_TYPE[t.id] ?? null,
  section_sequence: t.section_sequence ?? [], premium_cut: t.premium_cut ?? null,
  writer_metadata_fields: t.writer_metadata_fields ?? {}, hard_rules: t.hard_rules ?? [],
}));

const T = [
  ...banner(`The ${tplRows.length} longform templates — AGENT-FACING fields only.`,
    'docs/design/article-templates.json'),
  '-- Pixel geometry (page_grid, body_typography, rail, gutter, block_instances) is deliberately NOT',
  '-- here: its consumer is the React renderer at build time, not an agent at run time. It stays in',
  '-- docs/design/article-templates.json rather than becoming a second copy to drift.',
  'insert into ops.article_templates (id, name, role, stated_read_length, access_tier, piece_type,',
  '  section_sequence, premium_cut, writer_metadata_fields, hard_rules)',
  'select s.id, s.name, s.role, s.stated_read_length, s.access_tier, s.piece_type,',
  '       s.section_sequence, s.premium_cut, s.writer_metadata_fields, s.hard_rules',
  `  from jsonb_to_recordset(${j(tplRows)}) as s(`,
  '    id text, name text, role text, stated_read_length text, access_tier jsonb, piece_type text,',
  '    section_sequence jsonb, premium_cut jsonb, writer_metadata_fields jsonb, hard_rules jsonb)',
  'on conflict (id) do update set',
  '  name = excluded.name, role = excluded.role, stated_read_length = excluded.stated_read_length,',
  '  access_tier = excluded.access_tier, piece_type = excluded.piece_type,',
  '  section_sequence = excluded.section_sequence, premium_cut = excluded.premium_cut,',
  '  writer_metadata_fields = excluded.writer_metadata_fields, hard_rules = excluded.hard_rules,',
  '  updated_at = now();',
  '',
  'do $$ declare v int; begin',
  '  select count(*) into v from ops.article_templates;',
  `  if v <> ${tplRows.length} then raise exception 'expected ${tplRows.length} article templates, got %', v; end if;`,
  "  raise notice 'article_templates: %', v;",
  'end $$;',
];

// ── (c) chassis / tokens / families ──────────────────────────────────────────────────────────────
const S = [...banner('The shared chassis, the design tokens and the eight family definitions.',
  'docs/design/{article-templates,block-registry}.json')];
for (const [key, value, src] of [
  ['chassis', templates.chassis, 'docs/design/article-templates.json'],
  ['tokens', blocks.tokens, 'docs/design/block-registry.json'],
  ['families', blocks.families, 'docs/design/block-registry.json'],
]) {
  S.push(`insert into ops.design_system (key, value, source) values (${q(key)}, ${j(value)}, ${q(src)})`);
  S.push('on conflict (key) do update set value = excluded.value, source = excluded.source, updated_at = now();');
  S.push('');
}
S.push('do $$ declare v int; begin');
S.push('  select count(*) into v from ops.design_system;');
S.push("  if v <> 3 then raise exception 'expected 3 design_system rows, got %', v; end if;");
S.push("  raise notice 'design_system: %', v;");
S.push('end $$;');

const files = { blocks: B.join('\n') + '\n', templates: T.join('\n') + '\n', system: S.join('\n') + '\n' };

let stale = 0;
for (const [name, sql] of Object.entries(files)) {
  const out = OUTS[name];
  if (CHECK) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== sql) {
      console.error(`✗ ${name} seed STALE vs docs/design/*.json — regenerate and review the diff`);
      stale++;
    }
  } else {
    writeFileSync(out, sql);
    console.log(`✓ ${name.padEnd(9)} ${String(sql.length).padStart(7)} bytes  ${out.split('/').pop()}`);
  }
}
if (CHECK) {
  if (stale) process.exit(1);
  console.log(`✓ design registry seeds in sync (${blockRows.length} blocks, ${tplRows.length} templates, 3 system rows)`);
}

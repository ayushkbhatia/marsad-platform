/**
 * PD.8 — the fit-and-refuse engine (09 §6). PURE and DETERMINISTIC: no LLM, no I/O.
 * `fit.ts` reads the registry + the drafted piece into a FitInput and calls runFit();
 * this file only decides.
 *
 * It is the first code in the repo that READS the design registry rather than
 * re-declaring it (DEF-REGISTRY-ZERO-READERS): every policy value below comes from
 * `ops.story_blocks` / `ops.article_templates` / `ops.templates`, never from a literal.
 *
 * The posture is REFUSAL, not repair: on any failure it returns evidence and stops.
 * It never degrades a block, never substitutes a fallback, and never invents a code —
 * "no agent may invent a block" is the property that makes an agent-run newsroom safe
 * to operate, and it is only true if the enforcement point refuses.
 *
 * Every refusal names (a) the rule code, (b) the offending block, (c) the evidence a
 * human at the Desk needs to act. Everything the stage could NOT check deterministically
 * is reported too (`unchecked`) — a silent skip reads as a pass, which is the failure
 * mode this stage exists to remove.
 */
import {
  BLOCK_PAYLOAD_SCHEMAS, DRIFT_TOL, isYearToken, markersIn, numberTokens,
  parseMagnitude, relDiff,
} from 'marsad-ingestion';
import type { BlockCode } from 'marsad-ingestion';

// ---------------------------------------------------------------------------
// Inputs — mirror the registry rows and the drafted piece.
// ---------------------------------------------------------------------------

/** One `ops.story_blocks` row (the columns the fit stage judges on). */
export interface RegistryBlock {
  key: string;
  status: string;                                   // 'active' | 'legacy'
  family: string | null;                            // A–H
  piece_types: string[] | null;                     // {'ALL'} = unrestricted
  requires_binding: boolean;
  binds_to: string | null;
  constraints: string[] | null;                     // the design cards' prose, verbatim
  // PD.3 projection, NOT the enforcer — see checkPayloadSchema. Still selected because the column
  // is what a provider gets as `response_format: json_schema`; that consumer is the writer stage.
  payload_schema: Record<string, unknown> | null;
}

/** One `ops.templates` row (TPL-01…08 — the PIPELINE axis). */
export interface PipelineTemplate {
  key: string;
  block_keys: string[];
  auto_publish_eligible: boolean;
  always_premium: boolean;
  max_words: number | null;
}

/** One `ops.article_templates` row (1a/1b/3a/3b — the LAYOUT axis). */
export interface LayoutTemplate {
  id: string;
  piece_type: string;
  premium_cut: Record<string, unknown> | null;
  hard_rules: string[];
}

/** One `public.content_blocks` row, payload-aware. */
export interface FitBlock {
  seq: number;
  /** raw `block_kind` — a BLK-* design code, or a chassis prose kind. */
  code: string;
  payload: Record<string, unknown>;
  bound_object_id: string | null;
  gated: boolean;
}

/** One `lake.citations` row joined to its object. */
export interface FitCitation {
  claim_key: string;
  object_id: string;
  quoted_value: string | null;
  object_state: string | null;                      // null ⇒ object missing
  object_payload: Record<string, unknown> | null;
}

export interface FitInput {
  content_id: string;
  content_type: string;
  template_key: string | null;
  is_premium: boolean;
  word_count: number;
  /** Agent-written ⇒ the piece also carries the design's 'AI' piece type. */
  agent_authored: boolean;
  premium_cut_after_block: number | null;
  blocks: FitBlock[];
  citations: FitCitation[];
  /** `ops.story_blocks` keyed by upper-case code (active AND legacy rows). */
  registry: Record<string, RegistryBlock>;
  pipelineTemplate: PipelineTemplate | null;
  layoutTemplate: LayoutTemplate | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface FitFinding {
  /** FIT-* taxonomy code. */
  code: string;
  /** The design block code this is about, when it is about one. */
  block_code?: string;
  /** content_blocks.seq of the offending block. */
  seq?: number;
  /** The publishing rule this enforces, when it maps to one (R-03/R-04/R-09…). */
  rule?: string;
  /** Everything a human needs to act without re-deriving the check. */
  evidence: Record<string, unknown>;
}

export interface FitReport {
  passed: boolean;
  refusals: FitFinding[];
  warnings: FitFinding[];
  /** Checks that could not be run deterministically — reported, never treated as passes. */
  unchecked: FitFinding[];
  cut: {
    /** index of the first block BELOW the cut (blocks[] index), null = no cut. */
    current_index: number | null;
    /** the seq the cut should fall AFTER, when the stage places one. */
    placement_after_seq: number | null;
    required: boolean;
    permitted: boolean;
  };
  stats: { blocks: number; design_blocks: number; numerals_checked: number };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Chassis kinds — the plain prose furniture the writer emits today (`draft.ts` writes
 * `text`; the seeds write `heading` / `pull_quote`). These are NOT design blocks and
 * are deliberately not in `ops.story_blocks`; refusing them would refuse every piece
 * ever drafted. Normalised (lower, strip non-alphanumerics) for the same reason PD.4
 * normalises: three producers disagree on spelling.
 */
const CHASSIS_KINDS = new Set([
  'text', 'p', 'para', 'paragraph', 'prose', 'body',
  'heading', 'subhead', 'subheading', 'dropcap', 'pullquote',
  'disclaimer', 'standfirst', 'dek',
]);

/** Payload fields that carry PROSE (the numeric-consistency check's surface).
 *  A table's cells are BOUND values, not prose — they are checked by the binding
 *  rule, not by the numeral scan. */
const PROSE_FIELDS = ['text', 'body', 'prose', 'caption', 'note', 'standfirst', 'one_line_intent', 'intent'];

/**
 * The ONE place the two template axes are joined. `ops.templates` (TPL-0x, the
 * pipeline axis) and `ops.article_templates` (1a/1b/3a/3b, the layout axis) share no
 * column, and `content_items` carries no layout-template id — so the design piece type
 * has to be derived. This map is the stage's ONLY hard-coded policy; it moves into the
 * registry the moment `ops.templates` gains a `piece_type` column.
 */
const PIECE_TYPE_BY_TEMPLATE: Record<string, string> = {
  'TPL-01': 'WIRE',
  'TPL-05': 'IPO',
  'TPL-06': 'EXPLAINER',
  'TPL-08': 'DEEP DIVE',
};
const PIECE_TYPE_BY_CONTENT_TYPE: Record<string, string> = {
  WIRE: 'WIRE',
  ARTICLE: 'FEATURE',
  NOTE: 'NOTE',
  EXPLAINER: 'EXPLAINER',
  TAKE: 'FEATURE',
};

/** Resolve the design piece type. Template key wins (it is the more specific axis). */
export function resolvePieceType(contentType: string, templateKey: string | null): string | null {
  if (templateKey && PIECE_TYPE_BY_TEMPLATE[templateKey]) return PIECE_TYPE_BY_TEMPLATE[templateKey]!;
  return PIECE_TYPE_BY_CONTENT_TYPE[contentType] ?? null;
}

function normalizeKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when the block_kind is chassis prose rather than a design block code. */
export function isChassisKind(kind: string): boolean {
  return CHASSIS_KINDS.has(normalizeKind(kind));
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function runFit(input: FitInput): FitReport {
  const refusals: FitFinding[] = [];
  const warnings: FitFinding[] = [];
  const unchecked: FitFinding[] = [];

  const pieceTypes = pieceTypeSet(input);
  if (pieceTypes === null) {
    refusals.push({
      code: 'FIT-PIECE-TYPE-UNRESOLVED',
      evidence: {
        content_type: input.content_type,
        template_key: input.template_key,
        why: 'no design piece type maps to this content_type/template_key, so block permission cannot be judged',
        fix: 'give the piece a template_key that maps to a design piece type, or add the mapping when ops.templates gains piece_type',
      },
    });
  }

  // ---- template-level policy, read from ops.templates (never re-hard-coded) -----
  checkPipelineTemplate(input, refusals, warnings, unchecked);

  // ---- per-block ---------------------------------------------------------------
  const resolved: Array<{ block: FitBlock; reg: RegistryBlock | null }> = [];
  let designBlocks = 0;

  for (const block of input.blocks) {
    if (isChassisKind(block.code)) { resolved.push({ block, reg: null }); continue; }

    const code = block.code.trim().toUpperCase();
    const reg = input.registry[code] ?? null;

    if (!reg) {
      refusals.push({
        code: 'FIT-BLOCK-UNKNOWN', block_code: code, seq: block.seq,
        evidence: {
          why: 'not a code in ops.story_blocks — no agent may invent a block',
          fix: 'use one of the 61 active codes, or emit chassis prose',
        },
      });
      resolved.push({ block, reg: null });
      continue;
    }
    designBlocks++;
    resolved.push({ block, reg });

    if (reg.status !== 'active') {
      refusals.push({
        code: 'FIT-BLOCK-LEGACY', block_code: code, seq: block.seq,
        evidence: {
          status: reg.status,
          why: 'a retired vocabulary entry, kept only so ops.templates.block_keys still resolves',
          fix: 'replace with the active block that supersedes it',
        },
      });
    }

    if (pieceTypes !== null) {
      const allowed = reg.piece_types ?? [];
      const unrestricted = allowed.length === 0 || allowed.includes('ALL');
      if (!unrestricted && !allowed.some((t) => pieceTypes.has(t))) {
        refusals.push({
          code: 'FIT-BLOCK-PIECE-TYPE', block_code: code, seq: block.seq,
          evidence: {
            piece_types_allowed: allowed,
            piece_type_of_this_piece: [...pieceTypes],
            why: 'ops.story_blocks.piece_types does not admit this piece type (permission lives on the block, not the template)',
          },
        });
      }
    } else {
      unchecked.push({ code: 'FIT-BLOCK-PIECE-TYPE', block_code: code, seq: block.seq, evidence: { reason: 'piece type unresolved' } });
    }

    checkBinding(input, block, reg, refusals);
    checkConstraints(input, block, reg, refusals, unchecked);
    checkPayloadSchema(block, reg, refusals, unchecked);
  }

  // ---- numeric consistency over block prose (09 §5.6) --------------------------
  const numerals = checkNumbers(input, refusals, unchecked);

  // ---- the premium cut (R-09) ---------------------------------------------------
  const cut = checkCut(input, resolved, refusals, warnings, unchecked);

  return {
    passed: refusals.length === 0,
    refusals, warnings, unchecked, cut,
    stats: { blocks: input.blocks.length, design_blocks: designBlocks, numerals_checked: numerals },
  };
}

/** The design piece types this piece satisfies. null ⇒ unresolvable. */
function pieceTypeSet(input: FitInput): Set<string> | null {
  const primary = resolvePieceType(input.content_type, input.template_key);
  if (!primary) return null;
  const set = new Set<string>([primary]);
  // 'AI' is an orthogonal axis in the registry (BLK-CITE, BLK-FALSIFY are 'AI · NOTE'):
  // it means "an AI wrote it", not "instead of FEATURE". Without this, BLK-CITE — the
  // block the design makes MANDATORY on every AI factual claim — would be refused on
  // every agent-written feature.
  if (input.agent_authored) set.add('AI');
  return set;
}

// ---------------------------------------------------------------------------
// ops.templates — the values that were hard-coded in three places each
// ---------------------------------------------------------------------------

function checkPipelineTemplate(
  input: FitInput, refusals: FitFinding[], warnings: FitFinding[], unchecked: FitFinding[],
): void {
  const tpl = input.pipelineTemplate;
  if (!tpl) {
    const finding: FitFinding = input.template_key
      ? { code: 'FIT-TEMPLATE-UNKNOWN', evidence: { template_key: input.template_key, why: 'no ops.templates row with this key' } }
      : { code: 'FIT-TEMPLATE-UNSET', evidence: { why: 'content_items.template_key is null — no registry policy to apply' } };
    if (input.template_key) refusals.push(finding); else warnings.push(finding);
    unchecked.push({ code: 'FIT-TEMPLATE-POLICY', evidence: { reason: 'no ops.templates row resolved', skipped: ['max_words', 'always_premium', 'block_keys'] } });
    return;
  }

  // max_words — the value that is AUTO_WORD_CAP_DEFAULT in engine.ts, a literal 40 in
  // rules-stage.ts, and `<= 40` in fn_enforce_agent_publish_gate. Here it is READ.
  if (tpl.max_words != null && input.word_count > tpl.max_words) {
    refusals.push({
      code: 'FIT-TEMPLATE-MAXWORDS',
      evidence: { source: 'ops.templates.max_words', template: tpl.key, cap: tpl.max_words, word_count: input.word_count },
    });
  }

  if (tpl.always_premium && !input.is_premium) {
    refusals.push({
      code: 'FIT-TEMPLATE-PREMIUM',
      evidence: { source: 'ops.templates.always_premium', template: tpl.key, is_premium: input.is_premium },
    });
  }

  // Legacy keys named by the TEMPLATE are a WARNING, not a refusal — see the header
  // note in fit.ts. The piece's author did not choose them; a data migration fixes them.
  const declared = new Set(tpl.block_keys ?? []);
  const legacyDeclared = [...declared].filter((k) => input.registry[k]?.status === 'legacy');
  if (legacyDeclared.length > 0) {
    warnings.push({
      code: 'FIT-TEMPLATE-LEGACY-KEY',
      evidence: {
        template: tpl.key, legacy_keys: legacyDeclared,
        why: 'ops.templates.block_keys still names retired codes (seeded 2026-07-13, grandfathered by PD.2)',
        fix: 'a data migration re-pointing ops.templates.block_keys at the active 61 — not something a writer agent can act on',
      },
    });
  }

  const used = input.blocks.filter((b) => !isChassisKind(b.code)).map((b) => b.code.trim().toUpperCase());
  const undeclared = [...new Set(used)].filter((k) => !declared.has(k));
  if (undeclared.length > 0) {
    warnings.push({
      code: 'FIT-TEMPLATE-BLOCK-UNDECLARED',
      evidence: {
        template: tpl.key, blocks: undeclared,
        why: 'used but not listed in ops.templates.block_keys; permission is judged on ops.story_blocks.piece_types, so this is advisory',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Binding — hard rule 2: every number carries a provenance stamp
// ---------------------------------------------------------------------------

function checkBinding(input: FitInput, block: FitBlock, reg: RegistryBlock, refusals: FitFinding[]): void {
  if (!reg.requires_binding) return;

  if (!block.bound_object_id) {
    refusals.push({
      code: 'FIT-BIND-MISSING', block_code: reg.key, seq: block.seq, rule: 'R-03',
      evidence: { binds_to: reg.binds_to, why: 'ops.story_blocks.requires_binding = true and content_blocks.bound_object_id is null' },
    });
    return;
  }

  const cited = input.citations.filter((c) => c.object_id === block.bound_object_id);
  if (cited.length === 0) {
    refusals.push({
      code: 'FIT-BIND-UNCITED', block_code: reg.key, seq: block.seq, rule: 'R-03',
      evidence: {
        bound_object_id: block.bound_object_id,
        why: 'the bound object has no lake.citations row on this piece — the binding is unauditable',
      },
    });
    return;
  }

  const bad = cited.filter((c) => c.object_state !== 'VERIFIED');
  if (bad.length === cited.length) {
    refusals.push({
      code: 'FIT-BIND-UNRESOLVED', block_code: reg.key, seq: block.seq, rule: 'R-03',
      evidence: {
        bound_object_id: block.bound_object_id,
        object_state: bad[0]?.object_state ?? 'missing',
        why: 'the bound lake object is not VERIFIED (or does not resolve)',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Numeric consistency — "the prose says 12.4% and the bound object says 12.1%"
// ---------------------------------------------------------------------------

interface Reachable { value: number; source: string }

/** Every number reachable from a block's citations + its binding. */
function reachableValues(input: FitInput, block: FitBlock): Reachable[] {
  const prose = proseOf(block).join(' ');
  const keys = new Set(markersIn(prose));
  const out: Reachable[] = [];
  const seen = new Set<string>();

  for (const c of input.citations) {
    const linked = keys.has(c.claim_key) || (block.bound_object_id !== null && c.object_id === block.bound_object_id);
    if (!linked) continue;
    const frozen = parseMagnitude(String(c.quoted_value ?? ''));
    if (frozen !== null) push(out, seen, frozen, `citation ${c.claim_key} quoted_value`);
    for (const v of walkNumbers(c.object_payload)) push(out, seen, v.value, `object ${c.object_id} ${v.path}`);
  }
  return out;
}

function push(out: Reachable[], seen: Set<string>, value: number, source: string): void {
  if (!Number.isFinite(value)) return;
  const k = `${value}`;
  if (seen.has(k)) return;
  seen.add(k);
  out.push({ value, source });
}

/** Recursively collect numeric leaves of a lake payload (numbers, and numeric strings). */
function walkNumbers(payload: unknown, path = '', depth = 0): Array<{ value: number; path: string }> {
  if (payload == null || depth > 5) return [];
  if (typeof payload === 'number') return Number.isFinite(payload) ? [{ value: payload, path: path || '(root)' }] : [];
  if (typeof payload === 'string') {
    const m = parseMagnitude(payload);
    return m === null ? [] : [{ value: m, path: path || '(root)' }];
  }
  if (Array.isArray(payload)) return payload.flatMap((v, i) => walkNumbers(v, `${path}[${i}]`, depth + 1));
  if (typeof payload === 'object') {
    return Object.entries(payload as Record<string, unknown>)
      .flatMap(([k, v]) => walkNumbers(v, path ? `${path}.${k}` : k, depth + 1));
  }
  return [];
}

const PERCENT_TOKEN = /%|percent/i;
const UNIT_TOKEN = /%|percent|trillion|tn|bn|billion|mn|m|million|k|thousand|SAR|AED|QAR|OMR|BHD|KWD|USD|﷼|\$/i;

/**
 * Is this numeral a FINANCIAL MAGNITUDE (and so must be lake-backed), or incidental?
 *
 * The deliberate false-refusal control. A bare integer under 1,000 with no unit
 * ("three of the four", "8 rows") is prose, not a claim; requiring it to resolve to a
 * lake value would refuse most honest copy and the stage would be switched off. This is
 * a materiality filter LAYERED ON `numberTokens()` — not a second definition of "what
 * is a number" (DEF-RULES-R04-REGEX). Everything it skips is reported as `unchecked`.
 */
export function isMaterialNumeral(token: string): boolean {
  const t = token.trim();
  if (isYearToken(t)) return false;
  if (UNIT_TOKEN.test(t)) return true;
  if (/[.,]/.test(t)) return true;
  const mag = parseMagnitude(t);
  return mag !== null && Math.abs(mag) >= 1000;
}

function checkNumbers(input: FitInput, refusals: FitFinding[], unchecked: FitFinding[]): number {
  let checked = 0;

  for (const block of input.blocks) {
    const prose = proseOf(block);
    if (prose.length === 0) continue;
    const code = isChassisKind(block.code) ? block.code : block.code.trim().toUpperCase();

    const tokens = prose.flatMap((p) => numberTokens(p));
    const material = tokens.filter(isMaterialNumeral);
    const skipped = tokens.filter((t) => !isMaterialNumeral(t));
    if (skipped.length > 0) {
      unchecked.push({
        code: 'FIT-NUMBER-IMMATERIAL', block_code: code, seq: block.seq,
        evidence: { tokens: skipped.slice(0, 12), reason: 'bare integer < 1000 with no unit, or a 1990–2099 year — not treated as a lake claim' },
      });
    }
    if (material.length === 0) continue;

    const reachable = reachableValues(input, block);
    if (reachable.length === 0) {
      refusals.push({
        code: 'FIT-NUMBER-UNSOURCED', block_code: code, seq: block.seq, rule: 'R-03',
        evidence: {
          numerals: material.slice(0, 12),
          why: 'the block states figures but no citation marker resolves and it binds no object — nothing to check them against',
        },
      });
      continue;
    }

    for (const tok of material) {
      const mag = parseMagnitude(tok);
      if (mag === null) continue;
      checked++;
      // A percent in prose may be stored as a fraction in the payload (12.4% vs 0.124),
      // so a percent token matches either form. No other rescaling is allowed: matching
      // 6.25bn against a payload's 6.25 would let an unrelated per-share figure pass.
      const isPct = PERCENT_TOKEN.test(tok);
      let best: { r: Reachable; diff: number } | null = null;
      for (const r of reachable) {
        const candidates = isPct ? [r.value, r.value * 100] : [r.value];
        for (const c of candidates) {
          const d = relDiff(mag, c);
          if (best === null || d < best.diff) best = { r, diff: d };
        }
      }
      if (!best || best.diff > DRIFT_TOL) {
        refusals.push({
          code: 'FIT-NUMBER-MISMATCH', block_code: code, seq: block.seq, rule: 'R-04',
          evidence: {
            prose_token: tok,
            prose_value: mag,
            nearest_reachable_value: best?.r.value ?? null,
            nearest_source: best?.r.source ?? null,
            rel_diff: best ? Number(best.diff.toFixed(6)) : null,
            tolerance: DRIFT_TOL,
          },
        });
      }
    }
  }
  return checked;
}

function proseOf(block: FitBlock): string[] {
  const out: string[] = [];
  for (const f of PROSE_FIELDS) {
    const v = block.payload?.[f];
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-block constraints — parsed from the registry's own prose
// ---------------------------------------------------------------------------

type ParsedConstraint =
  | { kind: 'max' | 'exact' | 'min'; n: number; noun: string }
  | { kind: 'range'; min: number; max: number; noun: string }
  | { kind: 'oneof'; ns: number[]; noun: string }
  | { kind: 'one_per_piece' }
  | { kind: 'per_words'; words: number };

const WORD_NUM: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10,
};
/** Trailing words a cardinality clause may carry and still be fully understood. */
const BENIGN_TAIL = /^(INLINE|ONLY|MAX|TOTAL|EACH|PER PIECE)?$/;

/**
 * Countable dimension → the payload array that holds it. Deliberately small: the
 * general rule is "the payload array named by the noun"; this only covers the
 * synonyms the design cards actually use. An unresolved noun is `unchecked`, never
 * a refusal — guessing which array a constraint meant is how a checker starts lying.
 */
const NOUN_ALIASES: Record<string, string[]> = {
  row: ['rows'], cell: ['cells', 'stats'], segment: ['segments'], node: ['nodes'],
  step: ['steps'], chip: ['chips'], point: ['points', 'values'], name: ['names', 'columns'],
  metric: ['metrics', 'rows'], driver: ['drivers'], scenario: ['scenarios', 'rows'],
  stage: ['stages'], area: ['areas', 'series'], line: ['lines', 'bullets'],
  period: ['periods', 'columns'], outcome: ['outcomes'], entry: ['entries'], item: ['items'],
};

/** Split a constraint into clauses on the punctuation the design cards use.
 *  NOT on the en dash: the cards spell ranges with it ("3–5 CELLS MAX"), so splitting
 *  there turns a range into two fragments and "5 CELLS MAX" reads as a cap of five. */
function clausesOf(text: string): string[] {
  return text.split(/[·—]|(?:\s-\s)|,/).map((s) => s.trim()).filter(Boolean);
}

function num(tok: string): number | null {
  const t = tok.toUpperCase();
  if (WORD_NUM[t] != null) return WORD_NUM[t]!;
  const n = Number(t.replace(/,/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Parse one constraint clause into a machine-checkable cardinality, or null.
 *
 * The parse must consume the WHOLE clause. That guard is what stops
 * "EXACTLY ONE STAGE IN RED" (a colour rule about one of four stages) from being read
 * as "the payload must hold exactly one stage" — the leftover "IN RED" rejects it.
 */
export function parseConstraint(clause: string): ParsedConstraint | null {
  const c = clause.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^ONE PER PIECE$/.test(c)) return { kind: 'one_per_piece' };

  const perWords = c.match(/^ONE PER ([\d,]+) WORDS$/);
  if (perWords?.[1]) {
    const w = num(perWords[1]);
    if (w) return { kind: 'per_words', words: w };
  }

  const tail = (rest: string): boolean => BENIGN_TAIL.test(rest.trim());
  const NOUN = '([A-Z]+)';

  let m = c.match(new RegExp(`^(?:NEVER [A-Z ]*?)?(?:MORE THAN|OVER) (\\S+) ${NOUN}(.*)$`));
  if (m?.[1] && m[2] && tail(m[3] ?? '')) {
    const n = num(m[1]);
    if (n !== null) return { kind: 'max', n, noun: m[2] };
  }

  m = c.match(new RegExp(`^MAX (\\S+) ${NOUN}(.*)$`));
  if (m?.[1] && m[2] && tail(m[3] ?? '')) {
    const n = num(m[1]);
    if (n !== null) return { kind: 'max', n, noun: m[2] };
  }

  m = c.match(new RegExp(`^(\\S+)\\s*[–-]\\s*(\\S+) ${NOUN}(.*)$`));
  if (m?.[1] && m[2] && m[3] && tail(m[4] ?? '')) {
    const lo = num(m[1]); const hi = num(m[2]);
    if (lo !== null && hi !== null && hi >= lo) return { kind: 'range', min: lo, max: hi, noun: m[3] };
  }

  m = c.match(new RegExp(`^(\\S+) OR (\\S+) ${NOUN}(.*)$`));
  if (m?.[1] && m[2] && m[3] && tail(m[4] ?? '')) {
    const a = num(m[1]); const b = num(m[2]);
    if (a !== null && b !== null) return { kind: 'oneof', ns: [a, b], noun: m[3] };
  }

  m = c.match(new RegExp(`^EXACTLY (\\S+) ${NOUN}(.*)$`));
  if (m?.[1] && m[2] && tail(m[3] ?? '')) {
    const n = num(m[1]);
    if (n !== null) return { kind: 'exact', n, noun: m[2] };
  }

  // "TWO PERIODS ONLY" is a count; "THREE LABELS MAX" is a ceiling. The suffix decides.
  m = c.match(new RegExp(`^(\\S+) ${NOUN} (ONLY|MAX)$`));
  if (m?.[1] && m[2] && m[3]) {
    const n = num(m[1]);
    if (n !== null) return { kind: m[3] === 'MAX' ? 'max' : 'exact', n, noun: m[2] };
  }

  return null;
}

/** Count the payload array a constraint's noun names. null ⇒ not present. */
function countFor(payload: Record<string, unknown>, noun: string): { n: number; key: string } | null {
  const base = noun.toLowerCase().replace(/s$/, '');
  const candidates = [...(NOUN_ALIASES[base] ?? []), `${base}s`, base];
  for (const key of candidates) {
    const v = payload?.[key];
    if (Array.isArray(v)) return { n: v.length, key };
  }
  return null;
}

function checkConstraints(
  input: FitInput, block: FitBlock, reg: RegistryBlock, refusals: FitFinding[], unchecked: FitFinding[],
): void {
  for (const raw of reg.constraints ?? []) {
    let parsed: ParsedConstraint | null = null;
    for (const clause of clausesOf(raw)) {
      parsed = parseConstraint(clause);
      if (parsed) break;
    }
    if (!parsed) {
      unchecked.push({
        code: 'FIT-CONSTRAINT-PROSE', block_code: reg.key, seq: block.seq,
        evidence: { constraint: raw, reason: 'not machine-checkable (a design/visual rule, or a cardinality this parser will not guess at)' },
      });
      continue;
    }

    if (parsed.kind === 'one_per_piece') {
      const n = input.blocks.filter((b) => !isChassisKind(b.code) && b.code.trim().toUpperCase() === reg.key).length;
      if (n > 1) {
        refusals.push({
          code: 'FIT-CONSTRAINT-UNIQUE', block_code: reg.key, seq: block.seq,
          evidence: { constraint: raw, instances: n, seqs: input.blocks.filter((b) => b.code.trim().toUpperCase() === reg.key).map((b) => b.seq) },
        });
      }
      continue;
    }

    if (parsed.kind === 'per_words') {
      const n = input.blocks.filter((b) => b.code.trim().toUpperCase() === reg.key).length;
      const allowed = Math.max(1, Math.ceil(input.word_count / parsed.words));
      if (n > allowed) {
        refusals.push({
          code: 'FIT-CONSTRAINT-CARDINALITY', block_code: reg.key, seq: block.seq,
          evidence: { constraint: raw, instances: n, allowed, word_count: input.word_count },
        });
      }
      continue;
    }

    const counted = countFor(block.payload, parsed.noun);
    if (!counted) {
      unchecked.push({
        code: 'FIT-CONSTRAINT-NO-PAYLOAD', block_code: reg.key, seq: block.seq,
        evidence: { constraint: raw, dimension: parsed.noun.toLowerCase(), reason: 'the block payload carries no array with that name' },
      });
      continue;
    }

    let bad = false;
    switch (parsed.kind) {
      case 'max': bad = counted.n > parsed.n; break;
      case 'min': bad = counted.n < parsed.n; break;
      case 'exact': bad = counted.n !== parsed.n; break;
      case 'range': bad = counted.n < parsed.min || counted.n > parsed.max; break;
      case 'oneof': bad = !parsed.ns.includes(counted.n); break;
    }

    if (bad) {
      refusals.push({
        code: 'FIT-CONSTRAINT-CARDINALITY', block_code: reg.key, seq: block.seq,
        evidence: { constraint: raw, source: 'ops.story_blocks.constraints', payload_field: counted.key, count: counted.n, expected: parsed },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Payload schemas — enforced from Zod, NEVER a refusal when a block has no schema
// ---------------------------------------------------------------------------

function checkPayloadSchema(block: FitBlock, reg: RegistryBlock, refusals: FitFinding[], unchecked: FitFinding[]): void {
  // ZOD IS THE ENFORCER; ops.story_blocks.payload_schema is a PROJECTION of it.
  //
  // The two exist for different consumers and must not be confused:
  //   * the DB column is what we hand a model as `response_format: json_schema` — it has to be
  //     JSON Schema because that is what the provider speaks;
  //   * the Zod schema is what we ENFORCE here, because it is strictly more expressive.
  //
  // This used to validate against the DB column with a hand-rolled walker implementing
  // required/type/enum/min|max/min|maxItems only. Measured against the generated schemas, that
  // walker cannot see 486 constraints: additionalProperties:false x179 (the agent inventing a
  // field), pattern x168 — including the uuid pattern on `object_id`, which IS the D-8 binding
  // rule — format x92, const x45 (an out-of-vocabulary chart shape) and anyOf x2. It also cannot
  // express Zod's 8 cross-field refinements at all (exactly one base scenario, human last in the
  // byline chain, one value per period column). A validator that silently enforces a third of what
  // it appears to is worse than none: a green report implies checks that never ran.
  const zod = BLOCK_PAYLOAD_SCHEMAS[reg.key as BlockCode];
  if (!zod) {
    unchecked.push({
      code: 'FIT-PAYLOAD-SCHEMA', block_code: reg.key, seq: block.seq,
      evidence: { reason: `no Zod schema for ${reg.key} (legacy or unrecognised block) — absence is never a refusal` },
    });
    return;
  }
  const res = zod.safeParse(block.payload);
  if (!res.success) {
    refusals.push({
      code: 'FIT-PAYLOAD-SCHEMA', block_code: reg.key, seq: block.seq,
      evidence: {
        problems: res.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        source: 'ingestion/src/blocks (Zod)',
      },
    });
  }
}




// ---------------------------------------------------------------------------
// The premium cut (R-09 / BLK-CUT)
// ---------------------------------------------------------------------------

const ENDS_THOUGHT = /[.!?]["'”’)\]]*\s*$/;

function endsCompleteThought(block: FitBlock): boolean | null {
  const prose = proseOf(block);
  if (prose.length === 0) return null;                     // an exhibit ends nothing mid-sentence
  return ENDS_THOUGHT.test(prose[prose.length - 1]!.trim());
}

function isDataBlock(entry: { block: FitBlock; reg: RegistryBlock | null }): boolean {
  if (entry.block.bound_object_id) return true;
  const fam = entry.reg?.family;
  return fam === 'C' || fam === 'D';                       // tabular / charts — the evidence families
}

function checkCut(
  input: FitInput,
  resolved: Array<{ block: FitBlock; reg: RegistryBlock | null }>,
  refusals: FitFinding[], warnings: FitFinding[], unchecked: FitFinding[],
): FitReport['cut'] {
  const present = input.layoutTemplate?.premium_cut?.['present'];
  const required = present === true;
  const permitted = present !== false;
  if (!input.layoutTemplate) {
    unchecked.push({
      code: 'FIT-CUT', evidence: { reason: 'no ops.article_templates row for this piece type — the layout axis carries the cut policy' },
    });
  }

  let cutIndex: number | null = null;
  const gatedIdx = input.blocks.findIndex((b) => b.gated);
  if (gatedIdx >= 0) cutIndex = gatedIdx;
  const afterSeq = input.premium_cut_after_block;
  if (afterSeq != null) {
    const i = input.blocks.findIndex((b) => b.seq === afterSeq);
    const derived = i >= 0 ? i + 1 : null;
    if (cutIndex === null) cutIndex = derived;
    else if (derived !== null && derived !== cutIndex) {
      warnings.push({
        code: 'FIT-CUT-INCONSISTENT',
        evidence: { gated_block_index: cutIndex, premium_cut_after_block: afterSeq, why: 'the two cut surfaces disagree; the gated flag is authoritative' },
      });
    }
  }

  const legal = (i: number): boolean => {
    if (i < 1 || i >= input.blocks.length) return false;
    if (!resolved.slice(0, i).some(isDataBlock)) return false;
    for (let j = i - 1; j >= 0; j--) {
      const t = endsCompleteThought(input.blocks[j]!);
      if (t === null) continue;
      return t;
    }
    return false;
  };

  if (cutIndex !== null) {
    if (!permitted) {
      refusals.push({
        code: 'FIT-CUT-NOT-PERMITTED', rule: 'R-09',
        evidence: { template: input.layoutTemplate?.id, cut_index: cutIndex, why: 'ops.article_templates.premium_cut.present = false — this piece type is gated at document level, or is free' },
      });
    }
    if (!resolved.slice(0, cutIndex).some(isDataBlock)) {
      refusals.push({
        code: 'FIT-CUT-NO-DATA', rule: 'R-09',
        evidence: { cut_index: cutIndex, why: 'no bound or C/D-family block sits above the cut — the reader hits the wall before any evidence' },
      });
    }
    const before = input.blocks[cutIndex - 1];
    if (before && endsCompleteThought(before) === false) {
      refusals.push({
        code: 'FIT-CUT-MID-SENTENCE', rule: 'R-09', seq: before.seq,
        evidence: { cut_index: cutIndex, tail: proseOf(before).slice(-1)[0]?.slice(-80) ?? null, why: 'BLK-CUT: the cut falls after a complete thought, never mid-sentence' },
      });
    }
    return { current_index: cutIndex, placement_after_seq: null, required, permitted };
  }

  if (!required) return { current_index: null, placement_after_seq: null, required, permitted };

  // The template declares a cut and the piece has none — place it. Two thirds through,
  // per 1a's own spec ("roughly two thirds through the argument"), then the first legal
  // position at or after that, else the last legal position before it.
  const target = Math.max(1, Math.ceil((input.blocks.length * 2) / 3));
  let placeAt: number | null = null;
  for (let i = target; i < input.blocks.length; i++) if (legal(i)) { placeAt = i; break; }
  if (placeAt === null) for (let i = target - 1; i >= 1; i--) if (legal(i)) { placeAt = i; break; }

  if (placeAt === null) {
    refusals.push({
      code: 'FIT-CUT-UNPLACEABLE', rule: 'R-09',
      evidence: {
        template: input.layoutTemplate?.id, blocks: input.blocks.length,
        why: 'the template requires a metered cut and no position satisfies R-09 (≥1 data block above it, falling after a complete thought)',
      },
    });
    return { current_index: null, placement_after_seq: null, required, permitted };
  }
  return { current_index: null, placement_after_seq: input.blocks[placeAt - 1]!.seq, required, permitted };
}

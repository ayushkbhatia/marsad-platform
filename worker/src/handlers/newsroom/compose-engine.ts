/**
 * Composition — the PURE half (PD / 09 §5.5).
 *
 * Turns a drafted piece into blocks from the closed BLK-* vocabulary. Everything here is a pure
 * function of its inputs so the legal-vocabulary rules and the outline validation are
 * golden-testable without a database or a model.
 *
 * ── THE TWO-PASS SHAPE, AND WHY ───────────────────────────────────────────────
 * Pass 1 emits an OUTLINE — [{block_code, binding_object_id, one_line_intent}] — against an enum
 * of only the codes legal for this piece. Pass 2 fills one block at a time against that block's
 * own payload_schema.
 *
 * The usual justification for splitting is that a 61-arm union blows the provider's limits. That
 * is no longer true (OpenAI raised properties 100 → 5,000 and enums 500 → 1,000 in July 2025).
 * The real reasons are auditability and quality: every refusal points at one block rather than
 * at "the composition", and each schema stays small enough that the model is choosing within a
 * card rather than across a library.
 */

export interface StoryBlockRow {
  key: string;
  status: string;
  family: string | null;
  piece_types: string[] | null;
  requires_binding: boolean;
  renderer_built: boolean;
  payload_schema: Record<string, unknown> | null;
  /**
   * The design cards' constraint prose, verbatim — the same column the fit stage parses.
   * Compose was blind to this, which is how one piece shipped two BLK-BIGNUMs into a fit
   * refusal: the constraint was legible to the checker and invisible to the author.
   */
  constraints: string[] | null;
}

export interface OutlineEntry {
  block_code: string;
  binding_object_id: string | null;
  one_line_intent: string;
  /**
   * Which prose paragraph this exhibit FOLLOWS: 0 places it above the first, n below the nth.
   *
   * The outline used to be the whole document, which meant composing a piece silently deleted
   * every paragraph the writer had written — the enum held only BLK-* codes, so there was no
   * token the model could emit that meant "keep the prose here". The result read as nine
   * exhibits in a row: no running text for the numeral check to check, and no complete thought
   * anywhere for the premium cut to fall after. An exhibit annotates an argument; it is not
   * the argument.
   */
  after_paragraph: number;
}

export interface LegalVocabulary {
  codes: string[];
  /** Why each excluded code was excluded — surfaced in the transition detail, never silent. */
  excluded: { code: string; reason: string }[];
}

/**
 * The codes this piece may use.
 *
 * Four filters, in order of authority:
 *   1. the template's own block_keys (ops.templates) — the editorial vocabulary for this shape;
 *   2. the block is ACTIVE in the registry — a legacy code is retired, not merely discouraged;
 *   3. the block's piece_types admits this piece (or 'ALL'), plus 'AI' when agent-authored;
 *   4. a renderer EXISTS for it.
 *
 * (4) is the one that is not in the spec, and it is deliberate. Composing a block with no
 * renderer puts a MissingBlock on a published page — loud is right for a bug, but it is not
 * something to schedule on purpose. Until families D, E and F land, the composer works within
 * what the reader can actually draw. The exclusion is REPORTED rather than silent, so the gap
 * between "designed" and "drawable" stays visible.
 */
export function legalVocabulary(
  templateBlockKeys: string[],
  registry: StoryBlockRow[],
  pieceType: string | null,
  agentAuthored = true,
): LegalVocabulary {
  const byKey = new Map(registry.map((r) => [r.key, r]));
  const admits = (r: StoryBlockRow): boolean => {
    const types = r.piece_types ?? [];
    if (types.length === 0) return true;
    if (types.includes("ALL")) return true;
    if (agentAuthored && types.includes("AI")) return true;
    return pieceType != null && types.includes(pieceType);
  };

  const codes: string[] = [];
  const excluded: { code: string; reason: string }[] = [];

  for (const code of templateBlockKeys) {
    const row = byKey.get(code);
    if (!row) { excluded.push({ code, reason: "not in the block registry" }); continue; }
    if (row.status !== "active") { excluded.push({ code, reason: `status=${row.status}` }); continue; }
    if (!admits(row)) { excluded.push({ code, reason: `piece_types excludes ${pieceType ?? "(none)"}` }); continue; }
    if (!row.renderer_built) { excluded.push({ code, reason: "no renderer built" }); continue; }
    codes.push(code);
  }
  return { codes, excluded };
}

export type OutlineRejection =
  | { kind: "illegal_code"; code: string }
  | { kind: "unknown_binding"; code: string; objectId: string }
  | { kind: "missing_binding"; code: string }
  | { kind: "empty" }
  | { kind: "too_long"; n: number }
  | { kind: "duplicate_unique"; code: string; n: number }
  | { kind: "anchor_out_of_range"; code: string; after: number; paragraphs: number };

/**
 * Validate an outline BEFORE any fill call is made.
 *
 * Pass 2 costs one model call per block, so a bad outline should be caught while it is still
 * free. An out-of-set binding is treated exactly as draft.ts treats an invented citation — the
 * piece goes to a human — because a composer that may invent an object id defeats the entire
 * point of binding rather than typing.
 */
export function validateOutline(
  outline: OutlineEntry[],
  legalCodes: string[],
  allowedObjectIds: Set<string>,
  registry: StoryBlockRow[],
  paragraphCount: number,
  maxBlocks = 24,
): OutlineRejection[] {
  const out: OutlineRejection[] = [];
  if (outline.length === 0) return [{ kind: "empty" }];
  if (outline.length > maxBlocks) out.push({ kind: "too_long", n: outline.length });

  const legal = new Set(legalCodes);
  const byKey = new Map(registry.map((r) => [r.key, r]));

  // ONE PER PIECE, enforced where it is still free. The fit stage parses the identical prose
  // from the identical column; the difference is that here the piece has not yet paid for one
  // fill call per block.
  const counts = new Map<string, number>();
  for (const e of outline) counts.set(e.block_code, (counts.get(e.block_code) ?? 0) + 1);
  for (const [code, n] of counts) {
    if (n < 2) continue;
    const row = byKey.get(code);
    if ((row?.constraints ?? []).some((c) => /^ONE PER PIECE$/i.test(c.trim()))) {
      out.push({ kind: "duplicate_unique", code, n });
    }
  }

  for (const e of outline) {
    if (!legal.has(e.block_code)) { out.push({ kind: "illegal_code", code: e.block_code }); continue; }
    const row = byKey.get(e.block_code);
    if (e.binding_object_id && !allowedObjectIds.has(e.binding_object_id)) {
      out.push({ kind: "unknown_binding", code: e.block_code, objectId: e.binding_object_id });
      continue;
    }
    if (row?.requires_binding && !e.binding_object_id) {
      out.push({ kind: "missing_binding", code: e.block_code });
    }
    const after = e.after_paragraph;
    if (!Number.isInteger(after) || after < 0 || after > paragraphCount) {
      out.push({ kind: "anchor_out_of_range", code: e.block_code, after, paragraphs: paragraphCount });
    }
  }
  return out;
}

/** The JSON Schema for pass 1, built per piece so the enum is only this piece's legal codes. */
export function outlineSchema(legalCodes: string[], paragraphCount: number, maxBlocks = 24): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["blocks"],
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: maxBlocks,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["block_code", "one_line_intent"],
          properties: {
            block_code: { type: "string", enum: legalCodes },
            binding_object_id: {
              type: ["string", "null"],
              description: "A lake object id from CITABLE FACTS. Required where the block binds.",
            },
            one_line_intent: { type: "string", minLength: 8 },
            after_paragraph: {
              type: "integer",
              minimum: 0,
              maximum: paragraphCount,
              description:
                "The paragraph number this exhibit follows. 0 places it above the first paragraph. " +
                "The prose itself is kept verbatim — you are placing exhibits into an article, not replacing it.",
            },
          },
        },
      },
    },
  };
}


/* ── Splice ───────────────────────────────────────────────────────────────── */

/** A chassis block as it already exists on the draft: prose the composer must not touch. */
export interface ProseBlock {
  kind: string;
  body: unknown;
}

export interface FilledBlock {
  code: string;
  payload: unknown;
  boundObjectId: string | null;
  afterParagraph: number;
}

export type ComposedBlock =
  | { kind: "prose"; blockKind: string; body: unknown }
  | { kind: "design"; blockKind: string; body: unknown; boundObjectId: string | null };

/** Chassis kinds the draft writes. Anything else on a draft is a design block. */
export const CHASSIS_KINDS = new Set(["text", "heading", "pull_quote", "disclaimer"]);

/**
 * Interleave exhibits into prose, preserving both.
 *
 * Rules that are not negotiable:
 *   - every prose block survives, in its original order;
 *   - `disclaimer` is pinned last whatever the model asked for — it is a legal footer, and an
 *     exhibit below it reads as being covered by it;
 *   - exhibits anchored to the same paragraph keep their outline order, so the model's own
 *     reading-order intent survives the regrouping.
 */
export function spliceComposition(prose: ProseBlock[], filled: FilledBlock[]): ComposedBlock[] {
  const anchors = prose.filter((b) => b.kind !== "disclaimer");
  const footer = prose.filter((b) => b.kind === "disclaimer");
  const at = new Map<number, FilledBlock[]>();
  for (const f of filled) {
    const i = Math.max(0, Math.min(anchors.length, f.afterParagraph));
    (at.get(i) ?? at.set(i, []).get(i)!).push(f);
  }
  const design = (f: FilledBlock): ComposedBlock =>
    ({ kind: "design", blockKind: f.code, body: f.payload, boundObjectId: f.boundObjectId });

  const out: ComposedBlock[] = [];
  for (const f of at.get(0) ?? []) out.push(design(f));
  anchors.forEach((b, idx) => {
    out.push({ kind: "prose", blockKind: b.kind, body: b.body });
    for (const f of at.get(idx + 1) ?? []) out.push(design(f));
  });
  for (const b of footer) out.push({ kind: "prose", blockKind: b.kind, body: b.body });
  return out;
}

/**
 * PD.3 — the block payload schemas, indexed by block code.
 *
 * **Zod is the source of truth; `ops.story_blocks.payload_schema` is the projection.** These
 * schemas are authored once here, emitted to JSON Schema with Zod 4's native `z.toJSONSchema()`
 * (not `zod-to-json-schema`, unmaintained since Nov 2025), and written into the registry by
 * `scripts/design/generate-block-schemas.mjs`. The same JSON Schema goes to the provider for
 * constrained generation, so what the model is allowed to emit, what the DB says is legal, and what
 * TypeScript parses are one artefact rather than three that drift.
 *
 * The record is typed `Record<BlockCode, ZodType>`, so a block added to `codes.ts` without a schema
 * is a compile error rather than a runtime hole at 3am.
 *
 * @see docs/BRIDGE-BUILD-PLAN.md §PD.3
 * @see docs/architecture/09-signal-to-article.md §5.5
 */
import type { z } from "zod";

import * as A from "./a-inline.js";
import * as B from "./b-statement.js";
import * as C from "./c-tabular.js";
import * as D from "./d-charts.js";
import * as E from "./e-mechanism.js";
import * as F from "./f-wire.js";
import * as G from "./g-provenance.js";
import * as H from "./h-gates.js";
import { BLOCK_CODES, type BlockCode } from "./codes.js";

export { BLOCK_CODES, isBlockCode, familyOf } from "./codes.js";
export type { BlockCode, BlockFamily } from "./codes.js";
export { ObjectBinding, ObjectRef, ChartSeries, ChartEmphasis, Polarity, VenueCode, RuleId } from "./binding.js";
export { CHART_SHAPES, ChartShape, SHAPE_BY_BLOCK, CHART_QUESTION_BY_SHAPE } from "./d-charts.js";

/**
 * Every active block code → the schema its payload must satisfy.
 *
 * The 8 `status='legacy'` keys are deliberately absent: the design splits the coarse ones
 * (BLK-CHART became 15 shapes), so they have no payload contract to state and the publisher
 * refuses them rather than guessing one.
 */
export const BLOCK_PAYLOAD_SCHEMAS = {
  // A · Inline
  "BLK-TICKER": A.BLK_TICKER,
  "BLK-DELTA": A.BLK_DELTA,
  "BLK-CITE": A.BLK_CITE,
  "BLK-TERM": A.BLK_TERM,
  "BLK-SPARK": A.BLK_SPARK,
  "BLK-MARGIN": A.BLK_MARGIN,
  // B · Statement
  "BLK-THESIS": B.BLK_THESIS,
  "BLK-PULLQUOTE": B.BLK_PULLQUOTE,
  "BLK-BIGNUM": B.BLK_BIGNUM,
  "BLK-VERDICT": B.BLK_VERDICT,
  "BLK-TAKE": B.BLK_TAKE,
  "BLK-FALSIFY": B.BLK_FALSIFY,
  // C · Tabular
  "BLK-STATSTRIP": C.BLK_STATSTRIP,
  "BLK-KEYSTATS": C.BLK_KEYSTATS,
  "BLK-FINTABLE": C.BLK_FINTABLE,
  "BLK-SCENARIO": C.BLK_SCENARIO,
  "BLK-RANKROW": C.BLK_RANKROW,
  "BLK-BEATMISS": C.BLK_BEATMISS,
  "BLK-EXDATE": C.BLK_EXDATE,
  "BLK-COMPARE": C.BLK_COMPARE,
  // D · Charts
  "BLK-LINE": D.BLK_LINE,
  "BLK-AREA": D.BLK_AREA,
  "BLK-BARS": D.BLK_BARS,
  "BLK-STACK": D.BLK_STACK,
  "BLK-WATERFALL": D.BLK_WATERFALL,
  "BLK-SCATTER": D.BLK_SCATTER,
  "BLK-DIST": D.BLK_DIST,
  "BLK-DUMBBELL": D.BLK_DUMBBELL,
  "BLK-SLOPE": D.BLK_SLOPE,
  "BLK-RANGE": D.BLK_RANGE,
  "BLK-HEAT": D.BLK_HEAT,
  "BLK-INDEXED": D.BLK_INDEXED,
  "BLK-DONUT": D.BLK_DONUT,
  "BLK-COVER": D.BLK_COVER,
  "BLK-CANDLE": D.BLK_CANDLE,
  // E · Mechanism
  "BLK-TIMELINE": E.BLK_TIMELINE,
  "BLK-STEPS": E.BLK_STEPS,
  "BLK-FLOW": E.BLK_FLOW,
  "BLK-ANATOMY": E.BLK_ANATOMY,
  "BLK-WORKED": E.BLK_WORKED,
  "BLK-MYTH": E.BLK_MYTH,
  "BLK-DECISION": E.BLK_DECISION,
  "BLK-GLOSSARY": E.BLK_GLOSSARY,
  // F · Wire & live state
  "BLK-TAPEROW": F.BLK_TAPEROW,
  "BLK-CHIPROW": F.BLK_CHIPROW,
  "BLK-SNAPSHOT": F.BLK_SNAPSHOT,
  "BLK-COUNTDOWN": F.BLK_COUNTDOWN,
  "BLK-HALT": F.BLK_HALT,
  "BLK-CORRECTION": F.BLK_CORRECTION,
  "BLK-BREADTH": F.BLK_BREADTH,
  "BLK-VENUEHEAD": F.BLK_VENUEHEAD,
  // G · Provenance & trust
  "BLK-PROV": G.BLK_PROV,
  "BLK-AGENTS": G.BLK_AGENTS,
  "BLK-FRESH": G.BLK_FRESH,
  "BLK-ESTIMATE": G.BLK_ESTIMATE,
  "BLK-CONFLICT": G.BLK_CONFLICT,
  "BLK-RULE": G.BLK_RULE,
  // H · Gates & CTAs
  "BLK-CUT": H.BLK_CUT,
  "BLK-PAYWALL": H.BLK_PAYWALL,
  "BLK-ALERTCTA": H.BLK_ALERTCTA,
  "BLK-DOWNLOAD": H.BLK_DOWNLOAD,
} as const satisfies Record<BlockCode, z.ZodType>;

/** The payload type a given block code parses to. */
export type BlockPayload<K extends BlockCode> = z.infer<(typeof BLOCK_PAYLOAD_SCHEMAS)[K]>;

/**
 * Blocks whose `ops.story_blocks.requires_binding` is `true` but whose payload carries **no**
 * `{object_id, field}` binding — because their binding target is not `lake.objects`.
 *
 * Recorded here so the generator's assertion and the test can treat them as decisions rather than
 * as gaps, and so a reviewer can see the whole list at once instead of hunting four files:
 *
 * - `BLK-TERM` — binds the glossary store shared with Learn, keyed by a slug.
 * - `BLK-GLOSSARY` — auto-assembled from the page's BLK-TERM instances; no writer payload at all.
 * - `BLK-RULE` — binds `ops.rules.rule_key`, a text key.
 * - `BLK-PAYWALL` — binds the free-read meter, which is per-request reader state.
 */
export const BLOCK_BINDING_EXCEPTIONS = {
  "BLK-TERM": "binds the shared glossary store by slug, not a lake object",
  "BLK-GLOSSARY": "auto-assembled from the page's BLK-TERM instances — no writer payload",
  "BLK-RULE": "binds `ops.rules.rule_key`, a text key rather than a lake object",
  "BLK-PAYWALL": "binds the free-read meter, which is per-request reader state",
} as const satisfies Partial<Record<BlockCode, string>>;

/**
 * Blocks where this schema requires a binding even though the seeded registry row says
 * `requires_binding = false`.
 *
 * Both are charts. The seed derives `requires_binding` from "`binds_to` is set, or the block is in
 * family C/D" (`scripts/design/generate-registry-seed.mjs`), which is a good heuristic that does
 * not reach a chart sitting outside family D. D-8 does: emitting a series of numbers is the exact
 * failure §5.6 calls the one that matters — a schema-valid exhibit with fabricated data, worse than
 * a parse error because it passes.
 *
 * Flipping the two registry rows to `true` is a registry decision, not a schema one, so it is
 * recorded here rather than done quietly.
 */
export const BLOCK_BINDING_STRICTER_THAN_REGISTRY = {
  "BLK-SPARK": "a ≤30-point numeric series must not be typed by an agent (D-8)",
  "BLK-SNAPSHOT": "the wire's only permitted chart — its bar series must not be typed by an agent (D-8)",
} as const satisfies Partial<Record<BlockCode, string>>;

/**
 * Does an emitted JSON Schema carry a lake-object binding anywhere inside it?
 *
 * Structural, not name-based: it looks for an object type whose `properties` include `object_id`,
 * which is what ObjectBinding, ObjectRef, ChartSeries and ChartEmphasis all reduce to once inlined.
 * A renamed primitive therefore cannot make a block look unbound, and a payload field that merely
 * *mentions* `object_id` in a `required` array cannot make one look bound.
 *
 * `scripts/design/generate-block-schemas.mjs` uses this to compute the bound set, and the migration
 * it emits asserts the same predicate in SQL as
 * `jsonb_path_exists(payload_schema, '$.**.properties.object_id')`.
 */
export function carriesObjectBinding(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(carriesObjectBinding);
  if (schema === null || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  const props = node.properties;
  if (props !== null && typeof props === "object" && Object.hasOwn(props, "object_id")) return true;
  return Object.values(node).some(carriesObjectBinding);
}

/** The schema for a block code, or `undefined` for a legacy or unknown code. */
export function blockPayloadSchema(code: string): z.ZodType | undefined {
  return (BLOCK_PAYLOAD_SCHEMAS as Record<string, z.ZodType>)[code];
}

/**
 * Parse an untrusted payload against its block's schema.
 *
 * Returns a discriminated result rather than throwing: the fit stage refuses with the offending
 * code as evidence (§6), so it needs the code and the issues, not a stack trace. An unknown code is
 * a refusal too — "no agent may invent a new block".
 */
export function safeParseBlockPayload(
  code: string,
  payload: unknown,
):
  | { ok: true; code: BlockCode; data: unknown }
  | { ok: false; code: string; error: string } {
  const schema = blockPayloadSchema(code);
  if (!schema) {
    return {
      ok: false,
      code,
      error: `${code} is not one of the ${BLOCK_CODES.length} active block codes — no agent may invent a new block`,
    };
  }
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, code: code as BlockCode, data: result.data };
  return {
    ok: false,
    code,
    error: `${code}: ${result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"} — ${issue.message}`)
      .join("; ")}`,
  };
}

/**
 * PD.3 — the D-8 primitives. **A writer agent emits a binding, never a number.**
 *
 * D-8 (`docs/BRIDGE-BUILD-PLAN.md` §Decisions) is the load-bearing decision of the whole design:
 * the writer emits `{block_code, object_id, field}` and the renderer reads the value out of
 * `lake.objects` at render time. That makes a fabricated figure *structurally impossible* rather
 * than statistically unlikely, and it makes R-07 corrections work by construction — fix the object
 * once and every citing piece updates.
 *
 * Two shapes, and the difference matters:
 *
 * - {@link ObjectBinding} — `{object_id, field}`. Use wherever the payload field is a **datum**:
 *   a value that will be printed as a number, a date, a percentage. The renderer resolves it.
 * - {@link ObjectRef} — `{object_id}` alone. Use where the card names an **object, not a datum**:
 *   a citation target, a provenance stamp, a downloadable series. There is no field to read
 *   because the block renders the object's identity and lineage, not one of its values.
 *
 * Everything else — prose, labels, kickers, editorial judgements like "which of these is best" —
 * stays literal. A binding for a label would be theatre; a literal for a datum is a licence to
 * hallucinate.
 *
 * None of these primitives is registered with an `id`, and that is deliberate: an id makes
 * `z.toJSONSchema()` hoist the shape into `$defs` and leave a `$ref` behind. Inlining costs about
 * 1% in stored bytes (measured over all 61) and buys a schema that any consumer can walk with
 * `properties`/`required` alone — including `worker/src/handlers/newsroom/fit-engine.ts`, whose
 * validator does not resolve `$ref` and would otherwise skip every binding check silently. The
 * binding rule is the one thing that must not be silently skipped.
 *
 * @see docs/architecture/09-signal-to-article.md §5.5
 */
import { z } from "zod";

import type { BlockCode } from "./codes";

/**
 * `lake.objects.id` is a uuid (verified against the live schema 2026-07-27). Nothing else may
 * appear here — an agent that emits a natural key, a ticker or a URL is refused at parse.
 */
const objectId = z
  .uuid()
  .describe("`lake.objects.id` — the object the renderer resolves this value from.");

/**
 * Which value on the object to read. `lake.objects` carries scalars in columns (`numeric_value`,
 * `effective_date`, `unit`) and everything else under `payload` jsonb, so a field is a dotted
 * path: `numeric_value`, `payload.revenue`, `payload.segments.chemicals`.
 */
const objectField = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/,
    "field must be a dotted path into the lake object, e.g. `numeric_value` or `payload.revenue`",
  )
  .describe(
    "Dotted path to the value on the lake object — `numeric_value`, `effective_date`, `payload.<key>`.",
  );

/**
 * A resolvable datum. **This is what a writer emits instead of a number.**
 */
export const ObjectBinding = z
  .strictObject({ object_id: objectId, field: objectField })
  .meta({
    title: "Lake object binding",
    description:
      "D-8: a bound datum. The writer names the object and the field; the renderer reads the value at render time. Emitting a literal number here is a refusal.",
  });

export type ObjectBinding = z.infer<typeof ObjectBinding>;

/**
 * A reference to an object as an object — for citations, provenance stamps and downloads, where
 * the block renders the object's *identity* rather than one of its values.
 */
export const ObjectRef = z.strictObject({ object_id: objectId }).meta({
  title: "Lake object reference",
  description:
    "A lake object referenced as an object, not as a datum — its lineage, coverage, verifying agent and status are read from the row, never asserted by the writer.",
});

export type ObjectRef = z.infer<typeof ObjectRef>;

/**
 * A chart series entry, per §5.5's chart body: `{object_id, field, label}` — a binding plus the
 * label the legend prints. Its own name because PD.6's compiler consumes it as *the* series
 * contract.
 */
export const ChartSeries = z
  .strictObject({
    label: z.string().min(1).describe("Legend label for this series."),
    object_id: objectId,
    field: objectField,
  })
  .meta({
    title: "Chart series binding",
    description:
      "One resolvable series in a D-family exhibit. The agent never emits data points — PD.6's compiler resolves the binding and produces the Vega-Lite spec.",
  });

export type ChartSeries = z.infer<typeof ChartSeries>;

/**
 * Which series (or point) the prose is about. Optional on every chart: an exhibit that emphasises
 * nothing is legal, an exhibit that emphasises something must say *why* — the reason is what the
 * renderer prints, and what a reviewer checks the prose against.
 */
export const ChartEmphasis = z
  .strictObject({
    reason: z
      .string()
      .min(1)
      .describe("Why this series carries the argument. Printed, and checked against the prose."),
    object_id: objectId,
    field: objectField.optional(),
  })
  .meta({
    title: "Chart emphasis",
    description: "The one series or point the surrounding prose is about.",
  });

export type ChartEmphasis = z.infer<typeof ChartEmphasis>;

// ── literal vocabularies ─────────────────────────────────────────────────────────────────────────

/**
 * Whether a change is *good or bad*, which is not the same thing as whether it went up or down.
 * BLK-DELTA's card: "ARROW IS SEMANTIC, NOT LITERAL — A FALLING COST OF FUNDS IS GREEN". The arrow
 * follows the arithmetic; the colour follows the meaning. Two fields is the only way to encode a
 * rule that says they may disagree. (Direction itself lives in `src/lib/contracts/common.ts` —
 * it is a render concern, and no payload asserts it: it is read off the resolved value.)
 */
export const Polarity = z.enum(["good", "bad"]);

/** `public.venues.code`, verified against the live table 2026-07-27. */
export const VenueCode = z.enum(["TDWL", "ADX", "DFM", "QE", "MSX", "BHB", "BK"]);

/**
 * A publishing-ruleset id. Deliberately a pattern rather than an enum over today's R-01…R-10:
 * `ops.rules.rule_key` grows, and a schema that goes stale the day R-11 lands would make the
 * newsroom refuse correct copy. The fit stage resolves the id against `ops.rules` for real.
 */
export const RuleId = z
  .string()
  .regex(/^R-\d{2}$/)
  .describe("Publishing-ruleset id, resolved against `ops.rules.rule_key` at the fit stage.");

/**
 * A fixed label the house owns — kickers, column headers, the `.xlsx` extension. Pinned to a
 * literal so a writer agent cannot reword the furniture, and defaulted so it need not be emitted
 * at all. These are the fields the design cards list as "required payload" but which are really
 * chrome: the design decides them once, not per piece.
 */
export const houseLabel = (text: string) =>
  z
    .literal(text)
    .default(text)
    .describe(`Fixed house label — pinned to "${text}" so a writer agent cannot reword it.`);

/**
 * A row of fixed column headers — the tabular equivalent of {@link houseLabel}. The design cards
 * list column headers among the "required payload fields", but a table whose headers a writer may
 * rename is not a table with a contract, so each one is pinned to a literal and the whole row is
 * defaulted.
 */
export function houseHeaders<const T extends readonly [string, ...string[]]>(...texts: T) {
  const members = texts.map((t) => z.literal(t)) as unknown as {
    -readonly [K in keyof T]: z.ZodLiteral<T[K]>;
  };
  const headers = z.tuple(members);
  return headers
    .default(texts as unknown as z.output<typeof headers>)
    .describe("Fixed column headers — pinned so a writer agent cannot rename a column.");
}

/** One or more sentences of writer prose. */
export const prose = (description: string) => z.string().min(1).describe(description);

/**
 * A body capped at `max` whitespace-separated words. Expressed as a regex rather than a refinement
 * on purpose: a pattern survives `z.toJSONSchema()`, so the *provider* enforces the cap during
 * constrained generation instead of us discovering the overrun after the tokens are paid for.
 */
export const wordCapped = (max: number, description: string) =>
  z
    .string()
    .regex(
      new RegExp(`^\\s*(?:\\S+\\s+){0,${max - 1}}\\S+\\s*$`),
      `must be at most ${max} words`,
    )
    .describe(`${description} Max ${max} words.`);

// ── the block-schema constructor ─────────────────────────────────────────────────────────────────

/**
 * The context a cross-field check receives: the parsed value, and the issue list to push onto.
 * Narrower than Zod's internal payload type on purpose — a check here only ever raises `custom`
 * issues, and naming its own shape keeps the call sites readable.
 */
export interface BlockCheckContext<T> {
  readonly value: T;
  readonly issues: Array<{
    code: "custom";
    input: unknown;
    path?: PropertyKey[];
    message: string;
  }>;
}

/**
 * Build a block payload schema.
 *
 * - **strict**, always: an unknown key is a refusal. The publishing agent does not degrade and does
 *   not invent a fallback (§6), so neither does the parser. It also gives us
 *   `additionalProperties: false`, which the structured-output providers require.
 * - **named by its block code**: `.meta()` puts the code in the emitted JSON Schema's `title`, so a
 *   provider-side validation error, a stored `payload_schema` and a `ZodError` all say
 *   `BLK-WATERFALL · Bridge` rather than "object".
 * - **cross-field checks are a parameter, not a chained `.check()`**, because `.check()` clones the
 *   schema and the clone is not the instance the metadata registry holds — chaining it after
 *   `.meta()` silently drops the block's own name from the emitted schema. Passing the check in
 *   keeps `.meta()` last, where it has to be.
 *
 * A check raises issues that JSON Schema cannot express (exactly one base scenario, the human last
 * in the chain, one value per period column). The provider therefore cannot enforce them during
 * generation — but the fit stage's `safeParse` does, which is where a refusal belongs anyway.
 */
export function blockSchema<T extends Record<string, z.ZodType>>(
  code: BlockCode,
  name: string,
  description: string,
  shape: T,
  check?: (ctx: BlockCheckContext<z.infer<z.ZodObject<T>>>) => void,
) {
  const object = z.strictObject(shape);
  const validated = check
    ? object.check(check as unknown as Parameters<typeof object.check>[0])
    : object;
  return validated.meta({ id: code, title: `${code} · ${name}`, description });
}

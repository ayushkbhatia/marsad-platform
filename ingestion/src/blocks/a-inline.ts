/**
 * PD.3 — family A · Inline & sentence-level (6 blocks).
 *
 * "Units that live inside a sentence… No block borders, no vertical margin — they must not break
 * the line rhythm." Every one of these carries a `host_*` field, because an inline block without
 * its host sentence cannot be placed, and the numeric-consistency check (§5.6) needs the sentence
 * to compare the prose numerals against.
 *
 * Literal-vs-binding calls made here:
 * - **BLK-TICKER** — the card lists `change_pct` and `direction` as payload. Under D-8 they cannot
 *   be: they are a live `market.quote`. Both collapse into the quote binding.
 * - **BLK-CITE** — cites an object, not a datum, so {@link ObjectRef} rather than ObjectBinding.
 * - **BLK-TERM** — its binding target is the glossary store, keyed by a string, not `lake.objects`.
 * - **BLK-SPARK** — the registry says `requires_binding=false`, but the payload is a *series of
 *   real numbers*; see the note on the block below.
 * - **BLK-MARGIN** — "AUTHORED, NOT BOUND — the one A-family block with no data binding".
 */
import { z } from "zod";

import {
  ObjectBinding,
  ObjectRef,
  Polarity,
  blockSchema,
  prose,
} from "./binding.js";

/**
 * BLK-TICKER · Inline instrument chip — `requires_binding`, binds `market.quote (live)`.
 *
 * The card asks for `change_pct with sign`, `direction` and a `quote-card payload for hover`.
 * None of those may be writer-emitted: they are the live quote, and a chip that prints a number
 * the writer typed is exactly the failure D-8 exists to prevent. All three resolve from `quote`,
 * which is why this schema is shorter than its card — the card describes what *renders*, and the
 * renderer reads it.
 */
export const BLK_TICKER = blockSchema(
  "BLK-TICKER",
  "Inline instrument chip",
  "First mention of a listed name. The chip's change and direction, and the hover quote card, all resolve from the bound live quote — the writer supplies only the ticker and the sentence it sits in.",
  {
    host_sentence: prose("The sentence the chip is embedded in."),
    ticker_code: z
      .string()
      .min(1)
      .describe("Exchange ticker as printed, e.g. `2222`. An identifier, not a datum."),
    quote: ObjectBinding.describe(
      "The live `market.quote` object and the change field. Drives the printed change, the green/red direction and the hover card.",
    ),
  },
);

/**
 * BLK-DELTA · Sentence delta — unbound.
 *
 * `arrow` and `polarity` are separate fields because the card's hard rule says they can disagree:
 * "A FALLING COST OF FUNDS IS GREEN". The renderer owns the glyph — the payload carries the
 * direction, not the ▲/▼ character, so the design can change the glyph without a data migration.
 */
export const BLK_DELTA = blockSchema(
  "BLK-DELTA",
  "Sentence delta",
  "A change the reader should feel, lifted out of the serif. The arrow follows the arithmetic; the colour follows the meaning — they are separate fields because they are allowed to disagree.",
  {
    host_sentence: prose("The sentence the delta is embedded in."),
    magnitude: z
      .string()
      .min(1)
      .describe("Magnitude with its unit, as printed — e.g. `110 bp`, `1.4pp`, `SAR 2.1bn`."),
    arrow: z
      .enum(["up", "down"])
      .describe("Literal direction of the change. Renderer prints ▲ / ▼."),
    polarity: Polarity.describe(
      "Whether the change is good or bad for the subject — this, not the arrow, picks green or red.",
    ),
  },
);

/**
 * BLK-CITE · Citation chip — `requires_binding`, binds `lake.object.id`, rule **R-03**.
 *
 * Mandatory on every AI factual claim. The marker's target is an object, not a value, so it takes
 * an {@link ObjectRef}: the chip resolves back to the object, it does not print one of its fields.
 * `source_label` stays literal — "FY25 annual report, p.47" is a human-readable locator the writer
 * composes; it is checkable against the object at the fit stage, not derivable from it.
 */
export const BLK_CITE = blockSchema(
  "BLK-CITE",
  "Citation chip",
  "Mandatory on every AI factual claim (R-03). Each numbered marker resolves back to a lake object; the footnote list renders under the paragraph.",
  {
    host_claim: prose("The claim sentence the markers annotate."),
    markers: z
      .array(
        z.strictObject({
          index: z.int().min(1).describe("Marker number as printed, 1-based."),
          object: ObjectRef.describe("The cited lake object."),
          source_label: z
            .string()
            .min(1)
            .describe("Human-readable locator, e.g. `FY25 annual report, p.47`."),
          source_kind: z
            .enum(["filing", "desk_model"])
            .describe(
              "Filed disclosure or desk computation. Drives whether the footnote reads as a source or as our own work.",
            ),
        }),
      )
      .min(1)
      .describe("One entry per marker, in the order they appear in the claim."),
    rule_id: z.literal("R-03").default("R-03"),
  },
);

/**
 * BLK-TERM · Defined term — `requires_binding`, binds `glossary.term`.
 *
 * **Judgement call.** This block is `requires_binding=true` but its binding target is the glossary
 * store shared with Learn, not `lake.objects` — so the binding is a string key, not a uuid. Forcing
 * an `ObjectBinding` here would be a lie about where the data lives.
 *
 * `definition` stays required because the card requires it, but note the tension: BLK-GLOSSARY's
 * card says definitions "must be single-sourced" with Learn. If the glossary store becomes
 * authoritative, this field should become resolved rather than authored.
 */
export const BLK_TERM = blockSchema(
  "BLK-TERM",
  "Defined term",
  "First use of a term only. Binds the shared glossary store by key — the one A-family binding that is not a lake object. Feeds BLK-GLOSSARY.",
  {
    host_sentence: prose("The sentence the term first appears in."),
    term: z.string().min(1).describe("The term exactly as it appears in prose."),
    glossary_key: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "glossary keys are lowercase slugs")
      .describe("Key into the glossary store shared with Learn."),
    term_label: z
      .string()
      .min(1)
      .describe("Tooltip header label (rendered uppercase mono)."),
    definition: prose("The definition, one or two sentences."),
  },
);

/**
 * BLK-SPARK · Inline sparkline — registry says unbound; **this schema binds it anyway**.
 *
 * The card's payload is "one numeric series, ≤ 30 points". Thirty literal numbers from a language
 * model is precisely the failure §5.6 calls the one that matters — "confident hallucination in
 * valid syntax", a schema-valid exhibit with fabricated data, worse than a parse error because it
 * passes. The seed's `requires_binding` heuristic (`binds_to` set, or family C/D) simply does not
 * reach an A-family chart. D-8 does.
 *
 * The ≤30-point cap is a property of the *resolved* series, so it cannot live in this schema; the
 * chart compiler and the fit stage enforce it. Flagged for the registry row to be corrected.
 */
export const BLK_SPARK = blockSchema(
  "BLK-SPARK",
  "Inline sparkline",
  "Direction without magnitude. No axes, no labels, no tooltip — if it needs a number it is not a sparkline. The series is bound, never enumerated: max 30 points, enforced on the resolved series.",
  {
    host_sentence: prose("The sentence the sparkline is embedded in."),
    series: ObjectBinding.describe(
      "The numeric series to draw. Resolved to at most 30 points; x spacing is implied and even.",
    ),
  },
);

/**
 * BLK-MARGIN · Margin note — unbound, and explicitly so.
 *
 * "AUTHORED, NOT BOUND — the one A-family block with no data binding" and "Never load-bearing: the
 * argument must survive the reader skipping it". Nothing here is a datum, so nothing here binds.
 */
export const BLK_MARGIN = blockSchema(
  "BLK-MARGIN",
  "Margin note",
  "Context a reader may skip. Authored, not bound — and never load-bearing: the argument must survive the reader skipping it.",
  {
    host_paragraph: prose("The paragraph the note annotates; the note aligns to it in the gutter."),
    label: z
      .string()
      .min(1)
      .default("NOTE")
      .describe("Gutter label. Defaults to `NOTE`."),
    body: prose("The note, one or two sentences."),
  },
);

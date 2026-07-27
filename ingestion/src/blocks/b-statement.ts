/**
 * PD.3 — family B · Statement blocks (6 blocks).
 *
 * "Where the desk commits to a view… Each one takes a position — so each one is rules-checked and
 * attributable to a human." Five of the six are `requires_binding=false` and that is correct: a
 * thesis, a quote, a rating and a falsifier are *judgements*, not data. The exception is
 * BLK-BIGNUM, which is the one figure the headline rests on and therefore the one figure in the
 * piece that absolutely may not be typed by an agent.
 */
import { z } from "zod";

import { ObjectBinding, blockSchema, houseLabel, prose } from "./binding";

/**
 * BLK-THESIS · Argument in three lines — unbound.
 *
 * "EXACTLY THREE LINES — not two, not four" is the whole block, and `.length(3)` carries it all the
 * way into the emitted JSON Schema (`minItems: 3, maxItems: 3`), so the provider enforces it during
 * generation rather than us rejecting a finished draft.
 */
export const BLK_THESIS = blockSchema(
  "BLK-THESIS",
  "Argument in three lines",
  "Sits above paragraph one. Exactly three claims, each independently checkable against a lake object — that checkability is what the fit stage's numeric-consistency pass verifies.",
  {
    kicker: houseLabel("THE ARGUMENT IN THREE LINES"),
    claims: z
      .array(prose("One claim, independently verifiable against a lake object."))
      .length(3)
      .describe("Exactly three. Not two, not four."),
  },
);

/**
 * BLK-PULLQUOTE · Pull quote — unbound.
 *
 * "Must be a human voice — never a restated statistic" is not expressible in JSON Schema (it is a
 * judgement about what the sentence *is*), so it is a fit-stage lint, stated here in the
 * description so it also reaches the model. "ONE PER 1,500 WORDS" is a property of the piece, not
 * of this payload — the fit stage counts.
 */
export const BLK_PULLQUOTE = blockSchema(
  "BLK-PULLQUOTE",
  "Pull quote",
  "A human voice, never a restated statistic. One per 1,500 words — the fit stage counts them across the piece.",
  {
    quote: prose("The quoted sentence, without surrounding quotation marks (the renderer adds them)."),
    attribution: z
      .string()
      .min(1)
      .describe("Speaker role or desk, e.g. `MARSAD DESK`. Rendered uppercase mono, em-dash prefixed."),
  },
);

/**
 * BLK-BIGNUM · The number that matters — `requires_binding`.
 *
 * "ONE PER PIECE · THE FIGURE THE HEADLINE RESTS ON · ONE LAKE FIELD, NOT AN AGGREGATE." The last
 * clause is why `value` is a single {@link ObjectBinding} and not a list or a computation: the
 * binding shape itself forbids the aggregate.
 *
 * `context_line` ("prior value + change") stays literal prose. It contains numerals, so it is
 * covered by R-03/R-04 and the fit stage's numeric-consistency check rather than by a binding —
 * the same treatment every inline numeral in the piece gets.
 */
export const BLK_BIGNUM = blockSchema(
  "BLK-BIGNUM",
  "The number that matters",
  "One per piece: the figure the headline rests on. Bound to ONE lake field — never an aggregate, which the single-binding shape enforces structurally.",
  {
    caption: prose("What the figure is, naming the entity and the period."),
    context_line: prose(
      "Prior value and change, as prose. Numerals here are checked against the citations by the numeric-consistency pass.",
    ),
    value: ObjectBinding.describe("The single lake field the headline rests on."),
  },
);

/**
 * BLK-VERDICT · Rating card — unbound, and correctly so: a rating is the desk's call, not a datum
 * in the lake.
 *
 * "MUST NAME THE PRIOR RATING" becomes a required field — the one part of this card that is
 * machine-checkable, and the part editors most often drop. `target_price` and `upside_pct` are
 * numbers rather than bindings for the same reason as the rating: they are this note's own output.
 * When the desk-computation object family lands (PE.3) they become candidates for binding.
 */
export const BLK_VERDICT = blockSchema(
  "BLK-VERDICT",
  "Rating card",
  "Only on pieces with a formal call, never on wires. Must name the prior rating — that is the field this schema makes non-optional.",
  {
    ticker: z.string().min(1).describe("Subject ticker."),
    company_name: z.string().min(1).describe("Company name as printed."),
    rating: z.string().min(1).describe("The new rating, e.g. `Overweight`."),
    prior_rating: z
      .string()
      .min(1)
      .describe("The rating this replaces, e.g. `Neutral`. Mandatory — a call without a prior is not a call."),
    target_price: z.number().describe("Price target, in the security's local currency."),
    upside_pct: z.number().describe("Implied upside to target, in percent. Signed."),
    changed_in_this_note: z
      .boolean()
      .describe("True when this note is what changed the rating, as opposed to reiterating it."),
  },
);

/**
 * BLK-TAKE · Marsad Take · gated — unbound, gating.
 *
 * The blur, the pointer-events and the user-select are renderer concerns; the payload carries only
 * the judgement and the entitlement it sits behind. `entitlement` is an enum because the gate has
 * exactly two answers at render time and a third value would silently unlock premium copy.
 */
export const BLK_TAKE = blockSchema(
  "BLK-TAKE",
  "Marsad Take · gated",
  "The desk's judgement, blurred until unlocked. The headline stays readable; the judgement does not.",
  {
    headline: prose("The judgement itself — e.g. fair value plus the action it implies."),
    body: prose("One supporting sentence."),
    badge: houseLabel("PREMIUM"),
    unlock_cta_label: houseLabel("Unlock the take →"),
    entitlement: z
      .enum(["locked", "unlocked"])
      .describe("Entitlement state at render time. Two values only — a third would unlock premium copy by accident."),
  },
);

/**
 * BLK-FALSIFY · What would change this view — unbound.
 *
 * Note the deliberate asymmetry with BLK-THESIS: that card says "EXACTLY THREE LINES" and this one
 * says "3 in the specimen". So thesis gets `.length(3)` and falsifiers get `.min(1)` — the design
 * stated one as a rule and the other as an example, and reading an example as a rule would make
 * the newsroom refuse legitimate copy.
 */
export const BLK_FALSIFY = blockSchema(
  "BLK-FALSIFY",
  "What would change this view",
  "Required on any piece with a view. Each item must be an observable event or a threshold — falsifiability is the feature, not a disclaimer.",
  {
    kicker: houseLabel("WHAT WOULD CHANGE THIS VIEW"),
    falsifiers: z
      .array(prose("An observable, checkable event or threshold — never a sentiment."))
      .min(1)
      .describe("The specimen carries three; the card states no fixed count, so none is imposed."),
  },
);

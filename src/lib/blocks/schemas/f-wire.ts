/**
 * PD.3 — family F · Wire & live state (8 blocks).
 *
 * "Timestamped, perishable, and honest about being stale. Every block here carries a clock."
 *
 * Two blocks bind (BLK-CORRECTION, BLK-VENUEHEAD) and six do not. The six are wire copy — a halt
 * notice, a countdown, a chip row — where the figures are quoted in a sentence the desk publishes
 * within minutes, and R-03/R-04 plus the numeric-consistency check are the design's stated cover
 * for prose numerals. One exception is made, BLK-SNAPSHOT, for the same reason as BLK-SPARK: it is
 * a chart, and a chart's data may not be typed.
 *
 * Timestamps are ISO instants with an offset, not the `HH:MM` the cards print. A wire block stores
 * *when*, and the renderer decides how to say it — a bare `HH:MM` with no date is a bug waiting for
 * a midnight rollover, and the design's own freshness machine needs an instant to decay against.
 */
import { z } from "zod";

import {
  ObjectBinding,
  ObjectRef,
  VenueCode,
  blockSchema,
  houseLabel,
  prose,
  wordCapped,
} from "./binding";

/**
 * BLK-TAPEROW · Tape entry.
 *
 * "MAX 40 WORDS FOR AGENT AUTO-PUBLISH" is the one hard cap in this family and it is expressed as a
 * regex, not a refinement — a pattern survives into the emitted JSON Schema, so the provider
 * enforces the cap while generating instead of us paying for an overrun and rejecting it.
 */
export const BLK_TAPEROW = blockSchema(
  "BLK-TAPEROW",
  "Tape entry",
  "One item on the tape. Time in the gutter, venue under it. The body is capped at 40 words — that cap is what makes the item eligible for agent auto-publish.",
  {
    at: z.iso.datetime({ offset: true }).describe("When the item happened. The renderer prints HH:MM in venue time."),
    venue: VenueCode,
    category: z
      .string()
      .min(1)
      .describe("Category chip, e.g. `DIVIDEND`, `RESULTS`. Rendered uppercase."),
    ticker: z.string().min(1),
    filing_reference: z.string().min(1).describe("Filing reference, e.g. `CG-1`."),
    headline: prose("The headline, set in serif."),
    body: wordCapped(40, "The item body."),
  },
);

/**
 * BLK-CHIPROW · Data chip row.
 *
 * "3–5 CHIPS" → bounded. "THE MOVING NUMBER GETS THE INK BORDER · CONTEXT CHIPS STAY GREY" is
 * singular, so at most one chip may be moving — checked, because a row where everything moves is a
 * row that emphasises nothing. `direction` is required exactly when `is_moving` is true, and
 * forbidden otherwise; a context chip has no direction to colour.
 */
export const BLK_CHIPROW = blockSchema(
  "BLK-CHIPROW",
  "Data chip row",
  "Three to five chips — the cheapest way to attach data to a 30-word item. At most one chip is the moving number; the rest are context and stay grey.",
  {
    chips: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Chip label."),
          value: z.string().min(1).describe("Chip value, as printed."),
          is_moving: z
            .boolean()
            .default(false)
            .describe("The one chip that is the moving number. It takes the ink border."),
          direction: z
            .enum(["up", "down"])
            .optional()
            .describe("Required on the moving chip, forbidden on context chips."),
        }),
      )
      .min(3)
      .max(5),
  },
  (ctx) => {
    const moving = ctx.value.chips.filter((c) => c.is_moving);
    if (moving.length > 1) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value.chips,
        path: ["chips"],
        message: `BLK-CHIPROW: at most one chip is the moving number, got ${moving.length}`,
      });
    }
    ctx.value.chips.forEach((chip, i) => {
      if (chip.is_moving && !chip.direction) {
        ctx.issues.push({
          code: "custom",
          input: chip,
          path: ["chips", i, "direction"],
          message: "BLK-CHIPROW: the moving chip must state its direction",
        });
      }
      if (!chip.is_moving && chip.direction) {
        ctx.issues.push({
          code: "custom",
          input: chip,
          path: ["chips", i, "direction"],
          message: "BLK-CHIPROW: a context chip has no direction — it stays grey",
        });
      }
    });
  },
);

/**
 * BLK-SNAPSHOT · Mini chart card — registry says unbound; **this schema binds it**.
 *
 * "THE WIRE'S ONLY PERMITTED CHART — no other D-family block may appear on the wire." It is a
 * chart, so D-8 applies to it exactly as it applies to family D: the bar values bind, and the
 * writer does not enumerate them.
 *
 * Which bar is the peak and which is the latest are facts about the resolved series, so they are
 * not fields — the compiler finds them, which is also what stops a wire item colouring the wrong
 * bar under time pressure. Flagged for the registry row to be corrected.
 */
export const BLK_SNAPSHOT = blockSchema(
  "BLK-SNAPSHOT",
  "Mini chart card",
  "The wire's only permitted chart: one bound series, no axes, at most three labels. The peak and the latest bar are found in the resolved series, never asserted.",
  {
    title: prose("What the series measures."),
    series: ObjectBinding.describe("The bar series. Resolved and drawn by the chart compiler."),
    labels: z
      .array(z.string().min(1))
      .max(3)
      .default([])
      .describe("At most three labels — typically start period, peak, now."),
  },
);

/**
 * BLK-COUNTDOWN · Deadline clock.
 *
 * **The relative time is not a payload field, and that is the block's whole point.** The card lists
 * "relative time remaining (e.g. '2d 09h')", but a countdown whose remaining time was written by an
 * agent is wrong the moment it is stored. The payload carries the absolute deadline; the renderer
 * counts down from it. The card's own rule — "ABSOLUTE DEADLINE UNDER THE RELATIVE ONE — never the
 * relative alone" — is then unbreakable, because the relative one cannot exist without the absolute.
 *
 * "MARSAD NEVER TAKES THE ORDER" stays in the description: the CTA routes the reader to their
 * broker, and the card names no destination field to schematise.
 */
export const BLK_COUNTDOWN = blockSchema(
  "BLK-COUNTDOWN",
  "Deadline clock",
  "The absolute deadline is the payload; the relative counter is rendered from it, never stored. Marsad never takes the order — the CTA sends the reader to their broker.",
  {
    kicker: prose("What is closing, e.g. `RETAIL SUBSCRIPTION CLOSES`."),
    deadline: z.iso.datetime({ offset: true }).describe("The absolute deadline, with offset."),
    timezone_label: z
      .string()
      .min(1)
      .describe("Timezone as printed beside the deadline, e.g. `GST`."),
    context_line: prose("One line of context, e.g. the current cover level."),
    cta_label: z.string().min(1).describe("CTA label. It routes the reader elsewhere — never to an order ticket."),
  },
);

/**
 * BLK-HALT · Trading halt.
 *
 * "MUST DISTINGUISH FROZEN FROM STALE — the copy must say which." That is a required prose field,
 * because it is the one thing a reader seeing a motionless price needs told and the one thing a
 * template would otherwise silently omit.
 *
 * `expected_lift` is nullable rather than absent: an indefinite halt is a real state, and modelling
 * it as a missing field would let a writer drop the row when it is unknown, which is exactly when
 * saying "unknown" matters most.
 */
export const BLK_HALT = blockSchema(
  "BLK-HALT",
  "Trading halt",
  "States the reason and the expected lift, and says in words whether the price is frozen or merely stale. An indefinite halt is expressed as a null lift time, never as a missing field.",
  {
    status_chip: houseLabel("HALTED"),
    ticker: z.string().min(1),
    halted_since: z.iso.datetime({ offset: true }),
    expected_lift: z
      .iso
      .datetime({ offset: true })
      .nullable()
      .describe("Null when the lift time is not known — an indefinite halt is a state, not a gap."),
    reason: prose("Why trading was halted."),
    last_price: z.number().describe("Last traded price before the halt."),
    frozen_not_stale: prose(
      "The explicit statement that the price is frozen rather than a stale feed. Required — this is the sentence a reader needs.",
    ),
  },
);

/**
 * BLK-CORRECTION · Correction note — `requires_binding`, rule **R-07**.
 *
 * The literal-vs-binding split here is the most interesting in the system, and it runs *both* ways:
 *
 * - `corrected_object` **binds**. Fixing the lake object once is what makes every citing piece
 *   update (D-8's second consequence), so the corrected value is read from the object, never
 *   restated here — a correction that restates the number would be a second copy to go wrong.
 * - `wrong_value` stays **literal**, and must. The superseded value no longer exists anywhere in
 *   the lake; if the correction does not write it down, it is gone.
 *
 * "MUST SAY WHETHER THE ARGUMENT SURVIVED" is a required boolean — the only way to make a
 * statement about integrity unskippable is to make it a field with no default.
 */
export const BLK_CORRECTION = blockSchema(
  "BLK-CORRECTION",
  "Correction note",
  "Amber, never red — a correction is integrity. Appended, never silent. The corrected value is read from the fixed lake object; the wrong value is written down here because the lake no longer holds it.",
  {
    chip: houseLabel("REVISED"),
    published_at: z.iso.datetime({ offset: true }).describe("When the original was published."),
    corrected_at: z.iso.datetime({ offset: true }).describe("When the correction was appended."),
    corrected_object: ObjectBinding.describe(
      "The lake object and field that was fixed. Every piece citing it is flagged; the right value renders from here.",
    ),
    wrong_value: z
      .string()
      .min(1)
      .describe("The superseded value, as it was published. Literal — the lake no longer holds it."),
    why_wrong: prose("What went wrong, naming the source that conflicted."),
    remediation: prose("What was done to the lake object and to the downstream pieces."),
    argument_survived: z
      .boolean()
      .describe("Whether the piece's conclusion survives the correction. Required — never inferred, never omitted."),
    rule_id: z.literal("R-07").default("R-07"),
  },
);

/**
 * BLK-BREADTH · Session breadth.
 *
 * "MEDIAN MOVE MATTERS MORE THAN THE INDEX — IT SAYS WHETHER THE DAY WAS BROAD."
 *
 * Left literal, following the registry row, but flagged: these six figures are measured session
 * statistics and have a stronger claim to binding than anything else in this family. They are kept
 * literal here because flipping a `requires_binding` row is a registry decision, not a schema one,
 * and the numeric-consistency check covers wire prose in the meantime.
 */
export const BLK_BREADTH = blockSchema(
  "BLK-BREADTH",
  "Session breadth",
  "Advancers, decliners and unchanged as a proportional bar, with the median move — which says whether the day was broad in a way the index cannot.",
  {
    advancers: z.int().min(0),
    decliners: z.int().min(0),
    unchanged: z.int().min(0).describe("The remainder bar."),
    median_move_pct: z.number().describe("Median move across the session, signed and in percent."),
    best_performer: z.strictObject({
      ticker: z.string().min(1),
      change_pct: z.number(),
    }),
    value_traded: z.string().min(1).describe("Session value traded, as printed with its unit."),
  },
);

/**
 * BLK-VENUEHEAD · Venue column header — `requires_binding`, binds `market.status` per venue.
 *
 * "A DEGRADED FEED IS NAMED IN THE HEADER, NOT HIDDEN IN A FOOTNOTE." The card lists a
 * "degraded-feed flag per venue" as payload; it is not one here. Whether a feed is degraded is
 * `market.status`'s answer, and a header that could claim a healthy feed while the status says
 * otherwise is precisely the failure the rule is written against. Binding the status object per
 * venue means the header cannot lie, and cannot go stale.
 *
 * `item_count` stays literal: it counts the items in *this column of this page*, which is a fact
 * about the composition, not about the market.
 */
export const BLK_VENUEHEAD = blockSchema(
  "BLK-VENUEHEAD",
  "Venue column header",
  "Groups a set of venues under one header and carries its own item count. Feed degradation is read from the bound market status per venue and named in the header — it is never a writer-supplied flag and never a footnote.",
  {
    group_title: z.string().min(1).describe("Venue group title, e.g. `QATAR · KUWAIT · OMAN`."),
    headline_index: z.strictObject({
      label: z.string().min(1).describe("Index name, e.g. `QSI`."),
      level: ObjectBinding,
      change_pct: ObjectBinding,
    }),
    secondary_indices: z
      .array(
        z.strictObject({
          label: z.string().min(1),
          level: ObjectBinding,
          change_pct: ObjectBinding,
        }),
      )
      .default([])
      .describe("Chips under the headline index."),
    venues: z
      .array(
        z.strictObject({
          venue: VenueCode,
          status: ObjectRef.describe(
            "The venue's `market.status` object. Its state — live, delayed, offline — is read, never asserted.",
          ),
        }),
      )
      .min(1),
    item_count: z.int().min(0).describe("How many items this column carries on this page."),
  },
);

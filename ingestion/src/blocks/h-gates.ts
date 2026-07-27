/**
 * PD.3 — family H · Gates & calls to action (4 blocks).
 *
 * "Where the business model touches the page. They must never interrupt an argument mid-sentence."
 *
 * The family rule — never mid-sentence — is a *placement* rule, so it belongs to the fit stage
 * (R-09, step 6 of §6) and not to any of these payloads. What the payloads can carry is the
 * evidence the fit stage needs to check it: BLK-CUT states where it falls and how many data blocks
 * preceded it, and both claims are verifiable against the actual block sequence.
 */
import { z } from "zod";

import { ObjectBinding, ObjectRef, blockSchema, houseLabel, prose } from "./binding.js";

/**
 * BLK-CUT · Premium cut — rule **R-09**, gating.
 *
 * "MUST SIT AFTER AT LEAST ONE DATA BLOCK — THE READER SEES THE WORK BEFORE THE WALL", and "THE CUT
 * FALLS AFTER A COMPLETE THOUGHT, NEVER MID-SENTENCE".
 *
 * `data_blocks_before` is a `min(1)`, which catches the writer that never counted; the fit stage
 * then recounts against the real sequence, which catches the writer that counted wrong. Both are
 * worth having — the first is a cheap refusal during generation, the second is the real one.
 *
 * The blur radius, the gradient and the pointer-events are the renderer's; no payload field can
 * weaken the gate.
 */
export const BLK_CUT = blockSchema(
  "BLK-CUT",
  "Premium cut",
  "Where the free read ends. It must fall after a complete thought and after at least one data block — the reader sees the work before the wall. The fit stage re-verifies both claims against the real block sequence.",
  {
    teaser: prose("The paragraph that blurs into the gradient. Must end on a complete thought."),
    after_block_index: z
      .int()
      .min(0)
      .describe("Zero-based index of the block the cut falls after, in the piece's block sequence."),
    data_blocks_before: z
      .int()
      .min(1)
      .describe("How many data blocks (families C, D) render before the cut. At least one, always."),
    rule_id: z.literal("R-09").default("R-09"),
  },
);

/**
 * BLK-PAYWALL · In-article paywall band — `requires_binding`, binds the free-read meter state.
 *
 * **Judgement call, and a flagged one.** This block is `requires_binding=true`, but its
 * `binds_to` is "the free-read meter state" — per-request session state belonging to the reader,
 * not a row in `lake.objects`. There is no uuid to bind. The card's "meter state string
 * (e.g. '3 / 3 FREE READS USED')" is therefore *not* a payload field: it is computed per request,
 * and a stored copy would be wrong for every reader but one.
 *
 * "STATES WHAT IS BEHIND IT SPECIFICALLY — no generic 'subscribe to read more'" gets a length
 * floor, which catches the laziest failure; judging whether the copy is genuinely specific is a
 * fit-stage lint, not something a schema can see.
 */
export const BLK_PAYWALL = blockSchema(
  "BLK-PAYWALL",
  "In-article paywall band",
  "Names the meter state and states specifically what is behind the wall — never a generic 'subscribe to read more'. The meter itself is per-request reader state and is resolved at render, so it is not a payload field.",
  {
    kicker: houseLabel("CONTINUE WITH PREMIUM"),
    behind_the_wall: z
      .string()
      .min(24)
      .describe(
        "What specifically is behind the wall — the model, the table, the target. Generic copy is refused at the fit stage.",
      ),
    cta_label: z.string().min(1).describe("Primary CTA label, e.g. `Start 14-day trial`."),
    reassurance: prose("The reassurance line, e.g. `cancel anytime`."),
  },
);

/**
 * BLK-ALERTCTA · Turn this into an alert — `requires_binding`, binds the piece's own subject.
 *
 * "PRE-FILLS THE ALERT FROM THE PIECE'S OWN SUBJECT — the reader must not re-specify it." That is
 * exactly a binding: `series` names the tracked object and field, so the alert definition is built
 * from the same object the piece argued about rather than from a string the reader retypes.
 */
export const BLK_ALERTCTA = blockSchema(
  "BLK-ALERTCTA",
  "Turn this into an alert",
  "Pre-fills the alert from the piece's own subject — the reader must not re-specify it. The tracked series binds, so the alert watches the same object the piece argued about.",
  {
    kicker: houseLabel("KEEP WATCHING THIS"),
    headline: prose("What will trigger the ping."),
    expected_event: prose("The event we expect, e.g. `Q3 results`."),
    expected_date: z.iso.date().describe("When we expect it."),
    subject: z
      .strictObject({
        entity: ObjectRef.describe("The entity the piece is about."),
        series: ObjectBinding.describe("The tracked series the alert watches."),
        condition: prose("The condition that fires the alert, e.g. `payout ratio above 100%`."),
      })
      .describe("The pre-filled alert definition."),
    cta_label: houseLabel("Create alert →"),
  },
);

/**
 * BLK-DOWNLOAD · Take the data — `requires_binding`, binds every series in the piece.
 *
 * "SHIPPING THE OBJECT IDS IS THE DIFFERENTIATOR — IT MAKES THE RESEARCH AUDITABLE", and "The .xlsx
 * must carry the lake object IDs so any figure traces back to its filing."
 *
 * `series` is a list of {@link ObjectRef} rather than {@link ObjectBinding}: the download ships
 * whole objects, not one field of each. The card's "count of downloadable series" is not a field —
 * it is `series.length`, and a payload that could disagree with its own list would let the button
 * promise nine series and deliver seven.
 */
export const BLK_DOWNLOAD = blockSchema(
  "BLK-DOWNLOAD",
  "Take the data",
  "Every series in the piece, shipped as .xlsx carrying the lake object ids so any figure traces back to its filing. The count is the length of the list, not a separate claim about it.",
  {
    kicker: houseLabel("EVERY SERIES IS DOWNLOADABLE"),
    explanation: prose("Why this matters — the ids make the research auditable."),
    format: houseLabel("xlsx"),
    series: z
      .array(ObjectRef)
      .min(1)
      .describe("Every lake object behind a series in the piece. The button's count is this list's length."),
  },
);

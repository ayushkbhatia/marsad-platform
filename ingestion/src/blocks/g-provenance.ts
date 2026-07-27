/**
 * PD.3 — family G · Provenance & trust (6 blocks).
 *
 * "The family that makes agent-written journalism publishable. Not decoration — the audit trail,
 * rendered." Build order puts G first because every other family's footer depends on it.
 *
 * This family has the sharpest literal-vs-binding rule in the whole design, and it is worth stating
 * plainly: **an audit trail a writer agent can type is not an audit trail.** So the fields the cards
 * list — the verifying agent id, the verification timestamp, the source class, the freshness state,
 * the coverage depth — are not payload fields here. They are attributes of the bound object, and
 * they render from it. That makes several of these schemas noticeably thinner than their cards,
 * which is the intended result: what the card describes is what *renders*, and the renderer reads
 * it.
 *
 * The exception is BLK-AGENTS, which describes the build chain of the *piece* rather than of an
 * object, and BLK-RULE, whose binding target is `ops.rules` rather than `lake.objects`.
 */
import { z } from "zod";

import { ObjectBinding, ObjectRef, RuleId, VenueCode, blockSchema, houseLabel, prose } from "./binding.js";

/**
 * BLK-PROV · Lake object stamp — `requires_binding`, mandatory under every chart and table.
 *
 * "Must name object, agent AND source class — all three." All three come from the object: the
 * verifying agent is `verified_by`, the timestamp is `verified_at`, the source class follows from
 * `source_rank` and the object type, and the green/ink/amber diamond follows from `state`. The
 * payload is therefore one reference and nothing else.
 *
 * This is the most aggressive reading of a card in this file, and the most defensible one: a
 * provenance stamp whose agent id and verification time were typed by the agent being vouched for
 * is theatre. Everything the card lists still renders — it is simply read rather than asserted.
 */
export const BLK_PROV = blockSchema(
  "BLK-PROV",
  "Lake object stamp",
  "Mandatory under every chart and table. The object type, entity, coverage depth, verifying agent, verification time, source class and verified/computed/pending status all render from the bound object — none of them is writer-supplied, because a stamp an agent can type is not a stamp.",
  {
    object: ObjectRef.describe("The object being stamped. Everything the stamp prints is read from it."),
  },
);

/**
 * BLK-AGENTS · How this was built — unbound, and correctly so: the chain describes the *piece*, not
 * a lake object.
 *
 * "AGENT CHIPS CARRY ◆, HUMANS DON'T · THE HUMAN IS ALWAYS LAST IN THE CHAIN." The second half is
 * checked, because it is the claim the block exists to make: an agent-run newsroom is publishable
 * precisely because a human signs the end of every chain. A payload that could put an agent last
 * would let the page assert otherwise.
 */
export const BLK_AGENTS = blockSchema(
  "BLK-AGENTS",
  "How this was built",
  "The build chain, in order. Agent chips carry a diamond and humans do not — and the human is always last, which is checked rather than trusted.",
  {
    narrative: prose("How this piece was built, in a sentence or two."),
    chain: z
      .array(
        z.strictObject({
          name: z.string().min(1).describe("Agent id or person's name."),
          is_agent: z.boolean().describe("Agents get the diamond; humans do not."),
        }),
      )
      .min(2)
      .describe("In build order. The last entry is the human editor."),
  },
  (ctx) => {
    const last = ctx.value.chain[ctx.value.chain.length - 1];
    if (last?.is_agent) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value.chain,
        path: ["chain", ctx.value.chain.length - 1],
        message: "BLK-AGENTS: the human is always last in the chain",
      });
    }
  },
);

/**
 * BLK-FRESH · Freshness badge — `requires_binding`, binds `market.status` per venue.
 *
 * "EXACTLY FOUR STATES — never a number without one of them" and "Shared component with the reader
 * app's FreshnessBadge — not a re-implementation".
 *
 * Both of those argue *against* putting the state in the payload. The state, the timestamp, the
 * delay in minutes, the last-close reference and the retry count are all `market.status`, they all
 * change between composition and render, and the reader app already owns the state machine
 * (`src/lib/market/freshness.ts`). A payload that said `LIVE` would be a claim about a feed the
 * writer cannot see. So the payload names the venue and binds the status; the badge does the rest.
 */
export const BLK_FRESH = blockSchema(
  "BLK-FRESH",
  "Freshness badge",
  "Every live figure carries one. The state — live, delayed, closed, feed offline — and its detail line resolve from the bound venue status at render time, through the reader app's shared FreshnessBadge. Nothing about the feed is writer-asserted, because the writer cannot see it.",
  {
    venue: VenueCode.describe("Which venue's feed this figure came from."),
    status: ObjectRef.describe("The venue's `market.status` object. The badge reads its state and detail."),
  },
);

/**
 * BLK-ESTIMATE · Desk-estimate marker — `requires_binding`, binds a desk computation.
 *
 * Hard rule #3: "a desk estimate is marked three ways at once — `E` suffix, ink column header, bold
 * value… **Never colour alone.** → the renderer owns this; the agent supplies only an `is_estimate`
 * flag per period." That sentence is the spec for this schema, so there is no styling field here
 * at all: the payload cannot mark an estimate one way instead of three, because it cannot mark it
 * at all. What it does is name the actual and the estimate, and bind both.
 */
export const BLK_ESTIMATE = blockSchema(
  "BLK-ESTIMATE",
  "Desk-estimate marker",
  "Pairs a filed actual with a desk estimate so the two can be told apart. The renderer applies all three estimate signals at once; the payload carries no styling, so it cannot apply one of them instead.",
  {
    actual: z
      .strictObject({
        period_label: z.string().min(1).describe("Period of the filed figure, e.g. `FY25`."),
        value: ObjectBinding.describe("The filed figure."),
      })
      .describe("The company disclosure. Rendered muted."),
    estimate: z
      .strictObject({
        period_label: z
          .string()
          .min(1)
          .describe("Period of the estimate, e.g. `FY26`. The renderer appends the E suffix."),
        value: ObjectBinding.describe("The desk computation."),
      })
      .describe("The desk's number. Rendered bold under an ink header."),
    attribution: houseLabel("MARSAD DESK"),
    footnote: prose("The statement that this is a desk computation, not a company disclosure."),
  },
);

/**
 * BLK-CONFLICT · Held from writers — `requires_binding`, binds the two conflicting source objects.
 *
 * "THE FIGURE IS WITHHELD — publishing a gap beats publishing a guess · SHOWS BOTH, PICKS NEITHER."
 *
 * There is **no resolved-value field in this schema, deliberately**. The block's rule is that the
 * figure is not quoted, and the cleanest way to guarantee that is to give the payload nowhere to
 * put it. Both source values bind — they are real figures from real objects, and the reader is
 * shown both. Exactly one may be primary; "primary wins unless overridden" is a resolution rule for
 * the desk, not a licence for this block to pick.
 */
export const BLK_CONFLICT = blockSchema(
  "BLK-CONFLICT",
  "Held from writers",
  "Sources disagree, so the figure is withheld: both values are shown, neither is picked. There is no field for a resolved value — publishing a gap beats publishing a guess.",
  {
    figure_label: z.string().min(1).describe("What the withheld figure is."),
    period_label: z.string().min(1).describe("Which period it covers."),
    source_a: z.strictObject({
      label: z.string().min(1).describe("Source name, e.g. `Vendor feed`."),
      value: ObjectBinding,
      is_primary: z.boolean().describe("Exactly one of the two sources is primary."),
    }),
    source_b: z.strictObject({
      label: z.string().min(1).describe("Source name, e.g. `FY25 annual report`."),
      value: ObjectBinding,
      is_primary: z.boolean(),
    }),
    resolution_statement: prose(
      "That the figure is not quoted until the desk resolves it, and that primary wins unless overridden.",
    ),
  },
  (ctx) => {
    const primaries = [ctx.value.source_a, ctx.value.source_b].filter((s) => s.is_primary).length;
    if (primaries !== 1) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: [],
        message: `BLK-CONFLICT: exactly one source must be primary, got ${primaries}`,
      });
    }
  },
);

/**
 * BLK-RULE · Rule applied — `requires_binding`, binds the publishing ruleset.
 *
 * **Judgement call:** this is `requires_binding=true` but its target is `ops.rules.rule_key`, a
 * text key, not a `lake.objects` uuid. So the binding here is {@link RuleId} — a pattern the fit
 * stage resolves against the ruleset. A `{object_id, field}` binding would be a lie about where
 * rules live.
 *
 * "NAMING THE RULE IS THE POINT — THE READER LEARNS THE HOUSE STANDARD BY SEEING IT ENFORCED", so
 * `automated_check` is required prose: the block is only honest if it says what actually enforces
 * the rule, rather than implying a human remembered it.
 */
export const BLK_RULE = blockSchema(
  "BLK-RULE",
  "Rule applied",
  "Used only when a rule visibly shaped the copy. Cites the id from the publishing ruleset — the reader learns the house standard by watching it get enforced.",
  {
    rule_id: RuleId,
    requirement: prose("What the rule requires, in plain language."),
    how_it_shaped_this: prose("How it shaped this specific piece."),
    automated_check: prose("The automated check that enforces it, e.g. the screener flags payout > 100%."),
  },
);

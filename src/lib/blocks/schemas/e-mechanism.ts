/**
 * PD.3 — family E · Mechanism & explainer (8 blocks).
 *
 * "Teach a process… Evergreen — they carry a review date, not a timestamp." Seven of the eight are
 * `requires_binding=false`, and here that is unambiguously right: an explainer's job is to teach a
 * mechanism, and BLK-WORKED's card says outright "ROUND NUMBERS, REAL TICKER" — the arithmetic is
 * deliberately illustrative, so binding it to the lake would be a category error, not a safeguard.
 *
 * The eighth, BLK-GLOSSARY, is `requires_binding=true` and has **no writer payload at all**; see
 * the note on it below.
 *
 * Two constraints in this family are enforced *structurally* rather than by a check, which is the
 * strongest form available: BLK-DECISION cannot nest because its schema has no recursion, and
 * BLK-ANATOMY cannot invent an accent colour because its highlight field is an enum of three
 * semantic classes rather than a colour.
 */
import { z } from "zod";

import { blockSchema, prose } from "./binding";

/**
 * BLK-TIMELINE · Dates in order.
 *
 * "EXACTLY ONE STAGE IN RED — THE ONE THAT COSTS MONEY IF MISSED." Exactly-one is not expressible
 * in JSON Schema, so it is a Zod check: the provider cannot enforce it during generation, but the
 * fit stage's parse will refuse a timeline with two critical stages or none.
 */
export const BLK_TIMELINE = blockSchema(
  "BLK-TIMELINE",
  "Dates in order",
  "Stages left to right in date order. Exactly one stage is critical — the one that costs money if missed — and it is the only one in red.",
  {
    stages: z
      .array(
        z.strictObject({
          name: z.string().min(1).describe("Stage name."),
          date: z.iso.date().describe("Stage date, ISO `YYYY-MM-DD`."),
          description: prose("One line on what happens at this stage."),
          is_critical: z
            .boolean()
            .describe("Exactly one stage carries this. It is the one that costs money if missed."),
        }),
      )
      .min(2)
      .describe("In date order. The renderer numbers them; the index is not a payload field."),
  },
  (ctx) => {
    const critical = ctx.value.stages.filter((s) => s.is_critical).length;
    if (critical !== 1) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value.stages,
        path: ["stages"],
        message: `BLK-TIMELINE: exactly one stage must be critical, got ${critical}`,
      });
    }
  },
);

/**
 * BLK-STEPS · Numbered mechanism.
 *
 * "3–5 STEPS · A BOLD CLAIM PLUS ONE CLARIFYING LINE, NEVER A PARAGRAPH." The zero-padded numeral
 * the card lists (`01`) is not a field: it is the array index, formatted. A payload that could
 * disagree with its own ordering is a payload with a bug in it.
 */
export const BLK_STEPS = blockSchema(
  "BLK-STEPS",
  "Numbered mechanism",
  "Three to five steps. Each is a bold claim plus one clarifying line — never a paragraph. Numbering comes from the order, not from the payload.",
  {
    steps: z
      .array(
        z.strictObject({
          claim: prose("The step, stated as a claim. Set bold."),
          clarification: prose("One clarifying line. Never a paragraph."),
        }),
      )
      .min(3)
      .max(5),
  },
);

/**
 * BLK-FLOW · Money flow.
 *
 * "MAX 4 NODES, LEFT TO RIGHT · NEVER BRANCHES — USE BLK-DECISION." The no-branching rule is
 * structural: `connectors` is a flat list and the check requires exactly `nodes − 1` of them, so a
 * branch cannot be expressed. "ARROW WEIGHT SHOWS SENIORITY, NOT SIZE" becomes a two-value enum
 * rather than a stroke width, which is what stops a writer encoding size in the weight.
 *
 * `value_label` stays literal prose: this block teaches a capital structure, and the figures on its
 * arrows are illustrative in the same way BLK-WORKED's are.
 */
export const BLK_FLOW = blockSchema(
  "BLK-FLOW",
  "Money flow",
  "At most four nodes, left to right, never branching — a branch means the block is BLK-DECISION. Arrow weight shows seniority, not size. Equity is always the pale box at the end.",
  {
    nodes: z
      .array(
        z.strictObject({
          role: z.string().min(1).describe("Role label, e.g. `LENDER`, `OPCO`."),
          name: z.string().min(1).describe("The entity."),
          qualifier: prose("One qualifying line under the name."),
        }),
      )
      .min(2)
      .max(4),
    connectors: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("What flows along this arrow."),
          seniority: z
            .enum(["senior", "subordinated"])
            .describe("Drives the arrow weight. Seniority, never size."),
          value_label: z.string().min(1).describe("Amount or share, as printed."),
        }),
      )
      .min(1)
      .describe("Exactly one fewer than `nodes` — the chain never branches."),
    equity_node_index: z
      .int()
      .min(0)
      .describe("Zero-based index of the terminal equity node. Always the last node."),
  },
  (ctx) => {
    const { nodes, connectors, equity_node_index } = ctx.value;
    if (connectors.length !== nodes.length - 1) {
      ctx.issues.push({
        code: "custom",
        input: connectors,
        path: ["connectors"],
        message: `BLK-FLOW: ${nodes.length} nodes need exactly ${nodes.length - 1} connectors, got ${connectors.length}`,
      });
    }
    if (equity_node_index !== nodes.length - 1) {
      ctx.issues.push({
        code: "custom",
        input: equity_node_index,
        path: ["equity_node_index"],
        message: `BLK-FLOW: equity is always the terminal node (${nodes.length - 1}), got ${equity_node_index}`,
      });
    }
  },
);

/**
 * BLK-ANATOMY · Annotated document.
 *
 * "ABSTRACTED WIREFRAME, NEVER A SCREENSHOT" — hence relative widths and a semantic class per
 * region, with no image field anywhere.
 *
 * The card lists "swatch colour" as a payload field; it is an **enum of three highlight classes**
 * here instead. The design's first hard rule reserves the accents for direction, so a payload that
 * could name a colour is a payload that could break the rule. `critical` / `secondary` /
 * `boilerplate` map to the card's own three treatments.
 */
export const BLK_ANATOMY = blockSchema(
  "BLK-ANATOMY",
  "Annotated document",
  "An abstracted wireframe, never a screenshot — it teaches where to look. Regions carry a semantic highlight class, not a colour, so the accent rule cannot be broken from the payload.",
  {
    document_type: z.string().min(1).describe("What is being anatomised, e.g. `TADAWUL · CG-1`."),
    regions: z
      .array(
        z.strictObject({
          width_ratio: z
            .number()
            .gt(0)
            .max(1)
            .describe("Region width as a fraction of the wireframe rail."),
          highlight: z
            .enum(["critical", "secondary", "boilerplate"])
            .describe(
              "critical = the figure that changes your cash; secondary = the date block; boilerplate = skip it.",
            ),
        }),
      )
      .min(2),
    annotations: z
      .array(
        z.strictObject({
          highlight: z
            .enum(["critical", "secondary", "boilerplate"])
            .describe("Which region class this annotation's swatch matches."),
          title: z.string().min(1).describe("What this part of the document is."),
          why_it_matters: prose("Why the reader should look at it."),
        }),
      )
      .min(1),
  },
);

/**
 * BLK-WORKED · Worked example.
 *
 * "ROUND NUMBERS, REAL TICKER · MUST END IN A TOTAL ROW THAT SETTLES THE POINT." The numbers here
 * are literal and that is the *correct* call, not a concession: a worked example is a hypothetical
 * ("1,000 SHARES"), so binding it to the lake would assert that a reader actually holds those
 * shares. The `total` row is a required field rather than the last element of `rows`, because the
 * card makes it mandatory and an optional last row would be droppable.
 */
export const BLK_WORKED = blockSchema(
  "BLK-WORKED",
  "Worked example",
  "Round numbers on a real ticker. Deliberately illustrative, so the figures are literal — and it must end in a total row that settles the point.",
  {
    ticker: z.string().min(1).describe("A real ticker — the example is concrete or it does not teach."),
    premise: z.string().min(1).describe("The premise header, e.g. `1,000 SHARES`."),
    before: z
      .strictObject({
        label: z.string().min(1).describe("Column header for the starting state."),
        as_of: z.iso.date().describe("The date the starting state is measured at."),
      })
      .describe("The 'before' column."),
    after: z
      .strictObject({
        label: z.string().min(1).describe("Column header for the ending state."),
        as_of: z.iso.date().describe("The date the ending state is measured at."),
      })
      .describe("The 'after' column — its header is ink because it carries the desk's computation."),
    rows: z
      .array(
        z.strictObject({
          label: z.string().min(1),
          before_value: z.number(),
          after_value: z.number(),
        }),
      )
      .min(1),
    total: z
      .strictObject({
        label: z.string().min(1).default("Total"),
        before_value: z.number(),
        after_value: z.number(),
      })
      .describe("Mandatory. The row that settles the point."),
    closing_sentence: prose("What the difference actually is, in words."),
  },
);

/**
 * BLK-MYTH · Assumption vs mechanism.
 *
 * "NEVER MOCK THE ASSUMPTION · STATE IT IN THE READER'S OWN WORDS, THEN CORRECT IT." Two panels,
 * two fields. The red and green top rules belong to the panels, not to the payload — this is the
 * one place in the system where red and green are not direction, and letting the payload name them
 * would leak that exception into blocks where it does not hold.
 */
export const BLK_MYTH = blockSchema(
  "BLK-MYTH",
  "Assumption vs mechanism",
  "The assumption stated in the reader's own words, then the mechanism with the arithmetic. Never mock the assumption.",
  {
    assumption: prose("The assumption, in the reader's own words. Set in italic serif."),
    mechanism: prose("What actually happens, with the arithmetic."),
  },
);

/**
 * BLK-DECISION · If / then.
 *
 * "ONE QUESTION, TWO OUTCOMES · NEVER NEST — A SECOND LEVEL MEANS THE EXPLAINER IS WRONG." The
 * schema is flat and non-recursive, so the no-nesting rule is not checked — it is *unrepresentable*.
 * That is the strongest way to hold a design rule, and worth noting because it is rare.
 */
export const BLK_DECISION = blockSchema(
  "BLK-DECISION",
  "If / then",
  "One question, two outcomes. The schema has no recursion, so a second level cannot be expressed at all — which is the rule, enforced structurally.",
  {
    question: prose("The single question the reader is deciding."),
    yes: prose("What follows if the answer is yes."),
    no: prose("What follows if the answer is no."),
  },
);

/**
 * BLK-GLOSSARY · Terms on this page — `requires_binding`, and **no writer payload**.
 *
 * The card is explicit: "derived — no writer payload: term + definition pairs are collected from
 * the page's BLK-TERM instances", and "AUTO-ASSEMBLED — a writer agent does not author this block,
 * it emits BLK-TERM and this follows". So the schema is an empty strict object: emitting the code
 * is legal, emitting anything *in* it is not.
 *
 * This is the one block where `requires_binding=true` and no binding field exists, because the
 * binding is resolved from the rest of the page rather than declared. `BLOCK_BINDING_EXCEPTIONS` in
 * `index.ts` records that deliberately, so it reads as a decision rather than an omission.
 */
export const BLK_GLOSSARY = blockSchema(
  "BLK-GLOSSARY",
  "Terms on this page",
  "Auto-assembled in the rail from every BLK-TERM on the page, against the glossary store shared with Learn. A writer agent does not author this block — it emits BLK-TERM and this follows.",
  {},
);

/**
 * PD.3 — family C · Tabular (8 blocks), every one `requires_binding`.
 *
 * "Mono numerals, tabular-nums, hairline rows… Estimate columns are always marked." A tabular block
 * *is* data, so under D-8 every cell that prints a number is an {@link ObjectBinding} and the
 * writer supplies labels, order, and the editorial judgements a table cannot compute for itself.
 *
 * The judgement that recurs across this family: **a value binds; a claim about a value stays
 * literal.** `is_estimate`, `is_base` and `best_index` are claims — the lake cannot tell you which
 * scenario is the base case or which of P/E and dividend yield "wins" a row. Direction colouring
 * is the opposite: it is derivable from the resolved value, so no field carries it.
 */
import { z } from "zod";

import { ObjectBinding, VenueCode, blockSchema, houseHeaders, prose } from "./binding";

/**
 * BLK-STATSTRIP · Four-up stat strip.
 *
 * "3–5 CELLS MAX · ONE FACT EACH · Never a place to dump leftover numbers." The count bound is the
 * enforceable half and goes straight into JSON Schema. `is_change` exists because the card says
 * "Direction colour (green/red) only where the value is a change" — the *sign* comes from the
 * resolved value, but whether the cell is a change at all is the writer's to state.
 */
export const BLK_STATSTRIP = blockSchema(
  "BLK-STATSTRIP",
  "Four-up stat strip",
  "Three to five cells, one fact each. Never a place to dump leftover numbers.",
  {
    cells: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Cell label, rendered uppercase mono."),
          value: ObjectBinding.describe("The one fact this cell states."),
          is_change: z
            .boolean()
            .default(false)
            .describe(
              "True when the value is a change, which is the only case that may take direction colour. The sign itself comes from the resolved value.",
            ),
        }),
      )
      .min(3)
      .max(5),
  },
);

/**
 * BLK-KEYSTATS · Facts grid.
 *
 * "4 OR 8 CELLS — no other counts" is a disjunction, not a range, so it is a union of two
 * fixed-length arrays; `z.toJSONSchema` emits it as `anyOf` and 5, 6 and 7 are rejected.
 *
 * **Not schematised:** "MIN LOT AND REFUND DATE ARE GCC-RETAIL ESSENTIALS — NEVER DROP THEM FOR
 * SPACE". Enforcing it would require a controlled vocabulary of cell labels that the design card
 * does not provide, and inventing one would make the fit stage refuse legitimate IPO grids. It is
 * stated in the description (so it reaches the model) and belongs to the fit stage's IPO checklist.
 */
const keyStatsCell = z.strictObject({
  label: z.string().min(1).describe("Cell label, rendered uppercase mono."),
  value: ObjectBinding.describe("The bound fact."),
});

export const BLK_KEYSTATS = blockSchema(
  "BLK-KEYSTATS",
  "Facts grid",
  "Exactly 4 or exactly 8 cells — no other counts. Mechanics and consequences mixed deliberately. On an IPO grid, min lot and the refunds-by date are GCC-retail essentials and are never dropped for space.",
  {
    cells: z
      .union([z.array(keyStatsCell).length(4), z.array(keyStatsCell).length(8)])
      .describe("Four or eight. A 4-column grid admits no other count."),
  },
);

/**
 * BLK-FINTABLE · Financials with estimate column — binds `filing.financials`.
 *
 * "MAX 8 ROWS INLINE — longer tables go to the XLSX" → `.max(8)`, enforceable and enforced.
 *
 * `is_estimate` per period is exactly what hard rule #3 asks the agent for and no more: "the
 * renderer owns this; the agent supplies only an `is_estimate` flag per period". The E suffix, the
 * ink header and the bold value are the renderer's three simultaneous signals — the payload must
 * not be able to express only one of them, which is why there is no styling field here at all.
 *
 * The row-width invariant (every row has one value per period) cannot be expressed in JSON Schema;
 * it is a Zod refinement, so the TypeScript parse catches it even though the provider cannot.
 */
export const BLK_FINTABLE = blockSchema(
  "BLK-FINTABLE",
  "Financials with estimate column",
  "At most 8 rows inline. Every period column declares whether it is a desk estimate; the renderer marks estimates three ways at once so one can never read as an actual.",
  {
    unit: z.string().min(1).describe("Unit header for the whole table, e.g. `OMR M`."),
    periods: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Column header, e.g. `FY24`. The renderer appends the E suffix."),
          is_estimate: z
            .boolean()
            .describe("True for a desk estimate. Drives all three estimate signals — never colour alone."),
        }),
      )
      .min(2)
      .describe("Period columns, left to right."),
    rows: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Line-item label."),
          values: z
            .array(ObjectBinding)
            .min(1)
            .describe("One binding per period column, in the same order as `periods`."),
        }),
      )
      .min(1)
      .max(8)
      .describe("At most 8 rows inline; a longer table goes to the XLSX attachment."),
    estimate_footnote: prose("Footnote explaining how the estimate column is marked."),
  },
  (ctx) => {
    const { periods, rows } = ctx.value;
    rows.forEach((row, i) => {
      if (row.values.length !== periods.length) {
        ctx.issues.push({
          code: "custom",
          input: row.values,
          path: ["rows", i, "values"],
          message: `BLK-FINTABLE: row "${row.label}" has ${row.values.length} values for ${periods.length} period columns`,
        });
      }
    });
  },
);

/**
 * BLK-SCENARIO · Three paths.
 *
 * "EXACTLY THREE scenarios" → `.length(3)`. "EVERY PATH NEEDS AN OBSERVABLE TRIGGER" → `trigger` is
 * required prose. "BASE ROW TINTED" → exactly one `is_base`, checked by refinement.
 *
 * **Judgement call:** `eps` and `return_pct` bind even though a scenario is hypothetical. C-family
 * blocks are `requires_binding` without exception, and a scenario EPS the desk publishes *is* a
 * desk computation — which PE.3 makes a first-class lake object family. Binding it is what makes
 * the same number reusable, correctable under R-07, and auditable in the XLSX.
 */
export const BLK_SCENARIO = blockSchema(
  "BLK-SCENARIO",
  "Three paths",
  "Exactly three scenarios, each with an observable trigger and exactly one marked as base. The figures bind to desk-computation objects so the same numbers stay correctable and downloadable.",
  {
    title: z.string().min(1).describe("Title bar, e.g. `THREE PATHS TO 2028`."),
    column_headers: houseHeaders("SCENARIO", "EPS", "RETURN", "TRIGGER"),
    rows: z
      .array(
        z.strictObject({
          name: z.string().min(1).describe("Scenario name, e.g. `Bull`."),
          trigger: prose("The observable event or threshold that would put us on this path."),
          is_base: z.boolean().describe("Exactly one row is the base case."),
          eps: ObjectBinding.describe("Scenario EPS."),
          return_pct: ObjectBinding.describe("Implied return, signed. Coloured by direction only."),
        }),
      )
      .length(3),
  },
  (ctx) => {
    const bases = ctx.value.rows.filter((r) => r.is_base).length;
    if (bases !== 1) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value.rows,
        path: ["rows"],
        message: `BLK-SCENARIO: exactly one row must be the base case, got ${bases}`,
      });
    }
  },
);

/**
 * BLK-RANKROW · League table.
 *
 * "THE RANKED METRIC ALWAYS CARRIES A QUALIFYING COLUMN — A YIELD TABLE WITHOUT PAYOUT IS A TRAP."
 * That is the entire reason `qualifier` is required rather than optional.
 *
 * **Not a field:** the card's "risk flag". "Qualifying column turns red when it flags risk (payout
 * > 100%)" is a *rule* applied to the resolved value (R-06), not a writer assertion — letting an
 * agent set the flag by hand would let it un-set the flag by hand.
 */
export const BLK_RANKROW = blockSchema(
  "BLK-RANKROW",
  "League table",
  "Five to ten rows. The ranked metric always carries a qualifying column — a yield table without payout is a trap. The risk flag on the qualifier is applied by the ruleset against the resolved value, never asserted here.",
  {
    metric_label: z.string().min(1).describe("Header for the ranked column."),
    qualifier_label: z.string().min(1).describe("Header for the qualifying column."),
    rows: z
      .array(
        z.strictObject({
          rank: z.int().min(1).describe("Rank as printed."),
          name: z.string().min(1).describe("Entity name."),
          venue: VenueCode.describe("Listing venue."),
          metric: ObjectBinding.describe("The ranked metric."),
          qualifier: ObjectBinding.describe("The qualifying metric. Never optional."),
        }),
      )
      .min(5)
      .max(10),
  },
);

/**
 * BLK-BEATMISS · Actual vs consensus — binds `filing.eps + consensus.eps`.
 *
 * "SURPRISE AND PRICE REACTION SIT SIDE BY SIDE — THEY DISAGREE MORE OFTEN THAN READERS EXPECT."
 * Four bindings per row, not two: `surprise_pct` is arithmetically derivable from actual and
 * consensus, but the *reaction* is a measured T+0 close and the pairing is the point of the block,
 * so both are bound and both stay correctable. (If the fit stage would rather recompute the
 * surprise than trust a stored object, it can — the binding tells it exactly which object to check
 * against.)
 */
export const BLK_BEATMISS = blockSchema(
  "BLK-BEATMISS",
  "Actual vs consensus",
  "Surprise and price reaction side by side. The reaction is the T+0 close, not intraday.",
  {
    column_headers: houseHeaders("NAME", "ACTUAL", "CONS.", "SURPRISE", "REACTION"),
    rows: z
      .array(
        z.strictObject({
          name: z.string().min(1).describe("Company name as printed."),
          ticker: z.string().min(1),
          actual_eps: ObjectBinding.describe("Reported EPS."),
          consensus_eps: ObjectBinding.describe("Consensus EPS going into the print."),
          surprise_pct: ObjectBinding.describe("Surprise, signed and in percent."),
          reaction_pct: ObjectBinding.describe("Price reaction at the T+0 close, signed and in percent."),
        }),
      )
      .min(1),
  },
);

/**
 * BLK-EXDATE · Dividend row — binds `dividend.exdate`.
 *
 * "ONE ROW PER DECLARATION, NOT PER PAYMENT." Every column of a row will normally carry the same
 * `object_id` with a different `field` — that is the shape of a declaration in `lake.objects`, and
 * spelling out the four fields keeps each printed column individually sourced and individually
 * correctable.
 *
 * `type` stays literal: the INTERIM/SPECIAL chip is a label, and the SPECIAL chip's ink inversion
 * is a render rule the payload must not be able to override.
 */
export const BLK_EXDATE = blockSchema(
  "BLK-EXDATE",
  "Dividend row",
  "One row per declaration, never per payment. Ex-date is the bold column, not pay date.",
  {
    column_headers: houseHeaders("TICKER", "TYPE", "DPS", "EX-DATE", "YIELD", "PAY"),
    rows: z
      .array(
        z.strictObject({
          ticker: z.string().min(1),
          type: z
            .string()
            .min(1)
            .describe("Declaration type chip, e.g. `INTERIM`, `FINAL`, `SPECIAL`. SPECIAL inverts to ink."),
          dps: ObjectBinding.describe("Dividend per share."),
          ex_date: ObjectBinding.describe("Ex-date."),
          yield_pct: ObjectBinding.describe("Yield at declaration, in percent."),
          pay_date: ObjectBinding.describe("Payment date."),
        }),
      )
      .min(1),
  },
);

/**
 * BLK-COMPARE · Transposed comparison.
 *
 * "MAX 4 NAMES, 8 METRICS" → both bounds enforced. "EMPTY SLOT KEEPS ITS DASHED COLUMN SO THE GRID
 * NEVER REFLOWS" → `empty_slots`, so the renderer knows how many dashed columns to hold open.
 *
 * **`best_index` is deliberately literal.** "BEST-IN-ROW IS BOLD", but *best* is not derivable: a
 * lower P/E wins and a higher ROE wins, and the lake does not store which way a metric points. This
 * is the same class of field as BLK-DELTA's polarity — a semantic judgement, not a datum.
 *
 * **Not schematised:** "PRICES STAY LOCAL, MARKET CAP IS USD-NORMALISED" is a property of the
 * objects being bound, not of this payload; it belongs to the object producers and the fit stage.
 */
export const BLK_COMPARE = blockSchema(
  "BLK-COMPARE",
  "Transposed comparison",
  "Metrics as rows, names as columns. Max 4 names and 8 metrics. Prices stay local; market cap is USD-normalised. Best-in-row is a semantic judgement the writer states, because the lake does not know which direction a metric points.",
  {
    names: z
      .array(
        z.strictObject({
          ticker: z.string().min(1),
          short_name: z.string().min(1).describe("Column header — short enough for a 4-column grid."),
        }),
      )
      .min(2)
      .max(4),
    metrics: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Metric row label."),
          values: z
            .array(ObjectBinding)
            .min(2)
            .max(4)
            .describe("One binding per name, in the same order as `names`."),
          best_index: z
            .int()
            .min(0)
            .max(3)
            .describe("Zero-based index of the winning name. Bolded. Not derivable — lower is better for some metrics."),
        }),
      )
      .min(1)
      .max(8),
    empty_slots: z
      .int()
      .min(0)
      .max(2)
      .default(0)
      .describe("Dashed 'add a name' columns held open so the grid never reflows."),
  },
  (ctx) => {
    const { names, metrics } = ctx.value;
    metrics.forEach((metric, i) => {
      if (metric.values.length !== names.length) {
        ctx.issues.push({
          code: "custom",
          input: metric.values,
          path: ["metrics", i, "values"],
          message: `BLK-COMPARE: metric "${metric.label}" has ${metric.values.length} values for ${names.length} names`,
        });
      }
      if (metric.best_index >= names.length) {
        ctx.issues.push({
          code: "custom",
          input: metric.best_index,
          path: ["metrics", i, "best_index"],
          message: `BLK-COMPARE: best_index ${metric.best_index} is out of range for ${names.length} names`,
        });
      }
    });
  },
);

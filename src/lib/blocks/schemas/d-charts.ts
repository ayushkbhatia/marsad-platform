/**
 * PD.3 — family D · Charts (15 blocks), every one `requires_binding`.
 *
 * **The agent never emits a chart spec.** Per D-12, a Vega-Lite spec *is* layout, so producing one
 * would violate the design's own rule. What the agent emits is
 * `{shape, <bound data>, emphasis?, caption}`, and PD.6's deterministic compiler turns
 * `(shape, resolved series)` into a themed spec — SVG for web, PNG for email.
 *
 * **The 15 blocks are the 15 shapes.** `docs/BRIDGE-BUILD-PLAN.md` D-12 says "six enum values",
 * which is what the contract looked like before the design handoff landed; the handoff splits
 * charts into one block per *question* — "WHAT MOVED IT?" → BLK-WATERFALL, "WHERE'S FAIR?" →
 * BLK-RANGE — and that question-indexed vocabulary is the selection contract. So {@link CHART_SHAPES}
 * has fifteen members and each block pins its own via `z.literal`. The enum still exists as a
 * closed vocabulary: a payload naming `sankey`, or naming `waterfall` inside BLK-LINE, is refused.
 * The questions live in `ops.story_blocks.chart_question` and are mirrored here as
 * {@link CHART_QUESTION_BY_SHAPE} for the selector; they are not payload fields, because the
 * question is a property of the block the agent chose, not something it restates.
 *
 * **Where the payload is not a flat `series`.** Nine shapes are a list of bound series and use the
 * common `series` field. Six are structurally different on their own cards — a scatter is points
 * with three variables each, a waterfall has a start and an end that sit on the baseline, a range
 * has bear/base/bull and a live marker — and forcing those into `series[]` would lose exactly the
 * structure the compiler needs. Those keep `shape`, `caption` and `emphasis` and name their data
 * field explicitly. Every data-bearing field, in all fifteen, is a binding.
 *
 * @see docs/architecture/09-signal-to-article.md §5.5
 */
import { z } from "zod";

import {
  ChartEmphasis,
  ChartSeries,
  ObjectBinding,
  blockSchema,
  prose,
} from "./binding";
import type { BlockCode } from "./codes";

/**
 * The closed shape vocabulary — one per D-family block. The chart compiler switches on this and
 * nothing else; a shape it does not know is a refusal, not a default chart.
 */
export const CHART_SHAPES = [
  "line",
  "area",
  "bars",
  "stack",
  "waterfall",
  "scatter",
  "distribution",
  "dumbbell",
  "slope",
  "range",
  "heat",
  "indexed",
  "donut",
  "cover",
  "candle",
] as const;

export const ChartShape = z.enum(CHART_SHAPES);
export type ChartShape = (typeof CHART_SHAPES)[number];

/** Block code → shape. The compiler resolves a block to its shape through this map. */
export const SHAPE_BY_BLOCK = {
  "BLK-LINE": "line",
  "BLK-AREA": "area",
  "BLK-BARS": "bars",
  "BLK-STACK": "stack",
  "BLK-WATERFALL": "waterfall",
  "BLK-SCATTER": "scatter",
  "BLK-DIST": "distribution",
  "BLK-DUMBBELL": "dumbbell",
  "BLK-SLOPE": "slope",
  "BLK-RANGE": "range",
  "BLK-HEAT": "heat",
  "BLK-INDEXED": "indexed",
  "BLK-DONUT": "donut",
  "BLK-COVER": "cover",
  "BLK-CANDLE": "candle",
} as const satisfies Partial<Record<BlockCode, ChartShape>>;

/**
 * The selection contract: the question each shape answers, verbatim from the design card's
 * allowed-piece-types slot (and stored in `ops.story_blocks.chart_question`). Three shapes —
 * `donut`, `cover`, `candle` — carry a *subject* on the card ("OWNERSHIP · CAPITAL", "IPO PROFILE",
 * "LISTING DAY") rather than a question, so they are `null` here rather than given an invented one.
 */
export const CHART_QUESTION_BY_SHAPE: Record<ChartShape, string | null> = {
  line: "WHEN DID IT TURN?",
  area: "HOW MUCH NOW?",
  bars: "WHO IS BIGGEST?",
  stack: "WHAT'S IT MADE OF?",
  waterfall: "WHAT MOVED IT?",
  scatter: "WHO'S POSITIONED?",
  distribution: "HOW SPREAD OUT?",
  dumbbell: "WHAT CHANGED?",
  slope: "WHO OVERTOOK WHOM?",
  range: "WHERE'S FAIR?",
  heat: "WHERE'S THE PATTERN?",
  indexed: "VS WHAT?",
  donut: null,
  cover: null,
  candle: null,
};

/** Fields every D-family payload carries, whatever its data shape. */
const chartEnvelope = <S extends ChartShape>(shape: S) => ({
  shape: z
    .literal(shape)
    .describe(`Fixed for this block. The compiler maps (shape, resolved data) to a Vega-Lite spec.`),
  caption: prose("The exhibit's caption — what the reader should take from it."),
  emphasis: ChartEmphasis.optional(),
});

/**
 * BLK-LINE · Annotated time series — "WHEN DID IT TURN?"
 *
 * "EVERY LINE CHART MUST ANNOTATE ITS INFLECTION OR IT IS DECORATION" is the card's hard rule, so
 * `annotation` is **required**, not optional. The marker's y position, the gridlines and the
 * baseline are all in the card's payload list and all omitted here: they are geometry, and geometry
 * is the compiler's.
 */
export const BLK_LINE = blockSchema(
  "BLK-LINE",
  "Annotated time series",
  "One series, and the inflection the prose is about. A line chart without its annotation is decoration — so the annotation is required, not optional.",
  {
    ...chartEnvelope("line"),
    series: z.array(ChartSeries).length(1).describe("The single time series to draw."),
    annotation: z
      .strictObject({
        at: z
          .string()
          .min(1)
          .describe("Where on the x axis the event sits — an ISO date or the period label."),
        what_happened: prose("The event the dashed vertical and hollow marker point at."),
      })
      .describe("Mandatory. The event the prose is about."),
  },
);

/**
 * BLK-AREA · Share-of-total area — "HOW MUCH NOW?"
 *
 * "NEVER STACK MORE THAN 3 AREAS · BEYOND THAT USE BLK-STACK" → `.max(3)`, which also encodes the
 * routing rule: an agent that wants a fourth area is told, by the refusal, to pick a different
 * block. "FILL ONLY WHEN THE AREA MEANS SOMETHING" is a judgement and stays in the description.
 */
export const BLK_AREA = blockSchema(
  "BLK-AREA",
  "Share-of-total area",
  "Fill only when the area means something — a share, a cumulative total. Never more than three areas; beyond that the block is BLK-STACK.",
  {
    ...chartEnvelope("area"),
    series: z.array(ChartSeries).min(1).max(3).describe("One to three areas. The baseline and the terminal marker are the compiler's."),
  },
);

/**
 * BLK-BARS · Categorical bars — "WHO IS BIGGEST?"
 *
 * "GREY DOWN THE TAIL TO FOCUS THE LEAD" becomes `lead_count`: how many entries stay ink before the
 * ramp greys them out. The sort order ("categories sorted descending") is computed from the
 * resolved values, and "VALUE LABELS ON TOP, NEVER AN AXIS" is a render rule, so neither is a field.
 */
export const BLK_BARS = blockSchema(
  "BLK-BARS",
  "Categorical bars",
  "One bar per category, sorted descending by the resolved value. Value labels on top, never an axis. The tail greys down so the lead reads first.",
  {
    ...chartEnvelope("bars"),
    series: z.array(ChartSeries).min(2).describe("One entry per category."),
    lead_count: z
      .int()
      .min(1)
      .default(1)
      .describe("How many leading bars stay ink before the tail greys down."),
  },
);

/**
 * BLK-STACK · Proportional bar — "WHAT'S IT MADE OF?"
 *
 * "MAX 4 SEGMENTS" → `.max(4)`. "IF A SEGMENT IS UNDER 5% MERGE IT INTO 'OTHER'" and "summing to
 * 100%" are properties of the *resolved* values, so they are compiler/fit-stage checks; a schema
 * cannot see them because it never sees a number.
 */
export const BLK_STACK = blockSchema(
  "BLK-STACK",
  "Proportional bar",
  "One bar, at most four segments, labels inside. Segments order largest to smallest and must sum to 100%; anything under 5% merges into 'Other' — both checked on the resolved values.",
  {
    ...chartEnvelope("stack"),
    series: z.array(ChartSeries).min(2).max(4).describe("The segments. Ordered largest to smallest by the compiler."),
  },
);

/**
 * BLK-WATERFALL · Bridge — "WHAT MOVED IT?"
 *
 * "START AND END BARS SIT ON THE BASELINE" is why they are their own fields rather than the first
 * and last of `series`: they are a different kind of bar and the compiler treats them differently.
 * "4–6 DRIVERS" bounds the middle. The sign of each driver comes from its resolved value, never
 * from the writer — green and red here are direction, and hard rule #1 does not let them be
 * anything else. `end.is_estimate` is the FY26E suffix, and follows hard rule #3's "the agent
 * supplies only an `is_estimate` flag".
 */
export const BLK_WATERFALL = blockSchema(
  "BLK-WATERFALL",
  "Bridge",
  "Start bar, four to six drivers, end bar. Start and end sit on the baseline; connectors are dashed. Driver signs come from the resolved values — the colour is direction, never emphasis.",
  {
    ...chartEnvelope("waterfall"),
    start: ChartSeries.describe("The opening level. Sits on the baseline."),
    series: z.array(ChartSeries).min(4).max(6).describe("The drivers, in bridge order."),
    end: ChartSeries.extend({
      is_estimate: z
        .boolean()
        .default(false)
        .describe("True when the closing level is a forecast — the renderer adds the E suffix."),
    }).describe("The closing level. Sits on the baseline."),
  },
);

/**
 * BLK-SCATTER · Bubble scatter — "WHO'S POSITIONED?"
 *
 * Three bound variables per point, so this shape cannot use a flat `series[]`. "RADIUS = A THIRD
 * VARIABLE, ALWAYS STATED" → `radius_label` is required; an unnamed bubble size is unreadable.
 * "RATING DRIVES THE OUTLINE COLOUR" → an enum, not a colour: the payload must not be able to name
 * a hex value, because hard rule #1 reserves the accents for direction.
 *
 * The quadrant medians and the axis lines are in the card's payload list and omitted here — they
 * are computed from the resolved points.
 */
export const BLK_SCATTER = blockSchema(
  "BLK-SCATTER",
  "Bubble scatter",
  "Two axes and a bubble radius, all bound. The third variable is always named. Quadrant lines sit at the medians, computed from the resolved points. Only the argument's names are labelled.",
  {
    ...chartEnvelope("scatter"),
    x_label: z.string().min(1).describe("What the x axis measures."),
    y_label: z.string().min(1).describe("What the y axis measures."),
    radius_label: z
      .string()
      .min(1)
      .describe("What the bubble radius measures. Mandatory — an unstated third variable is unreadable."),
    points: z
      .array(
        z.strictObject({
          ticker: z.string().min(1),
          x: ObjectBinding,
          y: ObjectBinding,
          r: ObjectBinding.describe("The third variable."),
          rating: z
            .enum(["positive", "negative", "neutral"])
            .describe("Drives the outline. An enum, not a colour — the payload may not name an accent."),
          is_labelled: z
            .boolean()
            .default(false)
            .describe("Only the names the argument is about carry a label."),
        }),
      )
      .min(2),
  },
);

/**
 * BLK-DIST · Distribution — "HOW SPREAD OUT?"
 *
 * **Judgement call.** The card lists "bins, each {bucket, count/magnitude, sign}" plus three
 * summary labels as payload. Under D-8 that is the wrong cut: bins and summary statistics are
 * *derived* from a population, and an agent that emits twenty bin counts is emitting twenty
 * numbers. So the payload binds the population once and the compiler bins it and computes the
 * positive/median/negative labels. The zero line, the bar widths and which side each bar hangs on
 * are geometry.
 */
export const BLK_DIST = blockSchema(
  "BLK-DIST",
  "Distribution",
  "The population is bound once; the compiler bins it, draws the heavy zero rule, hangs the bars both ways and computes the positive/median/negative summary. The agent never enumerates bins.",
  {
    ...chartEnvelope("distribution"),
    series: z
      .array(ChartSeries)
      .length(1)
      .describe("The population of values to bin — typically a set of changes, signed around zero."),
    bin_count: z
      .int()
      .min(3)
      .max(24)
      .optional()
      .describe("Optional hint. Omit and the compiler picks."),
  },
);

/**
 * BLK-DUMBBELL · Before / after — "WHAT CHANGED?"
 *
 * Two bound values per row, so no flat `series[]`. "HOLLOW = OLD TARGET · SOLID = NEW" is why the
 * fields are named `old` and `new` rather than `a`/`b` — the mapping to the marker style is fixed.
 * The delta label is computed from the two resolved values; the writer does not get to state it.
 */
export const BLK_DUMBBELL = blockSchema(
  "BLK-DUMBBELL",
  "Before / after",
  "The best block for price-target and estimate revisions. Hollow marker is the old value, solid is the new; the delta label and its direction colour are computed from the two resolved values.",
  {
    ...chartEnvelope("dumbbell"),
    rows: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Ticker or row label."),
          old: ObjectBinding.describe("The superseded value — hollow marker."),
          new: ObjectBinding.describe("The current value — solid marker."),
        }),
      )
      .min(1)
      .describe("All rows share one x scale."),
  },
);

/**
 * BLK-SLOPE · Rank change — "WHO OVERTOOK WHOM?"
 *
 * "TWO PERIODS ONLY" → a two-element tuple, so a third period is a parse failure rather than a
 * squeezed chart. "MORE THAN 6 LINES AND IT STOPS READING" → `.max(6)`.
 *
 * **Not a field:** the card's "which pair crosses". A crossing is a fact about the resolved values —
 * the compiler finds it, and "ONLY THE CROSSING PAIR GETS COLOUR" follows from that. Letting the
 * writer nominate the crossing pair would let it colour a pair that does not cross.
 */
export const BLK_SLOPE = blockSchema(
  "BLK-SLOPE",
  "Rank change",
  "Two periods, at most six lines. The crossing pair is found in the resolved values and is the only pair that takes colour — everything else greys out.",
  {
    ...chartEnvelope("slope"),
    period_labels: z
      .tuple([z.string().min(1), z.string().min(1)])
      .describe("Exactly two period labels, e.g. ['2025', '2026 YTD']."),
    entities: z
      .array(
        z.strictObject({
          label: z.string().min(1),
          start: ObjectBinding.describe("Rank or value at period 1."),
          end: ObjectBinding.describe("Rank or value at period 2."),
        }),
      )
      .min(2)
      .max(6),
  },
);

/**
 * BLK-RANGE · Valuation range — "WHERE'S FAIR?"
 *
 * "MUST STATE THE METHOD AND BASIS · A RANGE WITHOUT A DECK IS A GUESS" is the whole card, and it
 * is machine-checkable: `method` and `basis` are required prose. Four bound values — the three
 * range points plus the live price the diamond marker sits on.
 */
export const BLK_RANGE = blockSchema(
  "BLK-RANGE",
  "Valuation range",
  "Bear, base and bull spans with the live price as the marker. A range without a stated method and basis is a guess, so both are required.",
  {
    ...chartEnvelope("range"),
    method: prose("The valuation method, e.g. `EV/EBITDA on FY26E`."),
    basis: prose("The basis it rests on — the commodity deck, the peer set, the discount rate."),
    bear: ObjectBinding,
    base: ObjectBinding,
    bull: ObjectBinding,
    last_price: ObjectBinding.describe("Live or last price. The diamond marker's position."),
  },
);

/**
 * BLK-HEAT · Mini heat grid — "WHERE'S THE PATTERN?"
 *
 * **Judgement call.** An 8×8 grid is 64 values; enumerating them as 64 bindings would be absurd and
 * as 64 literals would be indefensible. The card's `binds_to` names "the shared sector-heatmap
 * change ramp (single-sourced with screen 1e)", i.e. one matrix object, so the payload binds the
 * matrix once and supplies the axis labels. "SAME 7-STOP RAMP AS THE SECTOR HEATMAP — NEVER INVENT
 * A SECOND SCALE" is enforced by there being no scale field at all.
 */
export const BLK_HEAT = blockSchema(
  "BLK-HEAT",
  "Mini heat grid",
  "At most 8×8. The matrix binds as one object and renders on the shared seven-stop change ramp — there is no scale field, because a second scale is never permitted.",
  {
    ...chartEnvelope("heat"),
    row_labels: z.array(z.string().min(1)).min(1).max(8).describe("Row labels, e.g. sectors."),
    column_labels: z.array(z.string().min(1)).min(1).max(8).describe("Column labels, e.g. quarters."),
    matrix: ObjectBinding.describe(
      "The change matrix, row-major, shaped to row_labels × column_labels. Mapped onto the shared seven-stop ramp.",
    ),
  },
);

/**
 * BLK-INDEXED · Rebased performance — "VS WHAT?"
 *
 * "ALWAYS SHOW THE BENCHMARK" → `benchmark` is a required field, not an optional second series;
 * that is the difference between a rule and a convention. "ALWAYS REBASE TO 100" is the compiler's
 * job — the bound series are the raw levels, and rebasing in the payload would mean the agent doing
 * arithmetic. The legend's total-return figures are computed from the rebased series for the same
 * reason.
 */
export const BLK_INDEXED = blockSchema(
  "BLK-INDEXED",
  "Rebased performance",
  "Subject solid, benchmark dashed, both rebased to 100 by the compiler. The benchmark is a required field because showing it is a rule, not a preference.",
  {
    ...chartEnvelope("indexed"),
    subject: ChartSeries.describe("The subject's price or level series. Label is the ticker."),
    benchmark: ChartSeries.describe("The benchmark series. Never optional."),
  },
);

/**
 * BLK-DONUT · Composition ring — ownership / capital.
 *
 * "MAX 5 SEGMENTS" → `.max(5)`. "THE HOLE CARRIES THE ONE NUMBER THAT MATTERS" → `centre_value` is
 * a required binding: the hole is the block's headline figure and printing an unbound number there
 * would be the worst place in the design to do it. "MONOCHROME RAMP, DARKEST = LARGEST" is the
 * renderer's and needs no field.
 */
export const BLK_DONUT = blockSchema(
  "BLK-DONUT",
  "Composition ring",
  "At most five segments on a monochrome ramp, darkest largest. The hole carries the one number that matters — and it is bound.",
  {
    ...chartEnvelope("donut"),
    series: z.array(ChartSeries).min(2).max(5).describe("The segments, largest to smallest."),
    centre_label: z.string().min(1).describe("Label in the hole, e.g. `FLOAT`."),
    centre_value: ObjectBinding.describe("The one number that matters."),
  },
);

/**
 * BLK-COVER · Subscription cover meter — IPO profile.
 *
 * "THE 1.0× LINE IS ALWAYS DRAWN IN RED — below it an offer is undersubscribed, which is the story."
 * The 1.0× line needs no field: it is always drawn, which is the point.
 *
 * The cover multiples bind. `day_of` / `day_total` and `closes_at` stay literal — they are the
 * offer's published schedule, printed as-is rather than computed, and the same treatment
 * BLK-COUNTDOWN gives a deadline.
 */
export const BLK_COVER = blockSchema(
  "BLK-COVER",
  "Subscription cover meter",
  "The headline cover multiple against a scale whose 1.0× line is always drawn in red. Below 1.0× an offer is undersubscribed, which is the story.",
  {
    ...chartEnvelope("cover"),
    headline_tranche: z.string().min(1).describe("Which tranche the headline multiple is, e.g. `INSTITUTIONAL`."),
    headline_cover: ObjectBinding.describe("The headline cover multiple."),
    tranches: z
      .array(
        z.strictObject({
          label: z.string().min(1).describe("Tranche name, e.g. `Retail`."),
          cover: ObjectBinding.describe("Cover multiple for this tranche."),
        }),
      )
      .min(1)
      .describe("Per-tranche covers — institutional, retail, and any others the book has."),
    scale_max: z.number().gt(1).describe("Top of the scale, e.g. 4.0. The floor is always 0 and the 1.0× line is always drawn."),
    day_of: z.int().min(1).describe("Which day of the book this is."),
    day_total: z.int().min(1).describe("How many days the book runs."),
    closes_at: z.iso.datetime({ offset: true }).describe("Absolute close, with offset."),
  },
);

/**
 * BLK-CANDLE · Session candles — listing day.
 *
 * "ON A DEBUT THE REFERENCE LINE IS THE OFFER PRICE, NOT A PRIOR CLOSE" is the trap this block
 * exists to avoid, so `is_debut` and the bound `reference_value` are both required and the renderer
 * derives the label from them. OHLC binds as one series object rather than as four values per
 * interval — a session is dozens of candles, and enumerating them would be the D-8 failure at scale.
 */
export const BLK_CANDLE = blockSchema(
  "BLK-CANDLE",
  "Session candles",
  "One bound OHLC series. On a debut the reference line is the offer price, never a prior close — which is why the debut flag and the reference are both required.",
  {
    ...chartEnvelope("candle"),
    candles: ObjectBinding.describe("The OHLC series for the session, one candle per interval."),
    is_debut: z
      .boolean()
      .describe("True on a listing day. Decides whether the reference line is the offer price or the prior close."),
    reference_value: ObjectBinding.describe(
      "The dashed reference line: the offer price on a debut, the prior close otherwise.",
    ),
    reference_label: z.string().min(1).describe("Label for the reference line, e.g. `OFFER 27.00`."),
  },
);

/*
 * The closed block vocabulary (PD.5 · DEF-BLOCK-RENDERERS-ABSENT).
 *
 * Source of truth, in order of authority:
 *   1. docs/design/artifacts/artifact-library-61-blocks.html  (the cards — the HTML wins)
 *   2. docs/design/block-registry.json                        (machine-readable extraction)
 *   3. ops.story_blocks                                       (runtime, seeded from the JSON)
 *
 * `BlockCode` enumerates all 61 codes so the renderer registry can be typed
 * against the whole vocabulary even while only families G, A and C are built.
 * `ImplementedBlockCode` is the subset that has a renderer today — everything
 * else resolves to `MissingBlock` (loud, logged, non-fatal; the *publisher*
 * hard-refuses, per architecture/09-signal-to-article.md §6.1).
 *
 * These are BOUND renderers. A block with `requires_binding` receives resolved
 * values; it never fabricates one. Where a value is missing the block renders
 * the honest em-dash, never a plausible number.
 */

/* ── The 61 codes, by family ─────────────────────────────────────────────── */

/** A · Inline — live inside a sentence; no borders, no vertical margin. */
export type BlockCodeA =
  | "BLK-TICKER"
  | "BLK-DELTA"
  | "BLK-CITE"
  | "BLK-TERM"
  | "BLK-SPARK"
  | "BLK-MARGIN";

/** B · Statement — where the desk commits to a view. */
export type BlockCodeB =
  | "BLK-THESIS"
  | "BLK-PULLQUOTE"
  | "BLK-BIGNUM"
  | "BLK-VERDICT"
  | "BLK-TAKE"
  | "BLK-FALSIFY";

/** C · Tabular — mono numerals, hairline rows, marked estimate columns. */
export type BlockCodeC =
  | "BLK-STATSTRIP"
  | "BLK-KEYSTATS"
  | "BLK-FINTABLE"
  | "BLK-SCENARIO"
  | "BLK-RANKROW"
  | "BLK-BEATMISS"
  | "BLK-EXDATE"
  | "BLK-COMPARE";

/** D · Charts — one shape per question; compiled by PD.6, not hand-drawn. */
export type BlockCodeD =
  | "BLK-LINE"
  | "BLK-AREA"
  | "BLK-BARS"
  | "BLK-STACK"
  | "BLK-WATERFALL"
  | "BLK-SCATTER"
  | "BLK-DIST"
  | "BLK-DUMBBELL"
  | "BLK-SLOPE"
  | "BLK-RANGE"
  | "BLK-HEAT"
  | "BLK-INDEXED"
  | "BLK-DONUT"
  | "BLK-COVER"
  | "BLK-CANDLE";

/** E · Mechanism — teach a process; evergreen, review-dated. */
export type BlockCodeE =
  | "BLK-TIMELINE"
  | "BLK-STEPS"
  | "BLK-FLOW"
  | "BLK-ANATOMY"
  | "BLK-WORKED"
  | "BLK-MYTH"
  | "BLK-DECISION"
  | "BLK-GLOSSARY";

/** F · Wire & live state — every block here carries a clock. */
export type BlockCodeF =
  | "BLK-TAPEROW"
  | "BLK-CHIPROW"
  | "BLK-SNAPSHOT"
  | "BLK-COUNTDOWN"
  | "BLK-HALT"
  | "BLK-CORRECTION"
  | "BLK-BREADTH"
  | "BLK-VENUEHEAD";

/** G · Provenance & trust — the audit trail, rendered. */
export type BlockCodeG =
  | "BLK-PROV"
  | "BLK-AGENTS"
  | "BLK-FRESH"
  | "BLK-ESTIMATE"
  | "BLK-CONFLICT"
  | "BLK-RULE";

/** H · Gates & CTAs — where the business model touches the page. */
export type BlockCodeH = "BLK-CUT" | "BLK-PAYWALL" | "BLK-ALERTCTA" | "BLK-DOWNLOAD";

export type BlockCode =
  | BlockCodeA
  | BlockCodeB
  | BlockCodeC
  | BlockCodeD
  | BlockCodeE
  | BlockCodeF
  | BlockCodeG
  | BlockCodeH;

/** The codes that have a renderer today: G, then A, then C. */
export type ImplementedBlockCode =
  | BlockCodeG | BlockCodeA | BlockCodeC | BlockCodeB | BlockCodeE | BlockCodeF
  | "BLK-CUT" | "BLK-PAYWALL" | "BLK-ALERTCTA" | "BLK-DOWNLOAD"
  | BlockCodeD;

export type BlockFamily = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/* ── Shared value vocabulary ─────────────────────────────────────────────── */

/**
 * Direction, never emphasis. Hard rule 1: green #0a7a3c and red #c0342b are
 * reserved for direction; `null`/"flat" means ink. The arrow glyph and the
 * colour are supplied INDEPENDENTLY (see `Delta`) because a falling cost of
 * funds points down and is green.
 */
export type Direction = "up" | "down" | "flat";

/**
 * A resolved value. `null` means the binding produced nothing — the renderer
 * prints an em-dash. It never guesses, and callers must never substitute a
 * plausible figure (standing law of the codebase).
 */
export type BoundValue = string | null;

/* ── G · Provenance & trust ──────────────────────────────────────────────── */

/** GREEN DIAMOND = VERIFIED · INK = DESK COMPUTATION · AMBER = PENDING. */
export type ProvStatus = "verified" | "desk" | "pending";

export interface ProvPayload {
  /** Lake object type, e.g. "FILING.SEGMENT.REVENUE". */
  objectType: string;
  /** Entity the object is about, e.g. "2222". */
  entity?: string | null;
  /** Coverage / depth, e.g. "29 QUARTERS". */
  coverage?: BoundValue;
  /** Verifying agent id, e.g. "DATA-TDWL". */
  agent: string;
  /** Verification timestamp as already-formatted text, e.g. "09:04". */
  verifiedAt?: BoundValue;
  /** Source class, e.g. "FILED STATEMENTS, NOT VENDOR FEED". */
  sourceClass: string;
  status: ProvStatus;
}

export interface AgentsChainEntry {
  name: string;
  /** Agents carry ◆ (added by the renderer, never by the payload). */
  isAgent: boolean;
}

export interface AgentsPayload {
  narrative: string;
  /** Ordered build chain. The human editor is always the final entry. */
  chain: AgentsChainEntry[];
  /** Section kicker; the specimen reads "HOW THIS WAS BUILT". */
  kicker?: string;
}

/** Exactly four states — never a number without one of them. */
export type FreshState = "live" | "delayed" | "closed" | "offline";

export interface FreshPayload {
  state: FreshState;
  /** LIVE: formatted time + zone, e.g. "14:32 GST". */
  timestamp?: BoundValue;
  /** DELAYED: venue code, e.g. "MSX". */
  venue?: BoundValue;
  /** DELAYED: delay in minutes. */
  delayMinutes?: number | null;
  /** CLOSED: last-close reference, e.g. "THU CLOSE". */
  lastClose?: BoundValue;
  /** FEED OFFLINE: retry count. */
  retryCount?: number | null;
}

export interface EstimatePeriod {
  /** Period label WITHOUT the E suffix — the renderer owns the suffix. */
  label: string;
  value: BoundValue;
}

export interface EstimatePayload {
  /** The filed figure, muted. */
  actual: EstimatePeriod;
  /** The desk figure: E suffix + ink header + bold value, all three at once. */
  estimate: EstimatePeriod;
  /** Attribution badge; the specimen reads "MARSAD DESK". */
  attribution?: string;
  /** Footnote stating this is a desk computation, not a company disclosure. */
  note: string;
}

export interface ConflictSource {
  label: string;
  value: BoundValue;
  /** Primary wins unless overridden; the primary value is the bold one. */
  isPrimary?: boolean;
}

export interface ConflictPayload {
  /** What is withheld, e.g. "Q2 free cash flow". The FIGURE itself is not shown. */
  figure: string;
  period?: BoundValue;
  /** Exactly two: the vendor feed and the primary filing. */
  sources: ConflictSource[];
  /** Why nothing is quoted, and which source wins on resolution. */
  resolution: string;
}

export interface RulePayload {
  /** Id from the publishing ruleset, e.g. "R-06". Naming it is the point. */
  ruleId: string;
  /** What the rule requires, in plain language. */
  requirement: string;
  /** How it shaped this specific piece. */
  shapedThisPiece?: BoundValue;
  /** The automated check that enforces it. */
  automatedCheck?: BoundValue;
}

/* ── A · Inline ──────────────────────────────────────────────────────────── */

/**
 * Inline blocks carry their host sentence with numbered slots — `{0}`, `{1}` —
 * marking where each inline unit sits. The writer emits prose; the renderer
 * substitutes the bound unit. An unmatched slot is a loud, non-fatal warning.
 */
export interface InlineHost {
  hostText: string;
}

export interface TickerQuote {
  last: BoundValue;
  change: BoundValue;
  venue?: BoundValue;
  name?: BoundValue;
}

export interface TickerUnit {
  /** Instrument code, e.g. "2222". */
  ticker: string;
  /** Formatted change with sign, e.g. "−0.6%". */
  changePct: BoundValue;
  direction: Direction;
  /** Hover quote card payload; omitted → no card. */
  quote?: TickerQuote;
}

export interface TickerPayload extends InlineHost {
  tickers: TickerUnit[];
}

export interface DeltaUnit {
  /** Magnitude + unit as text, e.g. "110 bp". */
  magnitude: BoundValue;
  /** The LITERAL movement — which glyph is drawn. */
  arrow: "up" | "down";
  /** The SEMANTIC reading — which colour is used. Independent of `arrow`. */
  polarity: "good" | "bad" | "neutral";
}

export interface DeltaPayload extends InlineHost {
  deltas: DeltaUnit[];
}

export interface CitationUnit {
  /** The lake object this claim resolves to. Mandatory (R-03). */
  objectId: string;
  /** Source label, e.g. "FY25 annual report, p.47". */
  label: string;
  kind: "filing" | "desk";
  /** Optional resolver href back to the object. */
  href?: string | null;
}

export interface CitePayload extends InlineHost {
  citations: CitationUnit[];
}

export interface TermUnit {
  /** The term exactly as it appears in prose. */
  term: string;
  glossaryKey: string;
  /** Uppercase mono tooltip header, e.g. "T+2 SETTLEMENT". */
  label?: BoundValue;
  /** One or two sentences. Omitted → no definition card is drawn. */
  definition?: BoundValue;
}

export interface TermPayload extends InlineHost {
  terms: TermUnit[];
}

export interface SparkPayload extends InlineHost {
  /** One numeric series, ≤ 30 points. x is implied even spacing. */
  series: number[];
}

export interface MarginPayload {
  /** The paragraph the note annotates. */
  hostText: string;
  /** Note label; defaults to "NOTE". */
  label?: string;
  /** One or two sentences. Never load-bearing — the argument survives skipping it. */
  body: string;
}

/* ── C · Tabular ─────────────────────────────────────────────────────────── */

export interface StatCell {
  label: string;
  value: BoundValue;
  /**
   * Direction colour ONLY where the value is a change, and SEMANTIC like every
   * other direction in the system: the specimen's "VS PHASE 1 · −18%" is `up`,
   * because a unit cost 18% below Phase 1 is the good news, not the bad.
   */
  direction?: Direction | null;
}

export interface StatStripPayload {
  /** 3–5 cells, one fact each. */
  cells: StatCell[];
}

export interface KeyStatCell {
  label: string;
  value: BoundValue;
}

export interface KeyStatsPayload {
  /** 4 or 8 cells — no other counts. */
  cells: KeyStatCell[];
  footnote?: BoundValue;
}

export interface FinPeriod {
  /** Period label WITHOUT the E suffix. The renderer adds it. */
  label: string;
  /** The ONLY estimate signal the agent supplies; the renderer owns the rest. */
  isEstimate?: boolean;
}

export interface FinRow {
  label: string;
  /** One value per period, positionally aligned with `periods`. */
  values: BoundValue[];
  /** Tinted + bold headline row (the specimen emphasises Revenue). */
  emphasis?: boolean;
}

export interface FinTablePayload {
  /** Unit header, e.g. "OMR M". */
  unit: string;
  periods: FinPeriod[];
  /** ≤ 8 rows inline; longer tables go to the XLSX. */
  rows: FinRow[];
  /** Footnote explaining the estimate marking. */
  footnote?: BoundValue;
}

export interface ScenarioRow {
  name: string;
  eps: BoundValue;
  /** Signed return, e.g. "+31%". */
  returnPct: BoundValue;
  returnDirection: Direction;
  /** Every path needs an OBSERVABLE trigger. */
  trigger: string;
  isBase?: boolean;
}

export interface ScenarioPayload {
  /** Ink title bar, e.g. "THREE PATHS TO 2028". */
  title: string;
  /** Exactly three. */
  rows: ScenarioRow[];
}

export interface RankRow {
  rank: number;
  name: string;
  /** Venue code — TDWL / QE / MSX / ADX / DFM / BHB. */
  venue: BoundValue;
  /** The ranked metric. */
  value: BoundValue;
  /** The qualifying metric — a yield table without payout is a trap. */
  qualifier: BoundValue;
  /** Turns the qualifier red (e.g. payout > 100%). */
  qualifierFlagged?: boolean;
}

export interface RankRowPayload {
  /** 5–10 rows. */
  rows: RankRow[];
  footnote?: BoundValue;
}

export interface BeatMissRow {
  name: string;
  ticker: BoundValue;
  actual: BoundValue;
  consensus: BoundValue;
  surprise: BoundValue;
  surpriseDirection: Direction;
  /** Price reaction at the T+0 close, never intraday. */
  reaction: BoundValue;
  reactionDirection: Direction;
}

export interface BeatMissPayload {
  rows: BeatMissRow[];
  footnote?: BoundValue;
}

export interface ExDateRow {
  ticker: string;
  /** INTERIM / FINAL / SPECIAL / … — SPECIAL inverts to ink. */
  type: string;
  dps: BoundValue;
  /** The bold column. */
  exDate: BoundValue;
  yieldPct: BoundValue;
  payDate: BoundValue;
}

export interface ExDatePayload {
  /** One row per declaration, not per payment. */
  rows: ExDateRow[];
  footnote?: BoundValue;
}

export interface CompareName {
  ticker: string;
  name: string;
}

export interface CompareMetric {
  label: string;
  /** One value per name, positionally aligned with `names`. */
  values: BoundValue[];
  /** Index into `values` that is best in row; bold. `null` → nothing is best. */
  bestIndex?: number | null;
}

export interface ComparePayload {
  /** 2–4 names. */
  names: CompareName[];
  /** ≤ 8 metric rows. */
  metrics: CompareMetric[];
  /** Keep the dashed empty column so the grid never reflows. */
  addSlot?: boolean;
  footnote?: BoundValue;
}

/* ── The node union ──────────────────────────────────────────────────────── */

/**
 * Every block carries a stable opaque `_key` so citations and corrections bind
 * to block IDENTITY rather than `seq`, which reordering invalidates
 * (architecture/09-signal-to-article.md §6.1).
 */
export interface BlockNodeBase {
  _key: string;
  /** The lake object this block is bound to, where `requires_binding`. */
  boundObjectId?: string | null;
}

/* ── B · Statement — where the desk commits to a view ─────────────────────── */

/**
 * "EXACTLY THREE LINES — not two, not four." The Zod schema carries `.length(3)`
 * all the way into the emitted JSON Schema, so the provider enforces it during
 * generation. The renderer still counts, because a payload can reach the page
 * from a seed or a migration without passing through a model.
 */
export interface ThesisPayload {
  kicker?: string;
  claims: string[];
}

export interface PullQuotePayload {
  /** Without surrounding quotation marks — the renderer supplies them. */
  quote: string;
  attribution: string;
}

/** ONE PER PIECE · THE FIGURE THE HEADLINE RESTS ON · ONE LAKE FIELD. */
export interface BigNumPayload {
  caption: string;
  /** Prior value and change, as prose. Its numerals are R-04's business, not a binding's. */
  contextLine?: string;
  value: BoundValue;
}

export interface VerdictPayload {
  ticker: string;
  companyName: string;
  rating: string;
  /** Mandatory by schema: a call without a prior is not a call. */
  priorRating: string;
  targetPrice: BoundValue;
  upsidePct: BoundValue;
  changedInThisNote: boolean;
}

/** Two values only — a third would unlock premium copy by accident. */
export type TakeEntitlement = "locked" | "unlocked";

export interface TakePayload {
  headline: string;
  body: string;
  badge?: string;
  unlockCtaLabel?: string;
  entitlement: TakeEntitlement;
}

export interface FalsifyPayload {
  kicker?: string;
  /** Observable events or thresholds — never sentiment. */
  falsifiers: string[];
}

/* ── D · Charts ──────────────────────────────────────────────────────────── */

/**
 * One resolved point of a series.
 *
 * `objectId` travels with every point deliberately. The binding contract's promise is per-figure,
 * and a chart is many figures: reducing a series to bare numbers would break that promise once per
 * point, and the BLK-PROV stamp under the exhibit would attest to one row while the rest went
 * unattributed. `lake.fn_resolve_series` returns the ids for exactly this reason.
 */
export interface SeriesPointNode {
  label: string;
  date: string | null;
  value: number | null;
  objectId: string;
  state: string;
}

/** A resolved series: the legend label the writer chose, and the points the lake supplied. */
export interface ChartSeriesNode {
  label: string;
  points: SeriesPointNode[];
}

export interface ChartEmphasisNode {
  series?: string;
  why?: string;
}

/**
 * BLK-LINE · "WHEN DID IT TURN?"
 *
 * The card's hard rule is that a line chart without its annotation is decoration, so `annotation`
 * is required by the Zod schema rather than optional — and this type mirrors that.
 */
export interface LinePayload {
  caption: string;
  series: ChartSeriesNode[];
  annotation: { at: string; whatHappened: string };
  emphasis?: ChartEmphasisNode;
  unit?: string | null;
}

/** BLK-AREA · "HOW MUCH NOW?" — one to three areas; a fourth is BLK-STACK's job. */
export interface AreaPayload {
  caption: string;
  series: ChartSeriesNode[];
  emphasis?: ChartEmphasisNode;
  unit?: string | null;
}

/**
 * BLK-BARS · "WHO IS BIGGEST?"
 *
 * Each series entry is one CATEGORY, not a time series — so each resolves to a single point. The
 * tail greys down past `leadCount` so the lead reads first.
 */
export interface BarsPayload {
  caption: string;
  series: ChartSeriesNode[];
  leadCount: number;
  emphasis?: ChartEmphasisNode;
  unit?: string | null;
}

/**
 * The remaining twelve D shapes.
 *
 * Nine of the fifteen are a list of bound series and reuse `ChartSeriesNode`. Six are structurally
 * different on their own cards — a scatter is points carrying three variables each, a waterfall has
 * a start and an end sitting on the baseline, a range has bear/base/bull plus a live marker — and
 * forcing those into `series[]` would lose exactly the structure the shape needs. Those name their
 * data field explicitly.
 */

/** BLK-STACK · "WHAT'S IT MADE OF?" — max 4 segments; under 5% merges into "other". */
export interface StackSegment {
  label: string;
  value: number | null;
  objectId: string;
  state: string;
}
export interface StackPayload {
  caption: string;
  segments: StackSegment[];
  unit?: string | null;
}

/** BLK-WATERFALL · "WHAT MOVED IT?" — 4–6 drivers between a start and an end on the baseline. */
export interface WaterfallStep {
  label: string;
  /** Signed: the contribution this driver made. */
  value: number | null;
  objectId: string;
  state: string;
}
export interface WaterfallPayload {
  caption: string;
  start: WaterfallStep;
  drivers: WaterfallStep[];
  end: WaterfallStep;
  unit?: string | null;
}

/** BLK-SCATTER · "WHO'S POSITIONED?" — radius is a third variable and is always stated. */
export interface ScatterPoint {
  label: string;
  x: number | null;
  y: number | null;
  /** The third variable. Its meaning is named in `radiusMeans` — never left implicit. */
  r: number | null;
  /** Drives the outline: a positive call, a negative one, or unrated. */
  rating?: "positive" | "negative" | null;
  objectId: string;
  state: string;
}
export interface ScatterPayload {
  caption: string;
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  /** Mandatory: a bubble whose size means nothing stated is a decoration. */
  radiusMeans: string;
  unit?: string | null;
}

/** BLK-DIST · "HOW SPREAD OUT?" — bars hang both ways from a heavy zero line. */
export interface DistPayload {
  caption: string;
  series: ChartSeriesNode[];
  unit?: string | null;
}

/** BLK-DUMBBELL · "WHAT CHANGED?" — hollow is old, solid is new. */
export interface DumbbellRow {
  label: string;
  from: number | null;
  to: number | null;
  objectId: string;
  state: string;
}
export interface DumbbellPayload {
  caption: string;
  rows: DumbbellRow[];
  fromLabel: string;
  toLabel: string;
  unit?: string | null;
}

/** BLK-SLOPE · "WHO OVERTOOK WHOM?" — two periods only; only the crossing pair gets colour. */
export interface SlopeRow {
  label: string;
  from: number | null;
  to: number | null;
  objectId: string;
  state: string;
}
export interface SlopePayload {
  caption: string;
  rows: SlopeRow[];
  fromPeriod: string;
  toPeriod: string;
  unit?: string | null;
}

/** BLK-RANGE · "WHERE'S FAIR?" — a range without a stated method is a guess. */
export interface RangePayload {
  caption: string;
  bear: number | null;
  base: number | null;
  bull: number | null;
  /** The diamond marker. */
  live: number | null;
  /** Mandatory — the card's rule is that the method and basis must be stated. */
  method: string;
  basis: string;
  objectIds: string[];
  unit?: string | null;
}

/** BLK-HEAT · "WHERE'S THE PATTERN?" — max 8×8, and the ONE block that may carry the dark ramp. */
export interface HeatCell {
  value: number | null;
  objectId: string;
  state: string;
}
export interface HeatPayload {
  caption: string;
  rowLabels: string[];
  colLabels: string[];
  /** Row-major, rowLabels.length × colLabels.length. */
  cells: HeatCell[][];
  unit?: string | null;
}

/** BLK-INDEXED · "VS WHAT?" — always rebased to 100, always with the benchmark. */
export interface IndexedPayload {
  caption: string;
  subject: ChartSeriesNode;
  /** Mandatory: "vs what?" has no answer without it. */
  benchmark: ChartSeriesNode;
  unit?: string | null;
}

/** BLK-DONUT · composition ring; the hole carries the one number that matters. */
export interface DonutSegment {
  label: string;
  value: number | null;
  objectId: string;
  state: string;
}
export interface DonutPayload {
  caption: string;
  /** Max 5. Monochrome ramp, darkest = largest. */
  segments: DonutSegment[];
  /** The single figure in the hole, and what it is. */
  centreValue: string;
  centreLabel: string;
  unit?: string | null;
}

/** BLK-COVER · subscription cover meter. The 1.0× line is always drawn, in red. */
export interface CoverPayload {
  caption: string;
  /** Times covered. Below 1.0 the offer is undersubscribed, which IS the story. */
  covered: number | null;
  scaleMax: number;
  objectId: string;
  state: string;
}

/** BLK-CANDLE · session candles. On a debut the reference is the OFFER price, not a prior close. */
export interface Candle {
  label: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  objectId: string;
  state: string;
}
export interface CandlePayload {
  caption: string;
  candles: Candle[];
  /** Dashed reference line. On a debut this is the offer price — say which in `referenceLabel`. */
  reference?: number | null;
  referenceLabel?: string | null;
  unit?: string | null;
}

/* ── E · Mechanism — how a thing actually works ──────────────────────────── */

/**
 * BLK-TIMELINE · "EXACTLY ONE STAGE IN RED — THE ONE THAT COSTS MONEY IF MISSED."
 *
 * One critical stage, not zero and not two. A timeline where everything is urgent tells a reader
 * nothing about what to actually do; the single red stage is the block's entire editorial claim.
 */
export interface TimelineStage {
  name: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  description: string;
  /** Exactly one stage carries this — the one that costs money if missed. */
  isCritical: boolean;
}
export interface TimelinePayload {
  stages: TimelineStage[];
}

/** BLK-STEPS · "3–5 STEPS · A BOLD CLAIM PLUS ONE CLARIFYING LINE, NEVER A PARAGRAPH." */
export interface MechanismStep {
  /** The bold claim. */
  claim: string;
  /** One line. The numeral is the index, formatted — never a payload field. */
  clarifier: string;
}
export interface StepsPayload {
  steps: MechanismStep[];
}

/**
 * BLK-FLOW · "MAX 4 NODES, LEFT TO RIGHT · NEVER BRANCHES — USE BLK-DECISION."
 *
 * Arrow weight shows SENIORITY, not size. That inversion is deliberate and worth preserving: a
 * subordinated claim on a large sum is still subordinated, and drawing it thick because it is big
 * would say the opposite of what the diagram exists to say.
 */
export interface FlowNode {
  /** e.g. "OPERATOR", "HOLDCO", "EQUITY". */
  role: string;
  name: string;
  qualifier: string;
  /** Equity is always the pale box at the end. */
  isTerminalEquity?: boolean;
  /** The operating node renders as the inverted ink box. */
  isOperating?: boolean;
}
export interface FlowConnector {
  label: string;
  /** Senior claims draw 2px ink; subordinated draw 2px faint. NOT a size. */
  seniority: "senior" | "subordinated";
  value?: string | null;
}
export interface FlowPayload {
  nodes: FlowNode[];
  connectors: FlowConnector[];
}

/** BLK-ANATOMY · "ABSTRACTED WIREFRAME, NEVER A SCREENSHOT · TEACHES WHERE TO LOOK." */
export interface AnatomyRegion {
  /** Relative width, 0–1, of the wireframe rail. */
  width: number;
  /** critical = the figure that changes your cash · secondary = the date block · boilerplate = skip. */
  highlight: "critical" | "secondary" | "boilerplate";
}
export interface AnatomyAnnotation {
  swatch: "critical" | "secondary" | "boilerplate";
  title: string;
  why: string;
}
export interface AnatomyPayload {
  /** e.g. "TADAWUL · CG-1". */
  documentType: string;
  regions: AnatomyRegion[];
  annotations: AnatomyAnnotation[];
}

/** BLK-WORKED · "ROUND NUMBERS, REAL TICKER · MUST END IN A TOTAL ROW THAT SETTLES THE POINT." */
export interface WorkedRow {
  label: string;
  before: BoundValue;
  after: BoundValue;
}
export interface WorkedPayload {
  /** e.g. "1,000 SHARES". */
  premise: string;
  beforeLabel: string;
  afterLabel: string;
  rows: WorkedRow[];
  /** Mandatory — the row that settles the point. */
  total: WorkedRow;
  /** What the difference actually is, in a sentence. */
  closing: string;
}

/**
 * BLK-MYTH · "NEVER MOCK THE ASSUMPTION · STATE IT IN THE READER'S OWN WORDS, THEN CORRECT IT."
 *
 * The first clause is the one that matters and it is a house rule, not a style note: a reader who
 * feels mocked stops reading before the mechanism arrives, so the correction never lands.
 */
export interface MythPayload {
  /** Quoted in the reader's own words. Serif italic. */
  assumption: string;
  /** What actually happens, with the arithmetic. */
  mechanism: string;
}

/** BLK-DECISION · "ONE QUESTION, TWO OUTCOMES · NEVER NEST." */
export interface DecisionPayload {
  question: string;
  yes: string;
  no: string;
}

/**
 * BLK-GLOSSARY · auto-assembled from every BLK-TERM on the page.
 *
 * "A writer agent does not author this block, it emits BLK-TERM and this follows." So `terms` is
 * DERIVED by the projector, never written by a model — which is why there is no constraint check
 * on it here: there is no author to warn.
 */
export interface GlossaryTerm {
  term: string;
  definition: string;
}
export interface GlossaryPayload {
  terms: GlossaryTerm[];
}

/* ── F · Wire & live state — timestamped, perishable, honest about being stale ─ */

/** BLK-TAPEROW · "TIME IN THE GUTTER, VENUE UNDER IT · MAX 40 WORDS FOR AGENT AUTO-PUBLISH." */
export interface TapeRowPayload {
  /** HH:MM. Every F-family block carries a clock. */
  time: string;
  venue: string;
  category: string;
  /** e.g. "7010 · CG-1". */
  reference: string;
  headline: string;
  /** Max 40 words — the auto-publish cap, the same number the rules engine enforces. */
  body: string;
}

/** BLK-CHIPROW · "3–5 CHIPS · THE CHEAPEST WAY TO ATTACH DATA TO A 30-WORD ITEM." */
export interface DataChip {
  label: string;
  value: BoundValue;
  /** The moving number gets the ink border; context chips stay grey. */
  isMoving?: boolean;
  /** Signed direction for the moving chip, which colours the value. */
  direction?: "up" | "down" | null;
}
export interface ChipRowPayload {
  chips: DataChip[];
}

/**
 * BLK-SNAPSHOT · "ONE SERIES, NO AXES, THREE LABELS MAX · THE WIRE'S ONLY PERMITTED CHART."
 *
 * Bars are plain; the peak is ink; the latest takes the direction colour. Note this is the ONLY
 * chart the wire may carry — no D-family block may appear there — which is why it lives in F and
 * not in D despite drawing a series.
 */
export interface SnapshotBar {
  /** null = an unlabelled bar. The card allows at most three labels across the whole series. */
  label: string | null;
  value: number | null;
}
export interface SnapshotPayload {
  title: string;
  bars: SnapshotBar[];
  /** Index into `bars`. */
  peakIndex: number;
  latestIndex: number;
  latestDirection?: "up" | "down" | null;
}

/** BLK-COUNTDOWN · "ABSOLUTE DEADLINE UNDER THE RELATIVE ONE · MARSAD NEVER TAKES THE ORDER." */
export interface CountdownPayload {
  kicker: string;
  /** e.g. "2d 09h". Never shown alone. */
  relative: string;
  /** e.g. "9 JUL 13:00 GST". Mandatory — a relative clock with no absolute is unactionable. */
  absolute: string;
  context: string;
  /** Routes the reader to their broker. Marsad never takes the order. */
  ctaLabel: string;
}

/** BLK-HALT · "MUST DISTINGUISH FROZEN FROM STALE · STATES THE REASON AND THE EXPECTED LIFT." */
export interface HaltPayload {
  ticker: string;
  haltedSince: string;
  expectedLift: string;
  reason: string;
  lastTraded: BoundValue;
  /** The explicit frozen-not-stale sentence. The copy must say which. */
  frozenStatement: string;
}

/** BLK-CORRECTION · "AMBER, NOT RED — A CORRECTION IS INTEGRITY · SAYS WHETHER THE ARGUMENT SURVIVED." */
export interface CorrectionPayload {
  originalAt: string;
  correctedAt: string;
  correctedValue: string;
  wrongValue: string;
  /** Which source conflicted. */
  why: string;
  /** What was done to the lake object and to downstream pieces. */
  remediation: string;
  /** Mandatory — a correction that does not say this leaves the reader unable to judge. */
  argumentSurvived: boolean;
  ruleId?: string;
}

/** BLK-BREADTH · "MEDIAN MOVE MATTERS MORE THAN THE INDEX." */
export interface BreadthPayload {
  advancers: number;
  decliners: number;
  unchanged: number;
  medianMovePct: BoundValue;
  best: { ticker: string; pct: BoundValue };
  valueTraded: BoundValue;
}

/** BLK-VENUEHEAD · "A DEGRADED FEED IS NAMED IN THE HEADER, NOT HIDDEN IN A FOOTNOTE." */
export interface VenueIndexChip {
  label: string;
  change: BoundValue;
  /** Named in the header, in caution amber — never a footnote. */
  degraded?: boolean;
}
export interface VenueHeadPayload {
  /** e.g. "QATAR · KUWAIT · OMAN". */
  title: string;
  headline: VenueIndexChip;
  secondary: VenueIndexChip[];
  itemCount: number;
}

/* ── H · Gates ───────────────────────────────────────────────────────────── */

export interface CutPayload {
  /** Blurs into the gradient. Must end on a complete thought. */
  teaser: string;
  afterBlockIndex: number;
  /** At least one data block renders before the wall — the reader sees the work first. */
  dataBlocksBefore: number;
  ruleId?: string;
}

export interface PaywallPayload {
  kicker?: string;
  /** What specifically is behind the wall. Generic copy is refused at the fit stage. */
  behindTheWall: string;
  ctaLabel: string;
  reassurance?: string;
}

/**
 * BLK-ALERTCTA · pre-filled from the piece's own subject.
 *
 * The pre-fill is the entire idea. A reader who has just read why NIM matters for this bank
 * should not then have to describe "this bank" and "NIM" to a form — the piece already knows
 * both. An empty subject makes it a generic "create an alert" button, which the card says it
 * must never be.
 *
 * Binds an ObjectRef (the subject), not a field: nothing here reads a value, so there is no
 * resolver and no unresolved path.
 */
export interface AlertCtaPayload {
  kicker?: string;
  headline: string;
  /** The expected event and its date. */
  expected: string;
  /** Pre-filled: entity, series, condition. The reader re-specifies nothing. */
  subject: { entity: string; series: string; condition: string };
  ctaLabel: string;
}

/**
 * BLK-DOWNLOAD · "SHIPPING THE OBJECT IDS IS THE DIFFERENTIATOR."
 *
 * The ids ARE the product: they are what makes a figure in the .xlsx traceable back to the
 * filing that stated it. Anyone can ship a spreadsheet; shipping one where every figure carries
 * its lake object is what makes the research auditable.
 */
export interface DownloadPayload {
  kicker?: string;
  explainer: string;
  seriesCount: number;
  format: string;
  /** One lake object id per series in the file. */
  objectIds: string[];
}

export type BlockNode =
  // G
  | (BlockNodeBase & { code: "BLK-PROV"; payload: ProvPayload })
  | (BlockNodeBase & { code: "BLK-AGENTS"; payload: AgentsPayload })
  | (BlockNodeBase & { code: "BLK-FRESH"; payload: FreshPayload })
  | (BlockNodeBase & { code: "BLK-ESTIMATE"; payload: EstimatePayload })
  | (BlockNodeBase & { code: "BLK-CONFLICT"; payload: ConflictPayload })
  | (BlockNodeBase & { code: "BLK-RULE"; payload: RulePayload })
  // A
  | (BlockNodeBase & { code: "BLK-TICKER"; payload: TickerPayload })
  | (BlockNodeBase & { code: "BLK-DELTA"; payload: DeltaPayload })
  | (BlockNodeBase & { code: "BLK-CITE"; payload: CitePayload })
  | (BlockNodeBase & { code: "BLK-TERM"; payload: TermPayload })
  | (BlockNodeBase & { code: "BLK-SPARK"; payload: SparkPayload })
  | (BlockNodeBase & { code: "BLK-MARGIN"; payload: MarginPayload })
  // C
  | (BlockNodeBase & { code: "BLK-STATSTRIP"; payload: StatStripPayload })
  | (BlockNodeBase & { code: "BLK-KEYSTATS"; payload: KeyStatsPayload })
  | (BlockNodeBase & { code: "BLK-FINTABLE"; payload: FinTablePayload })
  | (BlockNodeBase & { code: "BLK-SCENARIO"; payload: ScenarioPayload })
  | (BlockNodeBase & { code: "BLK-RANKROW"; payload: RankRowPayload })
  | (BlockNodeBase & { code: "BLK-BEATMISS"; payload: BeatMissPayload })
  | (BlockNodeBase & { code: "BLK-EXDATE"; payload: ExDatePayload })
  | (BlockNodeBase & { code: "BLK-COMPARE"; payload: ComparePayload })
  // B
  | (BlockNodeBase & { code: "BLK-THESIS"; payload: ThesisPayload })
  | (BlockNodeBase & { code: "BLK-PULLQUOTE"; payload: PullQuotePayload })
  | (BlockNodeBase & { code: "BLK-BIGNUM"; payload: BigNumPayload })
  | (BlockNodeBase & { code: "BLK-VERDICT"; payload: VerdictPayload })
  | (BlockNodeBase & { code: "BLK-TAKE"; payload: TakePayload })
  | (BlockNodeBase & { code: "BLK-FALSIFY"; payload: FalsifyPayload })
  // H
  // E
  | (BlockNodeBase & { code: "BLK-TIMELINE"; payload: TimelinePayload })
  | (BlockNodeBase & { code: "BLK-STEPS"; payload: StepsPayload })
  | (BlockNodeBase & { code: "BLK-FLOW"; payload: FlowPayload })
  | (BlockNodeBase & { code: "BLK-ANATOMY"; payload: AnatomyPayload })
  | (BlockNodeBase & { code: "BLK-WORKED"; payload: WorkedPayload })
  | (BlockNodeBase & { code: "BLK-MYTH"; payload: MythPayload })
  | (BlockNodeBase & { code: "BLK-DECISION"; payload: DecisionPayload })
  | (BlockNodeBase & { code: "BLK-GLOSSARY"; payload: GlossaryPayload })
  // F
  | (BlockNodeBase & { code: "BLK-TAPEROW"; payload: TapeRowPayload })
  | (BlockNodeBase & { code: "BLK-CHIPROW"; payload: ChipRowPayload })
  | (BlockNodeBase & { code: "BLK-SNAPSHOT"; payload: SnapshotPayload })
  | (BlockNodeBase & { code: "BLK-COUNTDOWN"; payload: CountdownPayload })
  | (BlockNodeBase & { code: "BLK-HALT"; payload: HaltPayload })
  | (BlockNodeBase & { code: "BLK-CORRECTION"; payload: CorrectionPayload })
  | (BlockNodeBase & { code: "BLK-BREADTH"; payload: BreadthPayload })
  | (BlockNodeBase & { code: "BLK-VENUEHEAD"; payload: VenueHeadPayload })
  // H
  | (BlockNodeBase & { code: "BLK-CUT"; payload: CutPayload })
  | (BlockNodeBase & { code: "BLK-PAYWALL"; payload: PaywallPayload })
  | (BlockNodeBase & { code: "BLK-ALERTCTA"; payload: AlertCtaPayload })
  | (BlockNodeBase & { code: "BLK-DOWNLOAD"; payload: DownloadPayload })
  // D
  | (BlockNodeBase & { code: "BLK-STACK"; payload: StackPayload })
  | (BlockNodeBase & { code: "BLK-WATERFALL"; payload: WaterfallPayload })
  | (BlockNodeBase & { code: "BLK-SCATTER"; payload: ScatterPayload })
  | (BlockNodeBase & { code: "BLK-DIST"; payload: DistPayload })
  | (BlockNodeBase & { code: "BLK-DUMBBELL"; payload: DumbbellPayload })
  | (BlockNodeBase & { code: "BLK-SLOPE"; payload: SlopePayload })
  | (BlockNodeBase & { code: "BLK-RANGE"; payload: RangePayload })
  | (BlockNodeBase & { code: "BLK-HEAT"; payload: HeatPayload })
  | (BlockNodeBase & { code: "BLK-INDEXED"; payload: IndexedPayload })
  | (BlockNodeBase & { code: "BLK-DONUT"; payload: DonutPayload })
  | (BlockNodeBase & { code: "BLK-COVER"; payload: CoverPayload })
  | (BlockNodeBase & { code: "BLK-CANDLE"; payload: CandlePayload })
  | (BlockNodeBase & { code: "BLK-LINE"; payload: LinePayload })
  | (BlockNodeBase & { code: "BLK-AREA"; payload: AreaPayload })
  | (BlockNodeBase & { code: "BLK-BARS"; payload: BarsPayload });

/** Narrow the union to one code's node shape. */
export type BlockNodeOf<C extends ImplementedBlockCode> = Extract<BlockNode, { code: C }>;

/**
 * An unrendered block: any code outside `ImplementedBlockCode`, or a code the
 * registry has no entry for. Kept structurally loose because the whole point is
 * that the renderer accepts what it cannot draw and says so.
 */
export interface UnknownBlockNode extends BlockNodeBase {
  code: string;
  payload?: unknown;
}

export type AnyBlockNode = BlockNode | UnknownBlockNode;

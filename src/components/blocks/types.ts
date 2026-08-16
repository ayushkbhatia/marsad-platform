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
export type ImplementedBlockCode = BlockCodeG | BlockCodeA | BlockCodeC | BlockCodeB | "BLK-CUT" | "BLK-PAYWALL";

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
  | (BlockNodeBase & { code: "BLK-CUT"; payload: CutPayload })
  | (BlockNodeBase & { code: "BLK-PAYWALL"; payload: PaywallPayload });

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

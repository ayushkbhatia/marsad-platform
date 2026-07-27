/*
 * src/components/blocks — the 61-block story vocabulary, rendered.
 *
 * Built families: G · Provenance & trust, A · Inline, C · Tabular (20 of 61).
 * Still absent: B · Statement, D · Charts (needs the PD.6 chart compiler),
 * E · Mechanism, F · Wire & live state, H · Gates & CTAs. Codes from those
 * families resolve to `MissingBlock` — loud, logged and non-fatal.
 *
 * Spec: docs/design/artifacts/artifact-library-61-blocks.html (authoritative),
 * docs/design/block-registry.json, ops.story_blocks,
 * docs/architecture/09-signal-to-article.md §5–§6.
 */

export {
  Block,
  BlockList,
  BLOCK_RENDERERS,
  IMPLEMENTED_BLOCK_CODES,
  hasRenderer,
  type BlockProps,
  type BlockRendererMap,
  type OnMissingComponent,
} from "./registry";

export { MissingBlock, type MissingBlockProps } from "./MissingBlock";

export {
  directionTextClass,
  estimateHeaderClass,
  estimateLabel,
  estimateValueClass,
  warnConstraint,
} from "./constraints";

// G — the prerequisite family; other families' footers compose from these.
export { BlockProv } from "./g/BlockProv";
export { BlockAgents } from "./g/BlockAgents";
export { BlockFresh, fromVenueFeedState } from "./g/BlockFresh";
export { BlockEstimate } from "./g/BlockEstimate";
export { BlockConflict } from "./g/BlockConflict";
export { BlockRule } from "./g/BlockRule";

// A
export { BlockTicker } from "./a/BlockTicker";
export { BlockDelta } from "./a/BlockDelta";
export { BlockCite } from "./a/BlockCite";
export { BlockTerm } from "./a/BlockTerm";
export { BlockSpark } from "./a/BlockSpark";
export { BlockMargin } from "./a/BlockMargin";

// C
export { BlockStatStrip } from "./c/BlockStatStrip";
export { BlockKeyStats } from "./c/BlockKeyStats";
export { BlockFinTable } from "./c/BlockFinTable";
export { BlockScenario } from "./c/BlockScenario";
export { BlockRankRow } from "./c/BlockRankRow";
export { BlockBeatMiss } from "./c/BlockBeatMiss";
export { BlockExDate } from "./c/BlockExDate";
export { BlockCompare } from "./c/BlockCompare";

export type * from "./types";

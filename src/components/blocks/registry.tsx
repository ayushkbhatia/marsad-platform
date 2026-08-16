import type { ComponentType } from "react";

import { BlockAgents } from "./g/BlockAgents";
import { BlockConflict } from "./g/BlockConflict";
import { BlockEstimate } from "./g/BlockEstimate";
import { BlockFresh } from "./g/BlockFresh";
import { BlockProv } from "./g/BlockProv";
import { BlockRule } from "./g/BlockRule";

import { BlockCite } from "./a/BlockCite";
import { BlockDelta } from "./a/BlockDelta";
import { BlockMargin } from "./a/BlockMargin";
import { BlockSpark } from "./a/BlockSpark";
import { BlockTerm } from "./a/BlockTerm";
import { BlockTicker } from "./a/BlockTicker";

import { BlockBeatMiss } from "./c/BlockBeatMiss";
import { BlockCompare } from "./c/BlockCompare";
import { BlockExDate } from "./c/BlockExDate";
import { BlockFinTable } from "./c/BlockFinTable";
import { BlockKeyStats } from "./c/BlockKeyStats";
import { BlockRankRow } from "./c/BlockRankRow";
import { BlockScenario } from "./c/BlockScenario";
import { BlockStatStrip } from "./c/BlockStatStrip";

import { MissingBlock } from "./MissingBlock";
import type {
  AnyBlockNode,
  BlockNodeOf,
  ImplementedBlockCode,
  UnknownBlockNode,
} from "./types";
import { BlockThesis } from "./b/BlockThesis";
import { BlockPullQuote } from "./b/BlockPullQuote";
import { BlockBigNum } from "./b/BlockBigNum";
import { BlockVerdict } from "./b/BlockVerdict";
import { BlockTake } from "./b/BlockTake";
import { BlockFalsify } from "./b/BlockFalsify";
import { BlockCut } from "./h/BlockCut";
import { BlockPaywall } from "./h/BlockPaywall";

/*
 * The renderer registry (PD.5).
 *
 * `ops.story_blocks.renderer_component` names the component for each of the 61
 * codes; this map is the resolution table those names point at. PD.8 (fit and
 * refuse) and the article renderer resolve a block by CODE — never by import —
 * so the closed vocabulary stays the only way into the page.
 *
 * Keys are checked against `ImplementedBlockCode`, so adding a family means
 * widening that type and TypeScript then insists every new code lands here.
 */
export type BlockRendererMap = {
  [C in ImplementedBlockCode]: ComponentType<{ node: BlockNodeOf<C> }>;
};

export const BLOCK_RENDERERS: BlockRendererMap = {
  // G · Provenance & trust — built first; every other family's footer needs it.
  "BLK-PROV": BlockProv,
  "BLK-AGENTS": BlockAgents,
  "BLK-FRESH": BlockFresh,
  "BLK-ESTIMATE": BlockEstimate,
  "BLK-CONFLICT": BlockConflict,
  "BLK-RULE": BlockRule,
  // A · Inline
  "BLK-TICKER": BlockTicker,
  "BLK-DELTA": BlockDelta,
  "BLK-CITE": BlockCite,
  "BLK-TERM": BlockTerm,
  "BLK-SPARK": BlockSpark,
  "BLK-MARGIN": BlockMargin,
  // C · Tabular
  "BLK-STATSTRIP": BlockStatStrip,
  "BLK-KEYSTATS": BlockKeyStats,
  "BLK-FINTABLE": BlockFinTable,
  "BLK-SCENARIO": BlockScenario,
  "BLK-RANKROW": BlockRankRow,
  "BLK-BEATMISS": BlockBeatMiss,
  "BLK-EXDATE": BlockExDate,
  "BLK-COMPARE": BlockCompare,
  // B · Statement — where the desk commits to a view.
  "BLK-THESIS": BlockThesis,
  "BLK-PULLQUOTE": BlockPullQuote,
  "BLK-BIGNUM": BlockBigNum,
  "BLK-VERDICT": BlockVerdict,
  "BLK-TAKE": BlockTake,
  "BLK-FALSIFY": BlockFalsify,
  // H · Gates — the seam between the free read and the wall.
  "BLK-CUT": BlockCut,
  "BLK-PAYWALL": BlockPaywall,
};

/** The codes with a renderer today — D, E, F and the rest of H are still to come. */
export const IMPLEMENTED_BLOCK_CODES = Object.keys(BLOCK_RENDERERS) as ImplementedBlockCode[];

export function hasRenderer(code: string): code is ImplementedBlockCode {
  return Object.prototype.hasOwnProperty.call(BLOCK_RENDERERS, code);
}

/**
 * Called when a block code has no renderer. Loud and logged; the return value
 * is still rendered, so this is a report, not a refusal.
 *
 * Overridable so a host surface can route it somewhere better than the console
 * (an ops incident, a Sentry breadcrumb) without every renderer knowing about it.
 */
export type OnMissingComponent = (node: UnknownBlockNode, reason: string) => void;

const defaultOnMissingComponent: OnMissingComponent = (node, reason) => {
  console.warn(`[blocks] ${node.code}: ${reason} (block _key=${node._key})`);
};

export interface BlockProps {
  node: AnyBlockNode;
  onMissingComponent?: OnMissingComponent;
}

/**
 * Render one block by code.
 *
 * The single unchecked cast in the whole layer lives here. Each entry in
 * `BLOCK_RENDERERS` is typed against its own node shape, and `node.code` picks
 * the entry — but TypeScript cannot prove the pairing across a lookup, so the
 * dispatcher asserts it once, in one place, instead of every renderer taking a
 * loose `BlockNode` and re-narrowing.
 */
export function Block({ node, onMissingComponent = defaultOnMissingComponent }: BlockProps) {
  if (!hasRenderer(node.code)) {
    const reason = "no renderer registered for this block code";
    onMissingComponent(node as UnknownBlockNode, reason);
    return <MissingBlock node={node as UnknownBlockNode} reason={reason} />;
  }
  const Renderer = BLOCK_RENDERERS[node.code] as ComponentType<{ node: AnyBlockNode }>;
  return <Renderer node={node} />;
}

/** Render an ordered list of blocks, each keyed by its stable opaque `_key`. */
export function BlockList({
  nodes,
  onMissingComponent,
}: {
  nodes: AnyBlockNode[];
  onMissingComponent?: OnMissingComponent;
}) {
  return (
    <>
      {nodes.map((node) => (
        <Block key={node._key} node={node} onMissingComponent={onMissingComponent} />
      ))}
    </>
  );
}

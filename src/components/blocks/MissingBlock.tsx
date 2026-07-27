import type { UnknownBlockNode } from "./types";

/*
 * The onMissingComponent posture, borrowed from @portabletext/react.
 *
 * An unregistered block code is a LOUD, LOGGED, NON-FATAL event at render. The
 * asymmetry is deliberate (architecture/09-signal-to-article.md §6.1): the
 * PUBLISHER hard-refuses a block it cannot resolve, so nothing unrenderable
 * should ever reach a reader. If one does anyway — a renderer shipped behind a
 * registry seed, a corrected article re-rendered against an older build — the
 * article must still render. A renderer that throws turns one unknown block
 * into a blank page.
 *
 * Amber, not red: this is a degraded state, not a market direction. Hard rule 1
 * reserves red for direction, and the accent policy assigns amber to degraded
 * and corrected states.
 */

export interface MissingBlockProps {
  node: UnknownBlockNode;
  /** Why it could not be drawn — no renderer, or a family not built yet. */
  reason?: string;
}

export function MissingBlock({ node, reason }: MissingBlockProps) {
  return (
    <div
      className="border border-dashed border-caution bg-paper-tint px-3 py-2.5"
      data-block-code={node.code}
      data-block-key={node._key}
    >
      <div className="font-mono text-[8px] font-semibold tracking-[0.12em] text-caution-text uppercase">
        Unrendered block
      </div>
      <div className="mt-1 font-mono text-[10px] text-ink-mid">
        {node.code}
        {reason ? ` — ${reason}` : ""}
      </div>
    </div>
  );
}

import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-CUT · Premium cut — H · Gates
 *
 * "WHERE THE FREE READ ENDS. It must fall after a complete thought and after at
 * least one data block — the reader sees the work before the wall."
 *
 * The fit stage re-verifies both claims against the real block sequence, because
 * the payload only ASSERTS them. This renderer checks the one it can see
 * locally: a cut claiming zero data blocks before it has placed the wall in
 * front of the evidence, which is the failure R-09 exists to catch.
 *
 * ⚠️ The gradient is presentation, not the gate. RLS on public.content_blocks
 * withholds every gated row, so the copy below the cut is never sent to an
 * unentitled reader. This block marks the seam; it does not enforce it.
 */
export function BlockCut({ node }: { node: BlockNodeOf<"BLK-CUT"> }) {
  const { teaser, dataBlocksBefore } = node.payload;

  if (dataBlocksBefore < 1) {
    warnConstraint("BLK-CUT", "the cut falls before any data block — the reader meets the wall before the work.");
  }

  return (
    <div className="relative">
      <p className="text-[13.5px] leading-[1.6] text-ink-mid">{teaser}</p>
      <div
        aria-hidden
        className="pointer-events-none h-16 bg-gradient-to-b from-transparent to-paper"
      />
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">
          FREE READ ENDS HERE
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>
    </div>
  );
}

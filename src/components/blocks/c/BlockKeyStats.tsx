import { checkExactCounts } from "../constraints";
import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-KEYSTATS · Facts grid — C · Tabular
 *
 * "4 OR 8 CELLS · MECHANICS AND CONSEQUENCES MIXED DELIBERATELY"
 * "MIN LOT AND REFUND DATE ARE GCC-RETAIL ESSENTIALS — NEVER DROP THEM FOR SPACE"
 *
 * 4 or 8 and nothing else, because the grid is four columns wide: any other
 * count leaves a ragged final row, which is why the count is a constraint and
 * not a preference.
 */
export function BlockKeyStats({ node }: { node: BlockNodeOf<"BLK-KEYSTATS"> }) {
  const { cells, footnote } = node.payload;
  checkExactCounts("BLK-KEYSTATS", "cells", cells.length, [4, 8]);

  return (
    <div>
      <div className="grid grid-cols-4 border-t border-l border-hairline">
        {cells.map((c, i) => (
          <div key={`${c.label}-${i}`} className="border-r border-b border-hairline px-[13px] py-2.5">
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{c.label}</div>
            <div className="mt-[3px] font-mono text-[12.5px] font-semibold text-ink tabular-nums">
              <Val v={c.value} />
            </div>
          </div>
        ))}
      </div>
      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}

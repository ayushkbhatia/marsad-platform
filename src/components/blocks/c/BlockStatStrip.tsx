import { checkCount, directionTextClass } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-STATSTRIP · Four-up stat strip — C · Tabular
 *
 * "3–5 CELLS MAX · ONE FACT EACH · NEVER A PLACE TO DUMP LEFTOVER NUMBERS"
 *
 * Direction colour is only reachable where the cell declares itself a change —
 * a capex figure and a first-gas year are ink, and the "vs Phase 1" delta is
 * the one green thing in the strip.
 */
export function BlockStatStrip({ node }: { node: BlockNodeOf<"BLK-STATSTRIP"> }) {
  const { cells } = node.payload;
  checkCount("BLK-STATSTRIP", "cells", cells.length, 3, 5);

  return (
    <div className="flex border border-hairline bg-paper-tint">
      {cells.map((c, i) => (
        <div
          key={`${c.label}-${i}`}
          className={`flex-1 px-[15px] py-[13px] ${i < cells.length - 1 ? "border-r border-hairline" : ""}`}
        >
          <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{c.label}</div>
          <div
            className={`mt-1 font-display text-[24px] font-bold tabular-nums ${directionTextClass(c.direction)}`}
          >
            <Val v={c.value} />
          </div>
        </div>
      ))}
    </div>
  );
}

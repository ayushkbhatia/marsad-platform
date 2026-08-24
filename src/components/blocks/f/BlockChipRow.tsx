import { warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/**
 * BLK-CHIPROW · Data chip row — F · Wire
 *
 * "3–5 CHIPS · THE CHEAPEST WAY TO ATTACH DATA TO A 30-WORD ITEM"
 *
 * "THE MOVING NUMBER GETS THE INK BORDER · CONTEXT CHIPS STAY GREY" is the whole hierarchy: on a
 * 30-word wire item a reader has time for exactly one number, and the border says which one. More
 * than one moving chip destroys that, so it is warned.
 *
 * Direction colours the VALUE, not the border — the border marks importance, the colour marks
 * sign, and conflating them would make a large fall look like a small rise.
 */
export function BlockChipRow({ node }: { node: BlockNodeOf<"BLK-CHIPROW"> }) {
  const { chips = [] } = node.payload;

  if (chips.length < 3 || chips.length > 5) {
    warnConstraint("BLK-CHIPROW", `${chips.length} chips — the row is three to five.`);
  }
  const moving = chips.filter((c) => c.isMoving).length;
  if (moving > 1) {
    warnConstraint("BLK-CHIPROW", `${moving} moving chips — only one number moves, or the hierarchy is gone.`);
  }

  return (
    <div className="my-2.5 flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span
          key={i}
          className={`inline-flex items-baseline gap-1.5 px-2 py-[3px] font-mono text-[9.5px] ${
            c.isMoving ? "border border-ink text-ink" : "border border-hairline-strong text-ink-muted"
          }`}
        >
          <span className="tracking-[0.08em] uppercase">{c.label}</span>
          <span
            className={`font-semibold tabular-nums ${
              c.isMoving && c.direction === "up"
                ? "text-positive"
                : c.isMoving && c.direction === "down"
                  ? "text-negative"
                  : ""
            }`}
          >
            <Val v={c.value} />
          </span>
        </span>
      ))}
    </div>
  );
}

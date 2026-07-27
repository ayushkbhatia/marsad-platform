import { checkCount, warnConstraint } from "../constraints";
import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-RANKROW · League table — C · Tabular
 *
 * "5–10 ROWS · RANK NUMERALS IN NEWSREADER, VALUES IN MONO"
 * "THE RANKED METRIC ALWAYS CARRIES A QUALIFYING COLUMN — A YIELD TABLE
 *  WITHOUT PAYOUT IS A TRAP"
 *
 * The qualifier is the whole ethic of the block: an 8.8% yield ranked first is
 * only news once the reader can see it is being paid out of 118% of earnings.
 * The flag turns that column red — direction, not decoration.
 */
const GRID = { gridTemplateColumns: "26px 1fr 74px 74px" };

export function BlockRankRow({ node }: { node: BlockNodeOf<"BLK-RANKROW"> }) {
  const { rows, footnote } = node.payload;
  checkCount("BLK-RANKROW", "rows", rows.length, 5, 10);
  rows.forEach((r) => {
    if (!isBound(r.qualifier)) {
      warnConstraint("BLK-RANKROW", `"${r.name}" has no qualifying metric — a ranked metric alone is a trap.`);
    }
  });

  return (
    <div>
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${i}`}
          className="grid items-center gap-2.5 border-b border-hairline-faint py-[9px]"
          style={GRID}
        >
          <span className="font-display text-[18px] font-semibold text-hairline-strong tabular-nums">
            {r.rank}
          </span>
          <span className="text-[12.5px] font-semibold text-ink">
            {r.name}{" "}
            {isBound(r.venue) ? <span className="font-mono text-[9px] text-ink-faint">{r.venue}</span> : null}
          </span>
          <span className="text-right font-mono text-[12px] font-bold text-ink tabular-nums">
            <Val v={r.value} />
          </span>
          <span
            className={`text-right font-mono text-[8px] tabular-nums ${
              r.qualifierFlagged ? "text-negative" : "text-ink-faint"
            }`}
          >
            <Val v={r.qualifier} />
          </span>
        </div>
      ))}
      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}

import { directionTextClass } from "../constraints";
import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-BEATMISS · Actual vs consensus — C · Tabular
 *
 * "BINDS FILING.EPS + CONSENSUS.EPS · REACTION IS T+0 CLOSE"
 * "SURPRISE AND PRICE REACTION SIT SIDE BY SIDE — THEY DISAGREE MORE OFTEN
 *  THAN READERS EXPECT"
 *
 * The two right-hand columns are the block's argument, so they are adjacent by
 * design. Reaction is the T+0 CLOSE — never an intraday print, which would let
 * the table tell a different story depending on when it was rendered.
 */
const GRID = { gridTemplateColumns: "1fr 68px 68px 74px 66px" };

export function BlockBeatMiss({ node }: { node: BlockNodeOf<"BLK-BEATMISS"> }) {
  const { rows, footnote } = node.payload;

  return (
    <div>
      <div className="grid gap-[9px] border-b border-hairline pt-[7px] pb-[5px]" style={GRID}>
        <span className="font-mono text-[8px] text-ink-faint">NAME</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">ACTUAL</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">CONS.</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">SURPRISE</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">REACTION</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${i}`}
          className="grid items-baseline gap-[9px] border-b border-hairline-faint py-2"
          style={GRID}
        >
          <span className="text-[12px] text-ink">
            {r.name}{" "}
            {isBound(r.ticker) ? (
              <span className="font-mono text-[9px] text-ink-faint">{r.ticker}</span>
            ) : null}
          </span>
          <span className="text-right font-mono text-[11px] font-semibold text-ink tabular-nums">
            <Val v={r.actual} />
          </span>
          {/* Consensus is muted: it is the benchmark, not the news. */}
          <span className="text-right font-mono text-[11px] text-ink-muted tabular-nums">
            <Val v={r.consensus} />
          </span>
          <span
            className={`text-right font-mono text-[11px] font-bold tabular-nums ${directionTextClass(r.surpriseDirection)}`}
          >
            <Val v={r.surprise} />
          </span>
          <span
            className={`text-right font-mono text-[11px] tabular-nums ${directionTextClass(r.reactionDirection)}`}
          >
            <Val v={r.reaction} />
          </span>
        </div>
      ))}
      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}

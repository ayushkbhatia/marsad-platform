import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-EXDATE · Dividend row — C · Tabular
 *
 * "BINDS DIVIDEND.EXDATE · ONE ROW PER DECLARATION, NOT PER PAYMENT"
 * "SPECIAL TYPE CHIP INVERTS TO INK · EX-DATE IS THE BOLD COLUMN, NOT PAY DATE"
 *
 * The ex-date is bold because it is the only date that changes what a reader
 * should do: pay date is administration. A SPECIAL declaration inverts to ink
 * rather than taking a colour — hard rule 1 again, emphasis is ink.
 */
const GRID = { gridTemplateColumns: "56px 1fr 68px 78px 58px 66px" };

/** Ink inversion marks a special declaration; ordinary types keep the hairline chip. */
function isSpecial(type: string): boolean {
  return type.trim().toUpperCase() === "SPECIAL";
}

export function BlockExDate({ node }: { node: BlockNodeOf<"BLK-EXDATE"> }) {
  const { rows, footnote } = node.payload;

  return (
    <div>
      <div className="grid gap-[9px] border-b border-hairline pt-[7px] pb-[5px]" style={GRID}>
        <span className="font-mono text-[8px] text-ink-faint">TICKER</span>
        <span className="font-mono text-[8px] text-ink-faint">TYPE</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">DPS</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">EX-DATE</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">YIELD</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">PAY</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={`${r.ticker}-${i}`}
          className="grid items-center gap-[9px] border-b border-hairline-faint py-2"
          style={GRID}
        >
          <span className="font-mono text-[11px] font-semibold text-ink tabular-nums">{r.ticker}</span>
          <span>
            <span
              className={
                isSpecial(r.type)
                  ? "bg-ink px-1.5 py-[2px] font-mono text-[8px] font-semibold text-paper-tint"
                  : "border border-hairline-strong px-1.5 py-[2px] font-mono text-[8px] text-ink-muted"
              }
            >
              {r.type.toUpperCase()}
            </span>
          </span>
          <span className="text-right font-mono text-[11px] text-ink tabular-nums">
            <Val v={r.dps} />
          </span>
          <span className="text-right font-mono text-[11px] font-bold text-ink tabular-nums">
            <Val v={r.exDate} />
          </span>
          <span className="text-right font-mono text-[11px] font-bold text-ink tabular-nums">
            <Val v={r.yieldPct} />
          </span>
          <span className="text-right font-mono text-[10px] text-ink-muted tabular-nums">
            <Val v={r.payDate} />
          </span>
        </div>
      ))}
      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}

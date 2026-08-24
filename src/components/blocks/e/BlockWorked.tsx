import { warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/**
 * BLK-WORKED · Worked example — E · Mechanism
 *
 * "ROUND NUMBERS, REAL TICKER · MUST END IN A TOTAL ROW THAT SETTLES THE POINT"
 *
 * The total row is mandatory because an example that stops before the total makes the reader do
 * the arithmetic the block exists to do for them — and a reader who does it themselves may reach a
 * different number, which is worse than not showing the example at all.
 *
 * The 'after' column header is ink 600 and its values are bold: that column carries the desk's
 * computation, and the weight is what tells a reader which side is being asserted rather than
 * merely reported.
 */
const GRID = { gridTemplateColumns: "1fr 96px 96px" };

export function BlockWorked({ node }: { node: BlockNodeOf<"BLK-WORKED"> }) {
  const { premise, beforeLabel, afterLabel, rows = [], total, closing } = node.payload;
  const totalRow = total ?? { label: "Total", before: null, after: null };

  if (!total?.label) {
    warnConstraint("BLK-WORKED", "no total row — the example must end in the row that settles the point.");
  }

  return (
    <div className="my-5 border border-hairline">
      <div className="bg-ink px-3 py-[7px] font-mono text-[9px] font-semibold tracking-[0.12em] text-paper-tint uppercase">
        {premise}
      </div>

      <div className="grid gap-2.5 border-b border-hairline px-3 pt-[7px] pb-[5px]" style={GRID}>
        <span className="font-mono text-[8px] text-ink-faint" />
        <span className="text-right font-mono text-[8px] text-ink-faint uppercase">{beforeLabel}</span>
        {/* ink 600 — this column carries the desk's computation */}
        <span className="text-right font-mono text-[8px] font-semibold text-ink uppercase">
          {afterLabel}
        </span>
      </div>

      {rows.map((r, i) => (
        <div key={i} className="grid items-baseline gap-2.5 border-b border-hairline-faint px-3 py-[8px]" style={GRID}>
          <span className="font-display text-[12.5px] text-ink">{r.label}</span>
          <span className="text-right font-mono text-[11.5px] text-ink-muted tabular-nums">
            <Val v={r.before} />
          </span>
          <span className="text-right font-mono text-[11.5px] font-bold text-ink tabular-nums">
            <Val v={r.after} />
          </span>
        </div>
      ))}

      <div className="grid items-baseline gap-2.5 bg-paper-tint px-3 py-[9px]" style={GRID}>
        <span className="font-display text-[12.5px] font-bold text-ink">{totalRow.label}</span>
        <span className="text-right font-mono text-[12px] text-ink-muted tabular-nums">
          <Val v={totalRow.before} />
        </span>
        <span className="text-right font-mono text-[12px] font-bold text-ink tabular-nums">
          <Val v={totalRow.after} />
        </span>
      </div>

      <p className="border-t border-hairline px-3 py-2.5 font-display text-[12.5px] leading-[1.5] text-ink">
        {closing}
      </p>
    </div>
  );
}

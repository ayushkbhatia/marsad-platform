import { heatStop } from "@/lib/blocks/ramps";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-HEAT · Mini heat grid — "WHERE'S THE PATTERN?"
 *
 * "MAX 8×8 · SAME 7-STOP RAMP AS THE SECTOR HEATMAP — NEVER INVENT A SECOND SCALE"
 *
 * The ramp comes from `lib/blocks/ramps`, transcribed from the design tokens, precisely so there is
 * one place for it. (The card says seven stops; the specimen draws eight, and the token file
 * records that rather than quietly resolving it.)
 *
 * This is the only block permitted to carry the dark-room palette on paper — which is why an
 * UNRESOLVED cell is drawn as an empty outline rather than as a mid-ramp colour: the middle of this
 * ramp means "flat", a real reading, so using it for absence would state a measurement nobody took.
 */
const CELL_H = 22;
const GAP = 3;

export function BlockHeat({ node }: { node: BlockNodeOf<"BLK-HEAT"> }) {
  const { caption, rowLabels = [], colLabels = [], cells = [], unit } = node.payload;

  if (rowLabels.length > 8 || colLabels.length > 8) {
    warnConstraint("BLK-HEAT", `${rowLabels.length}×${colLabels.length} — the grid is at most 8×8.`);
  }

  const flat = cells.flat();
  const gaps = flat.some((c) => typeof c?.value !== "number" || !Number.isFinite(c.value));

  return (
    <ChartFrame
      question="WHERE'S THE PATTERN?"
      caption={caption}
      unit={unit}
      series={[{ label: "grid", points: flat.map((c, i) => ({ label: String(i), date: null, value: c?.value ?? null, objectId: c?.objectId ?? "", state: c?.state ?? "UNKNOWN" })) }]}
      gaps={gaps}
    >
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: `${GAP}px` }}>
          <thead>
            <tr>
              <th />
              {colLabels.map((c) => (
                <th key={c} className="px-1 pb-0.5 font-mono text-[7.5px] font-normal tracking-[0.08em] text-ink-faint uppercase">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((r, ri) => (
              <tr key={r}>
                <th className="pr-1.5 text-right font-mono text-[8px] font-normal text-ink-faint">{r}</th>
                {colLabels.map((_, ci) => {
                  const cell = cells[ri]?.[ci];
                  const bg = heatStop(cell?.value);
                  return (
                    <td
                      key={ci}
                      className={bg ? "" : "border border-dashed border-hairline"}
                      style={{ height: CELL_H, minWidth: 34, background: bg ?? "transparent" }}
                      title={cell?.value != null ? String(cell.value) : "not resolved"}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

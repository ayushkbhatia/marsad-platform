import { extent, scale } from "@/lib/blocks/chart-svg";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-SLOPE · Rank change — "WHO OVERTOOK WHOM?"
 *
 * "TWO PERIODS ONLY · MORE THAN 6 LINES AND IT STOPS READING · ONLY THE CROSSING PAIR GETS COLOUR"
 *
 * The colour rule is the block's whole argument. A slope chart with every line coloured is a
 * tangle; greying everything except the pair that actually crossed turns it into a sentence. The
 * crossing pair is computed HERE from resolved values — the writer emitted bindings and never saw
 * the numbers, so it could not have identified them.
 */
const W = 560;
const H = 260;
const PAD = { l: 116, r: 116, t: 14, b: 24 };

export function BlockSlope({ node }: { node: BlockNodeOf<"BLK-SLOPE"> }) {
  const { caption, rows = [], fromPeriod, toPeriod, unit } = node.payload;

  if (rows.length > 6) {
    warnConstraint("BLK-SLOPE", `${rows.length} lines — beyond six the chart stops reading.`);
  }

  const usable = rows.filter(
    (r) => typeof r.from === "number" && typeof r.to === "number" && Number.isFinite(r.from) && Number.isFinite(r.to),
  );
  const gaps = usable.length !== rows.length;
  const dom = extent(usable.flatMap((r) => [r.from, r.to]));
  const innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + innerH - (dom ? scale(v, dom, innerH) : 0);

  // A pair crosses when their order reverses between the two periods. Found from the resolved
  // values, because that is the only place the ordering exists.
  const crossing = new Set<string>();
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!;
      const b = usable[j]!;
      if (Math.sign(a.from! - b.from!) !== Math.sign(a.to! - b.to!)) {
        crossing.add(a.label);
        crossing.add(b.label);
      }
    }
  }

  return (
    <ChartFrame
      question="WHO OVERTOOK WHOM?"
      caption={caption}
      unit={unit}
      series={[{ label: `${fromPeriod} → ${toPeriod}`, points: rows.map((r) => ({ label: r.label, date: null, value: r.to, objectId: r.objectId, state: r.state })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {usable.map((r, i) => {
          const hot = crossing.has(r.label);
          return (
            <g key={`${r.label}-${i}`}>
              <line
                x1={PAD.l} y1={y(r.from!)} x2={W - PAD.r} y2={y(r.to!)}
                stroke={hot ? (r.to! >= r.from! ? "var(--color-ink)" : "var(--color-negative)") : "var(--color-dark-text-faint)"}
                strokeWidth={hot ? 2.4 : 1.4}
              />
              <text x={PAD.l - 6} y={y(r.from!) + 3} textAnchor="end"
                    className={`font-mono text-[9px] ${hot ? "fill-ink" : "fill-ink-faint"}`}>
                {r.label}
              </text>
              <text x={W - PAD.r + 6} y={y(r.to!) + 3}
                    className={`font-mono text-[9px] ${hot ? "fill-ink" : "fill-ink-faint"}`}>
                {r.label}
              </text>
            </g>
          );
        })}
        <text x={PAD.l} y={H - 6} textAnchor="middle" className="fill-ink-faint font-mono text-[8px]">{fromPeriod}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="middle" className="fill-ink-faint font-mono text-[8px]">{toPeriod}</text>
      </svg>
    </ChartFrame>
  );
}

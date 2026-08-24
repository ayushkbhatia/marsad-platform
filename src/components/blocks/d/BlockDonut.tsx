import { inkStop } from "@/lib/blocks/ramps";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-DONUT · Composition ring
 *
 * "MONOCHROME RAMP, DARKEST = LARGEST · MAX 5 SEGMENTS · THE HOLE CARRIES THE ONE NUMBER THAT MATTERS"
 *
 * Darkest-is-largest means the segments are SORTED here, by resolved value, and the ramp index
 * follows the sort. The writer never saw the values, so it could not have ordered them; and an
 * unsorted ring with a monochrome ramp would be actively misleading, because a reader reads darker
 * as bigger whether or not it is.
 *
 * The hole is not decoration. A ring alone tells you proportions and no magnitude; the centre
 * figure is what makes the exhibit quotable, which is why it is a required payload field.
 */
const SIZE = 168;
const R = 70;
const THICK = 26;

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x1, y1] = p(from);
  const [x2, y2] = p(to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

export function BlockDonut({ node }: { node: BlockNodeOf<"BLK-DONUT"> }) {
  const { caption, segments = [], centreValue, centreLabel, unit } = node.payload;

  if (segments.length > 5) {
    warnConstraint("BLK-DONUT", `${segments.length} segments — the ring carries at most five.`);
  }

  const usable = segments.filter((s) => typeof s.value === "number" && Number.isFinite(s.value) && (s.value ?? 0) > 0);
  const gaps = usable.length !== segments.length;
  const total = usable.reduce((a, s) => a + (s.value ?? 0), 0);
  // Sorted so the ramp's "darkest = largest" is true rather than assumed.
  const sorted = [...usable].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Cumulative sweeps without mutating a closure inside map: each arc starts where the sum of the
  // preceding shares ends, computed from the slice rather than from a running variable.
  const START = -Math.PI / 2;
  const arcs = sorted.map((s, i) => {
    const before = sorted.slice(0, i).reduce((a, x) => a + (x.value ?? 0), 0);
    const from = START + (total > 0 ? (before / total) * Math.PI * 2 : 0);
    const sweep = total > 0 ? ((s.value ?? 0) / total) * Math.PI * 2 : 0;
    return {
      d: arc(SIZE / 2, SIZE / 2, R - THICK / 2, from, from + sweep),
      s, colour: inkStop(i),
      pct: total > 0 ? ((s.value ?? 0) / total) * 100 : 0,
    };
  });

  return (
    <ChartFrame
      question="WHAT'S IT MADE OF?"
      caption={caption}
      unit={unit}
      series={[{ label: "ring", points: segments.map((s) => ({ label: s.label, date: null, value: s.value, objectId: s.objectId, state: s.state })) }]}
      gaps={gaps}
    >
      <div className="flex flex-wrap items-center gap-6">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={caption}>
          {arcs.map((a, i) => (
            <path key={i} d={a.d} fill="none" stroke={a.colour} strokeWidth={THICK} />
          ))}
          <text x={SIZE / 2} y={SIZE / 2 - 2} textAnchor="middle"
                className="fill-ink font-display text-[22px] font-bold">
            {centreValue}
          </text>
          <text x={SIZE / 2} y={SIZE / 2 + 14} textAnchor="middle"
                className="fill-ink-faint font-mono text-[7.5px] uppercase">
            {centreLabel}
          </text>
        </svg>

        <ul className="flex-1">
          {arcs.map((a, i) => (
            <li key={i} className="flex items-baseline gap-2 border-b border-hairline-faint py-1 last:border-b-0">
              <span className="size-[8px] flex-none" style={{ background: a.colour }} aria-hidden />
              <span className="flex-1 font-display text-[12px] text-ink">{a.s.label}</span>
              <span className="font-mono text-[11px] text-ink tabular-nums">{a.pct.toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}

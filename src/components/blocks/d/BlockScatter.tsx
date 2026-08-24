import { extent, median, scale } from "@/lib/blocks/chart-svg";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-SCATTER · Bubble scatter — "WHO'S POSITIONED?"
 *
 * "RADIUS = A THIRD VARIABLE, ALWAYS STATED · RATING DRIVES THE OUTLINE COLOUR"
 *
 * The radius rule is the one that matters. A bubble whose size means nothing stated is a decoration
 * that a reader will nonetheless read as meaning something — so `radiusMeans` is a required payload
 * field and it is printed on the chart, not in the caption where it can be skipped.
 *
 * Quadrant lines are at the MEDIANS, not at zero or at a round number: the question is "who is
 * positioned", which is relative to this cohort, and a fixed line would silently import an outside
 * benchmark.
 */
const W = 640;
const H = 300;
const PAD = { l: 40, r: 12, t: 12, b: 32 };

export function BlockScatter({ node }: { node: BlockNodeOf<"BLK-SCATTER"> }) {
  const { caption, points = [], xLabel, yLabel, radiusMeans, unit } = node.payload;

  if (!radiusMeans) {
    warnConstraint("BLK-SCATTER", "radius has no stated meaning — a bubble sized by nothing is read as sized by something.");
  }

  const usable = points.filter(
    (p) => typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const gaps = usable.length !== points.length;

  const dx = extent(usable.map((p) => p.x));
  const dy = extent(usable.map((p) => p.y));
  const dr = extent(usable.map((p) => p.r));
  const mx = median(usable.map((p) => p.x));
  const my = median(usable.map((p) => p.y));

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const px = (v: number) => PAD.l + (dx ? scale(v, dx, innerW) : 0);
  const py = (v: number) => PAD.t + innerH - (dy ? scale(v, dy, innerH) : 0);
  const pr = (v: number | null) => (dr && typeof v === "number" ? 4 + scale(v, dr, 14) : 4);

  return (
    <ChartFrame
      question="WHO'S POSITIONED?"
      caption={caption}
      unit={unit}
      series={[{ label: "cohort", points: points.map((p) => ({ label: p.label, date: null, value: p.y, objectId: p.objectId, state: p.state })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {/* Quadrants at the cohort's own medians — never an imported benchmark. */}
        {mx !== null ? (
          <line x1={px(mx)} y1={PAD.t} x2={px(mx)} y2={PAD.t + innerH}
                stroke="var(--color-dark-text-faint)" strokeWidth={1} strokeDasharray="4 4" />
        ) : null}
        {my !== null ? (
          <line x1={PAD.l} y1={py(my)} x2={PAD.l + innerW} y2={py(my)}
                stroke="var(--color-dark-text-faint)" strokeWidth={1} strokeDasharray="4 4" />
        ) : null}

        {usable.map((p, i) => (
          <g key={`${p.label}-${i}`}>
            <circle
              cx={px(p.x!)} cy={py(p.y!)} r={pr(p.r)}
              className="fill-paper"
              stroke={
                p.rating === "positive" ? "var(--color-ink)"
                : p.rating === "negative" ? "var(--color-negative)"
                : "var(--color-dark-text-faint)"
              }
              strokeWidth={1.5}
            />
            <text x={px(p.x!)} y={py(p.y!) - pr(p.r) - 3} textAnchor="middle"
                  className="fill-ink-muted font-mono text-[7.5px]">
              {p.label}
            </text>
          </g>
        ))}

        <text x={PAD.l} y={H - 8} className="fill-ink-faint font-mono text-[8px]">{xLabel} →</text>
        <text x={4} y={PAD.t + 8} className="fill-ink-faint font-mono text-[8px]">{yLabel} ↑</text>
      </svg>
      {/* Printed on the exhibit, not buried in the caption. */}
      <p className="mt-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
        Bubble size = {radiusMeans}
      </p>
    </ChartFrame>
  );
}

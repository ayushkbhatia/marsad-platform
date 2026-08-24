import { extent, scale } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-DIST · Distribution — "HOW SPREAD OUT?"
 *
 * "ZERO LINE IS THE HEAVY RULE · BARS HANG BOTH WAYS FROM IT"
 *
 * Zero is drawn heavier than any other rule because it is the only line on the chart that is a
 * fact rather than a scale decision. Bars hang from it in both directions and take their colour
 * from their sign — which is the one place in the palette where green and red are literal rather
 * than semantic, because here the direction IS the measurement.
 */
const W = 640;
const H = 200;
const PAD = { l: 8, r: 8, t: 10, b: 26 };
const BAR = 26;
const GUTTER = 6;

export function BlockDist({ node }: { node: BlockNodeOf<"BLK-DIST"> }) {
  const { caption, series = [], unit } = node.payload;

  const points = series.flatMap((s) => s.points);
  const gaps = points.some((p) => typeof p.value !== "number" || !Number.isFinite(p.value));
  const dom = extent([0, ...points.map((p) => p.value)]);

  const innerH = H - PAD.t - PAD.b;
  const y0 = dom ? PAD.t + innerH - scale(0, dom, innerH) : PAD.t + innerH;
  const y = (v: number) => PAD.t + innerH - (dom ? scale(v, dom, innerH) : 0);

  return (
    <ChartFrame question="HOW SPREAD OUT?" caption={caption} unit={unit} series={series} gaps={gaps}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {points.map((p, i) => {
          const x = PAD.l + i * (BAR + GUTTER);
          if (typeof p.value !== "number" || !Number.isFinite(p.value)) return null;
          const top = p.value >= 0 ? y(p.value) : y0;
          const h = Math.max(1, Math.abs(y(p.value) - y0));
          return (
            <g key={`${p.objectId}-${i}`}>
              <rect x={x} y={top} width={BAR} height={h}
                    className={p.value >= 0 ? "fill-positive" : "fill-negative"} />
              <text x={x + BAR / 2} y={H - 8} textAnchor="middle" className="fill-ink-faint font-mono text-[7.5px]">
                {p.label}
              </text>
            </g>
          );
        })}
        {/* The only line on this chart that is a fact rather than a scale decision. */}
        <line x1={PAD.l} y1={y0} x2={W - PAD.r} y2={y0} stroke="var(--color-ink)" strokeWidth={1.5} />
      </svg>
    </ChartFrame>
  );
}

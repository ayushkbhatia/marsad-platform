import { extent, scale } from "@/lib/blocks/chart-svg";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-WATERFALL · Bridge — "WHAT MOVED IT?"
 *
 * "START AND END BARS SIT ON THE BASELINE · CONNECTORS DASHED · 4–6 DRIVERS"
 *
 * The start and end sitting on the baseline is what makes it a bridge rather than a bar chart: the
 * reader can see the two levels being reconciled, and the floating drivers are the reconciliation.
 * Connectors are dashed so they read as construction lines rather than as data.
 *
 * A driver's colour is its SIGN, not its size — a large negative and a large positive are equally
 * important and must not be distinguishable only by height.
 */
const W = 640;
const H = 220;
const PAD = { l: 8, r: 8, t: 14, b: 26 };

export function BlockWaterfall({ node }: { node: BlockNodeOf<"BLK-WATERFALL"> }) {
  const EMPTY = { label: "", value: null, objectId: "", state: "UNKNOWN" };
  const { caption, start = EMPTY, drivers = [], end = EMPTY, unit } = node.payload;

  if (drivers.length < 4 || drivers.length > 6) {
    warnConstraint("BLK-WATERFALL", `${drivers.length} drivers — the bridge carries four to six.`);
  }

  const all = [start, ...drivers, end];
  const gaps = all.some((s) => typeof s.value !== "number" || !Number.isFinite(s.value));

  // Cumulative positions: every driver floats between the running total before and after it.
  // Built by reduce rather than by mutating a closure inside map — the same result, and it does not
  // depend on map's evaluation order, which is what the immutability rule is protecting against.
  const spans = drivers.reduce<Array<{ step: (typeof drivers)[number]; from: number; to: number }>>(
    (acc, d) => {
      const from = acc.length > 0 ? acc[acc.length - 1]!.to : (start.value ?? 0);
      acc.push({ step: d, from, to: from + (d.value ?? 0) });
      return acc;
    },
    [],
  );

  const dom = extent([0, start.value, end.value, ...spans.flatMap((s) => [s.from, s.to])]);
  const innerH = H - PAD.t - PAD.b;
  const innerW = W - PAD.l - PAD.r;
  const colW = innerW / (all.length || 1);
  const barW = Math.min(46, colW * 0.62);
  const y = (v: number) => PAD.t + innerH - (dom ? scale(v, dom, innerH) : 0);

  return (
    <ChartFrame
      question="WHAT MOVED IT?"
      caption={caption}
      unit={unit}
      series={[{ label: "bridge", points: all.map((s) => ({ label: s.label, date: null, value: s.value, objectId: s.objectId, state: s.state })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {dom ? (
          <>
            {all.map((s, i) => {
              const cx = PAD.l + colW * i + colW / 2;
              const isEnd = i === 0 || i === all.length - 1;
              const span = isEnd ? null : spans[i - 1]!;
              // Ends sit on the baseline; drivers float between their running totals.
              const top = isEnd ? y(s.value ?? 0) : y(Math.max(span!.from, span!.to));
              const bottom = isEnd ? y(dom.min) : y(Math.min(span!.from, span!.to));
              const rising = !isEnd && (s.value ?? 0) >= 0;
              return (
                <g key={`${s.label}-${i}`}>
                  <rect
                    x={cx - barW / 2}
                    y={top}
                    width={barW}
                    height={Math.max(1, bottom - top)}
                    className={isEnd ? "fill-ink" : rising ? "fill-positive" : "fill-negative"}
                  />
                  {/* Dashed connector to the next bar — construction, not data. */}
                  {i < all.length - 1 ? (
                    <line
                      x1={cx + barW / 2} y1={isEnd ? top : y(span!.to)}
                      x2={PAD.l + colW * (i + 1) + colW / 2 - barW / 2} y2={isEnd ? top : y(span!.to)}
                      stroke="var(--color-dark-text-faint)" strokeWidth={1} strokeDasharray="2 2"
                    />
                  ) : null}
                  <text x={cx} y={H - 8} textAnchor="middle" className="fill-ink-faint font-mono text-[8px]">
                    {s.label}
                  </text>
                </g>
              );
            })}
          </>
        ) : null}
      </svg>
    </ChartFrame>
  );
}

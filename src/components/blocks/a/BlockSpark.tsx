import { clampSeries, warnConstraint } from "../constraints";
import { interpolate } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-SPARK · Inline sparkline — A · Inline
 *
 * "WHEN DIRECTION MATTERS AND MAGNITUDE DOESN'T · MAX 30 POINTS"
 * "NO AXES, NO LABELS, NO TOOLTIP. IF IT NEEDS A NUMBER IT IS NOT A SPARKLINE"
 *
 * 72×20, ink polyline at stroke-width 1.6, vertical-align middle. The host
 * paragraph opens to 1.95 line-height so the glyph does not crowd the lines
 * above and below it.
 */
const W = 72;
const H = 20;
const PAD = 2; // keeps the 1.6px stroke inside the box at the extremes
const MAX_POINTS = 30;

/** Even x spacing, y normalised over the series' own range and inverted. */
function polyline(series: number[]): string {
  if (series.length === 0) return "";
  if (series.length === 1) {
    const y = H / 2;
    return `0,${y} ${W},${y}`;
  }
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo;
  const step = W / (series.length - 1);
  return series
    .map((v, i) => {
      // A flat series sits on the centre line rather than dividing by zero.
      const t = span === 0 ? 0.5 : (v - lo) / span;
      const y = H - PAD - t * (H - PAD * 2);
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function BlockSpark({ node }: { node: BlockNodeOf<"BLK-SPARK"> }) {
  const { hostText, series } = node.payload;
  const points = clampSeries("BLK-SPARK", series, MAX_POINTS);
  if (points.length === 0) {
    warnConstraint("BLK-SPARK", "empty series — nothing to draw, and a sparkline has no empty state.");
  }

  return (
    <p className="font-display text-[16px] leading-[1.95] text-ink-soft">
      {interpolate("BLK-SPARK", hostText, 1, () =>
        points.length === 0 ? (
          // No series, no shape. The sentence keeps its gap rather than
          // showing an invented trend.
          <span className="text-ink-faint">—</span>
        ) : (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="inline-block align-middle"
            aria-hidden
          >
            <polyline points={polyline(points)} fill="none" strokeWidth="1.6" className="stroke-ink" />
          </svg>
        ),
      )}
    </p>
  );
}

/**
 * Chart geometry — PURE, dependency-free, server-rendered SVG.
 *
 * ── WHY NOT VEGA-LITE (YET) ───────────────────────────────────────────────────
 * PD.6 specifies a compiler that emits themed Vega-Lite and rasterises it. That is the right
 * long-run answer for all 15 D-family shapes — a scatter, a waterfall and a candle are not worth
 * hand-rolling. It is not the right FIRST move here, for two reasons: `vega` risks pulling
 * node-canvas (cairo/pango) into the Vercel build, and a Vega-Lite spec that nothing rasterises
 * is the same "designed but not drawable" trap the block library has been in for a month.
 *
 * So: three shapes that actually draw, with zero new dependencies, over the real series contract
 * (lake.fn_resolve_series). Three renderable blocks beat fifteen undrawable ones. The remaining
 * twelve stay honestly unbuilt and resolve to MissingBlock rather than being stubbed.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No axis inference beyond min/max, no smoothing, no gap interpolation. A missing quarter is
 * drawn as a MISSING QUARTER — the line breaks — because interpolating one invents a figure the
 * lake does not have, which is the whole failure the binding contract exists to prevent.
 */

/** One resolved point. `objectId` travels with it so provenance survives the aggregation. */
export interface SeriesPoint {
  label: string;
  /** ISO date; used for ordering and spacing. */
  date: string | null;
  value: number | null;
  objectId: string;
  state: string;
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** `d` for a <path>, or "" when there is nothing continuous to draw. */
  linePath: string;
  areaPath: string;
  bars: { x: number; y: number; w: number; h: number; point: SeriesPoint }[];
  points: { x: number; y: number; point: SeriesPoint }[];
  min: number;
  max: number;
  /** True when at least one point was dropped for having no value — the caller must say so. */
  hasGaps: boolean;
}

const PAD = { top: 8, right: 8, bottom: 16, left: 8 };

/**
 * Project a series into drawable geometry.
 *
 * A point with a null value is NOT skipped silently — it breaks the path and sets `hasGaps`, so
 * the renderer can mark it. A chart that closes over a hole reads as continuous data.
 */
export function project(series: SeriesPoint[], width = 320, height = 96): ChartGeometry {
  const usable = series.filter((p) => typeof p.value === "number" && Number.isFinite(p.value));
  const hasGaps = usable.length !== series.length;

  const innerW = Math.max(width - PAD.left - PAD.right, 1);
  const innerH = Math.max(height - PAD.top - PAD.bottom, 1);

  if (usable.length === 0) {
    return { width, height, linePath: "", areaPath: "", bars: [], points: [], min: 0, max: 0, hasGaps };
  }

  const values = usable.map((p) => p.value as number);
  let min = Math.min(...values);
  let max = Math.max(...values);
  // A flat series must not divide by zero, and must not be drawn as a full-height bar either.
  if (min === max) { min -= Math.abs(min || 1) * 0.1; max += Math.abs(max || 1) * 0.1; }
  // Bars are read against zero; a bar chart whose baseline floats is a lie about magnitude.
  const barMin = Math.min(0, min);

  const n = series.length;
  const xAt = (i: number) => PAD.left + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const yAt = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

  const points: ChartGeometry["points"] = [];
  const segments: string[][] = [];
  let current: string[] = [];

  series.forEach((p, i) => {
    if (typeof p.value !== "number" || !Number.isFinite(p.value)) {
      // Break the path here rather than bridging the hole.
      if (current.length > 0) { segments.push(current); current = []; }
      return;
    }
    const x = xAt(i);
    const y = yAt(p.value);
    points.push({ x, y, point: p });
    current.push(`${current.length === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  });
  if (current.length > 0) segments.push(current);

  const linePath = segments.map((s) => s.join(" ")).join(" ");
  const areaPath =
    segments.length === 1 && points.length > 1
      ? `${segments[0]!.join(" ")} L${points[points.length - 1]!.x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} L${points[0]!.x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} Z`
      : "";

  // ── BARS GET THEIR OWN SCALE, ANCHORED AT ZERO ─────────────────────────────
  // The line scale runs min→max, which is right for a line: it shows the SHAPE of a change.
  // Reusing it for bars is not, because bar LENGTH is read as magnitude — on 100 vs 110 a
  // min-anchored scale draws one bar at zero height and the other at full height, overstating a
  // 10% difference as a 100% one. (Caught by the test, not by inspection.)
  const barMax = Math.max(0, max);
  const barSpan = barMax - barMin || 1;
  const barYAt = (v: number) => PAD.top + innerH - ((v - barMin) / barSpan) * innerH;

  const barW = Math.max(innerW / Math.max(n, 1) - 4, 2);
  const zeroY = barYAt(0);
  const bars = points.map((pt) => {
    const y = barYAt(pt.point.value as number);
    return {
      x: pt.x - barW / 2,
      y: Math.min(y, zeroY),
      w: barW,
      // A one-pixel floor so a zero value is still a visible mark rather than nothing at all.
      h: Math.max(Math.abs(zeroY - y), 1),
      point: pt.point,
    };
  });

  return { width, height, linePath, areaPath, bars, points, min, max, hasGaps };
}

/** Every distinct object behind a series — what BLK-PROV under the exhibit must stamp. */
export function seriesProvenance(series: SeriesPoint[]): { objectIds: string[]; allVerified: boolean } {
  const objectIds = [...new Set(series.map((p) => p.objectId).filter(Boolean))];
  const allVerified = series.length > 0 && series.every((p) => p.state === "VERIFIED");
  return { objectIds, allVerified };
}

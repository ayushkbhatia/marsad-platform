import { warnConstraint } from "../constraints";
import { project, type SeriesPoint } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-LINE · Annotated time series — "WHEN DID IT TURN?"
 *
 * "A line chart without its annotation is decoration." The annotation is required by the schema,
 * and drawn as a dashed vertical with a hollow marker at the annotated period — the reader should
 * be able to see WHERE the prose's event sits without reading the caption.
 *
 * The endpoint is emphasised because the prose is almost always about where the series ended.
 */
export function BlockLine({ node }: { node: BlockNodeOf<"BLK-LINE"> }) {
  const { caption, series, annotation, unit } = node.payload;
  const points = (series[0]?.points ?? []) as SeriesPoint[];

  if (!annotation?.whatHappened) {
    warnConstraint("BLK-LINE", "no annotation — an unannotated line chart is decoration.");
  }

  const g = project(points, 640, 190);
  const last = g.points[g.points.length - 1];
  // The annotation names a period, not an index. Match on either the label or the ISO date so a
  // writer who wrote "Q2 2026" and one who wrote "2026-06-30" both land on the same quarter.
  const marked = g.points.find(
    (p) => p.point.label === annotation?.at || p.point.date === annotation?.at,
  );

  return (
    <ChartFrame question="WHEN DID IT TURN?" caption={caption} unit={unit} series={series} gaps={g.hasGaps}>
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${caption}. ${annotation?.whatHappened ?? ""}`}
      >
        <line x1={0} y1={g.height - 16} x2={g.width} y2={g.height - 16} className="stroke-rule" strokeWidth={1} />
        {marked ? (
          <line
            x1={marked.x} y1={6} x2={marked.x} y2={g.height - 16}
            className="stroke-ink-faint" strokeWidth={1} strokeDasharray="3 3"
          />
        ) : null}
        <path d={g.linePath} fill="none" className="stroke-ink" strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />
        {marked ? (
          <circle cx={marked.x} cy={marked.y} r={4} className="fill-paper stroke-ink" strokeWidth={2} />
        ) : null}
        {last ? <circle cx={last.x} cy={last.y} r={3} className="fill-ink" /> : null}
      </svg>

      <div className="mt-2 flex justify-between font-mono text-[8.5px] uppercase tracking-[0.1em] text-ink-faint">
        <span>{g.points[0]?.point.label}</span>
        <span>{last?.point.label}</span>
      </div>

      {annotation?.whatHappened ? (
        <p className="mt-3 border-l-2 border-ink pl-3 text-[12.5px] leading-[1.55] text-ink">
          {annotation.whatHappened}
        </p>
      ) : null}
    </ChartFrame>
  );
}

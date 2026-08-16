import { warnConstraint } from "../constraints";
import { project, type SeriesPoint } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-AREA · Share-of-total area — "HOW MUCH NOW?"
 *
 * "Never more than three areas; beyond that the block is BLK-STACK." The Zod schema caps it at
 * three, and the renderer warns loudly rather than drawing a fourth — a shape silently rendering
 * outside its own contract is how a block library stops meaning anything.
 *
 * The fill is what makes this an area rather than a line, so a series with a hole is drawn as a
 * LINE ONLY. `project` returns an empty `areaPath` when the path is discontinuous, because a
 * filled region that closes over a gap claims area the lake never measured.
 */
export function BlockArea({ node }: { node: BlockNodeOf<"BLK-AREA"> }) {
  const { caption, series, unit } = node.payload;
  if (series.length > 3) {
    warnConstraint("BLK-AREA", `${series.length} areas — the card caps it at three; beyond that use BLK-STACK.`);
  }

  const drawn = series.slice(0, 3).map((s) => ({
    label: s.label,
    g: project(s.points as SeriesPoint[], 640, 190),
  }));
  const gaps = drawn.some((d) => d.g.hasGaps);
  const first = drawn[0]?.g;

  return (
    <ChartFrame question="HOW MUCH NOW?" caption={caption} unit={unit} series={series} gaps={gaps}>
      <svg viewBox={`0 0 ${first?.width ?? 640} ${first?.height ?? 190}`} className="h-auto w-full"
           role="img" aria-label={caption}>
        {drawn.map((d, i) => (
          <g key={d.label} className={i === 0 ? "text-ink" : i === 1 ? "text-ink-mid" : "text-ink-faint"}>
            {d.g.areaPath ? (
              <path d={d.g.areaPath} className="fill-current" opacity={0.14} />
            ) : null}
            <path d={d.g.linePath} fill="none" className="stroke-current" strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        <line x1={0} y1={(first?.height ?? 190) - 16} x2={first?.width ?? 640} y2={(first?.height ?? 190) - 16}
              className="stroke-rule" strokeWidth={1} />
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {drawn.map((d, i) => (
          <span key={d.label} className="flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.1em] text-ink-faint">
            <span className={`inline-block h-2 w-2 ${i === 0 ? "bg-ink" : i === 1 ? "bg-ink-mid" : "bg-ink-faint"}`} />
            {d.label}
          </span>
        ))}
      </div>
    </ChartFrame>
  );
}

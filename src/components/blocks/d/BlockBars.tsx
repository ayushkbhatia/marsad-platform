import { project, type SeriesPoint } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-BARS · Categorical bars — "WHO IS BIGGEST?"
 *
 * Each series entry is one CATEGORY, so each resolves to exactly one point — this shape does not
 * expand a family the way BLK-LINE does. Sorting is the RENDERER's, computed from the resolved
 * values, because the writer never saw them: it emitted bindings, and the card's rule is
 * "categories sorted descending by the resolved value".
 *
 * `leadCount` greys the tail so the lead reads first. Value labels sit on top of the bars and
 * there is no axis, per the card — an axis on a categorical chart invites reading the gaps
 * between bars as meaningful.
 */
export function BlockBars({ node }: { node: BlockNodeOf<"BLK-BARS"> }) {
  const { caption, series, leadCount, unit } = node.payload;

  const cats = series
    .map((s) => ({ label: s.label, point: s.points[0] ?? null }))
    .sort((a, b) => (b.point?.value ?? -Infinity) - (a.point?.value ?? -Infinity));

  // Feed the geometry one point per category, labelled by the category rather than the period.
  const asSeries: SeriesPoint[] = cats.map((c) => ({
    label: c.label,
    date: c.point?.date ?? null,
    value: c.point?.value ?? null,
    objectId: c.point?.objectId ?? "",
    state: c.point?.state ?? "UNKNOWN",
  }));

  const g = project(asSeries, 640, 200);
  const lead = Math.max(1, leadCount);

  return (
    <ChartFrame question="WHO IS BIGGEST?" caption={caption} unit={unit} series={series} gaps={g.hasGaps}>
      <svg viewBox={`0 0 ${g.width} ${g.height}`} className="h-auto w-full" role="img" aria-label={caption}>
        {g.bars.map((b, i) => (
          <g key={`${b.point.objectId}-${i}`}>
            <rect
              x={b.x} y={b.y} width={b.w} height={b.h}
              className={i < lead ? "fill-ink" : "fill-ink-faint"}
            />
            <text
              x={b.x + b.w / 2} y={b.y - 4}
              textAnchor="middle"
              className="fill-ink-mid font-mono text-[9px]"
            >
              {formatValue(b.point.value)}
            </text>
          </g>
        ))}
        <line x1={0} y1={g.height - 16} x2={g.width} y2={g.height - 16} className="stroke-rule" strokeWidth={1} />
      </svg>

      <div className="mt-1 grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(cats.length, 1)}, 1fr)` }}>
        {cats.map((c, i) => (
          <span
            key={`${c.label}-${i}`}
            className={`truncate text-center font-mono text-[8.5px] uppercase tracking-[0.06em] ${
              i < lead ? "text-ink-mid" : "text-ink-faint"
            }`}
          >
            {c.label}
          </span>
        ))}
      </div>
    </ChartFrame>
  );
}

/** Compact enough to sit above a bar without colliding with its neighbour. */
function formatValue(v: number | null): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}bn`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v * 100) / 100);
}

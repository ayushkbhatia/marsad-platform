export interface DatapointBarPoint {
  period: string;
  value: number;
}

/**
 * Server-rendered inline-SVG bar chart for a datapoint series (18b) — same "no charting
 * library" rule as `Sparkline`/`PriceChart` (CONVENTIONS §4). Oldest → newest, left to right;
 * the newest bar is darkest (matches the design's ramp from `#cfcabe` to `#14120e`).
 */
export function DatapointBars({
  points,
  width = 640,
  height = 200,
}: {
  points: DatapointBarPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <span className="font-mono text-[9px] text-ink-faint">Not enough history to chart yet</span>;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const labelH = 16;
  const plotH = height - labelH;

  const n = points.length;
  const gap = 8;
  const barW = (width - gap * (n - 1)) / n;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Datapoint series, oldest to newest"
    >
      {points.map((p, i) => {
        const h = Math.max(1, ((p.value - min) / span) * plotH);
        const x = i * (barW + gap);
        const y = plotH - h;
        const isLast = i === n - 1;
        const tone = isLast ? "fill-ink" : i === n - 2 ? "fill-ink-mid" : "fill-hairline-strong";
        return (
          <g key={`${p.period}-${i}`}>
            <rect x={x} y={y} width={barW} height={h} className={tone} />
            <text
              x={x + barW / 2}
              y={height - 4}
              textAnchor="middle"
              className={`font-mono text-[8px] ${isLast ? "fill-ink font-semibold" : "fill-ink-faint"}`}
            >
              {p.period}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

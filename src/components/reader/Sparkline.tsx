/**
 * Server-rendered inline-SVG sparkline from REAL daily closes (oldest→newest).
 * Unlike `TickerChip`'s decorative seeded sparkline, this draws actual price
 * data. Pure/deterministic → identical server + client markup. Colored by the
 * net direction across the window (positive/negative price tokens).
 */
export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Draw a faint area fill under the line. */
  fill?: boolean;
  className?: string;
}

export function Sparkline({
  values,
  width = 140,
  height = 36,
  fill = true,
  className,
}: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <span className={`font-mono text-[9px] text-ink-faint ${className ?? ""}`}>
        no price history
      </span>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pad = 2;
  const innerH = height - pad * 2;
  const stepX = width / (clean.length - 1);

  const up = clean[clean.length - 1] >= clean[0];
  const stroke = up ? "stroke-positive" : "stroke-negative";
  const fillCls = up ? "fill-positive/10" : "fill-negative/10";

  const pts = clean.map((v, i) => {
    const x = i * stepX;
    const y = pad + innerH - ((v - min) / span) * innerH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`flex-none ${className ?? ""}`}
      role="img"
      aria-label={`Price sparkline, ${up ? "up" : "down"} over the period`}
    >
      {fill ? <polygon points={area} className={fillCls} stroke="none" /> : null}
      <polyline points={line} fill="none" strokeWidth="1.5" className={stroke} />
    </svg>
  );
}

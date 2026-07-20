import { fmtPrice, fmtDate } from "@/lib/reader/format";

/**
 * Server-rendered price chart — an inline SVG area/line of daily closes.
 *
 * v1 is deliberately server-only and dependency-free: a responsive area chart
 * with min/max/last price gridlines and start/end date labels. It is NOT
 * interactive (no crosshair/tooltip/zoom).
 *
 * SEAM — INTERACTIVE CANDLES LATER: when the reader adds an interactive candle
 * chart, swap THIS component for a client island (e.g. lightweight-charts)
 * behind the same `points` contract. The data fn (`getOhlcvSeries`) already
 * returns OHLC per bar, so the upgrade is presentational only — the page/route
 * and the range selector stay unchanged.
 */

export interface PriceChartPoint {
  date: string;
  close: number | null;
}

export interface PriceChartProps {
  points: PriceChartPoint[];
  /** viewBox width/height — the SVG scales to its container via width=100%. */
  width?: number;
  height?: number;
}

export function PriceChart({ points, width = 960, height = 340 }: PriceChartProps) {
  const clean = points.filter((p) => p.close != null && Number.isFinite(p.close)) as {
    date: string;
    close: number;
  }[];

  if (clean.length < 2) {
    return (
      <div className="flex h-[280px] items-center justify-center border border-dashed border-hairline bg-paper">
        <p className="font-mono text-[11px] tracking-[0.08em] text-ink-faint uppercase">
          No price history for this range
        </p>
      </div>
    );
  }

  const padL = 8;
  const padR = 64; // room for the right-hand price axis labels
  const padT = 14;
  const padB = 26; // room for the date axis labels
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const closes = clean.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = plotW / (clean.length - 1);

  const x = (i: number) => padL + i * stepX;
  const y = (v: number) => padT + plotH - ((v - min) / span) * plotH;

  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "stroke-positive" : "stroke-negative";
  const fillCls = up ? "fill-positive/8" : "fill-negative/8";

  const linePts = clean.map((p, i) => `${x(i).toFixed(2)},${y(p.close).toFixed(2)}`).join(" ");
  const areaPts = `${padL},${padT + plotH} ${linePts} ${(padL + plotW).toFixed(2)},${padT + plotH}`;

  // Five horizontal gridlines across the price range.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + span * f);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Daily closing price, ${fmtDate(clean[0].date)} to ${fmtDate(
        clean[clean.length - 1].date,
      )}`}
    >
      {/* Gridlines + right-hand price labels */}
      {ticks.map((t, i) => {
        const gy = y(t);
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={padL + plotW}
              y1={gy}
              y2={gy}
              className="stroke-hairline-soft"
              strokeWidth="1"
            />
            <text
              x={padL + plotW + 6}
              y={gy + 3}
              className="fill-ink-faint font-mono"
              style={{ fontSize: "10px" }}
            >
              {fmtPrice(t)}
            </text>
          </g>
        );
      })}

      {/* Area + line */}
      <polygon points={areaPts} className={fillCls} stroke="none" />
      <polyline points={linePts} fill="none" strokeWidth="1.5" className={stroke} />

      {/* Start / end date labels */}
      <text
        x={padL}
        y={height - 8}
        className="fill-ink-faint font-mono"
        style={{ fontSize: "10px" }}
      >
        {fmtDate(clean[0].date)}
      </text>
      <text
        x={padL + plotW}
        y={height - 8}
        textAnchor="end"
        className="fill-ink-faint font-mono"
        style={{ fontSize: "10px" }}
      >
        {fmtDate(clean[clean.length - 1].date)}
      </text>
    </svg>
  );
}

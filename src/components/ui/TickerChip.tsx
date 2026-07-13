import type { Surface } from "./types";

export interface TickerChipProps {
  /** Ticker / index code, e.g. "TASI", "2222" */
  code?: string;
  /** Formatted last level/price, e.g. "11,842.60" */
  level?: string;
  /** Formatted change, e.g. "0.42%" — the ▲/▼ glyph is added by `dir` */
  chg?: string;
  dir?: "up" | "down";
  /** Render the inline sparkline (44×14 SVG) */
  sparkline?: boolean;
  surface?: Surface;
}

/**
 * Deterministic decorative sparkline, ported verbatim from TickerChip.dc.html.
 * Seeded by the ticker code so server and client render identical markup —
 * this is a visual texture, not real price data (scrape-only delayed data
 * arrives elsewhere; callers with real closes should use charts/Sparkline).
 */
export function sparklinePoints(code: string, up: boolean): string {
  let h = 7;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 9973;
  const pts: string[] = [];
  for (let i = 0; i <= 10; i++) {
    h = (h * 137 + 71) % 9973;
    const noise = ((h % 100) / 100 - 0.5) * 3;
    const base = up ? 12 - i * 0.85 : 2 + i * 0.85;
    pts.push(
      `${(i * 4.4).toFixed(1)},${Math.min(13, Math.max(1, base + noise)).toFixed(1)}`,
    );
  }
  return pts.join(" ");
}

/** Inline code + level + sparkline + change chip (index strips, movers). */
export function TickerChip({
  code = "TASI",
  level = "11,842.60",
  chg = "0.42%",
  dir = "up",
  sparkline = true,
  surface = "light",
}: TickerChipProps) {
  const dark = surface === "dark";
  const up = dir === "up";

  return (
    <div
      className={`inline-flex items-baseline gap-[7px] whitespace-nowrap font-ui ${
        dark ? "text-paper-tint" : "text-ink"
      }`}
    >
      <span className="font-mono text-[10.5px] font-semibold tracking-[0.04em]">
        {code}
      </span>
      <span
        className={`text-[12px] tabular-nums ${
          dark ? "text-hairline-strong" : "text-ink-mid"
        }`}
      >
        {level}
      </span>
      {sparkline && (
        <svg width="44" height="14" viewBox="0 0 44 14" className="flex-none self-center">
          <polyline
            points={sparklinePoints(code, up)}
            fill="none"
            strokeWidth="1.5"
            className={dark ? "stroke-paper-tint" : "stroke-ink"}
          />
        </svg>
      )}
      <span
        className={`text-[11px] font-semibold tabular-nums ${
          up
            ? dark
              ? "text-positive-dark"
              : "text-positive"
            : dark
              ? "text-negative-dark"
              : "text-negative"
        }`}
      >
        {up ? "▲" : "▼"} {chg}
      </span>
    </div>
  );
}

import type { Surface } from "./types";

export interface StatItem {
  /** Mono micro-label above the value (e.g. "MKT CAP", "P/E", "NEXT EX-DATE"). */
  label: string;
  /** Newsreader value (already formatted — pass "—" for null). */
  value: string;
  /** Optional signed delta / sublabel under the value. */
  delta?: string;
  /** Direction tints the delta: up=positive, down=negative, undefined=muted. */
  dir?: "up" | "down";
}

export interface StatStripProps {
  items: StatItem[];
  surface?: Surface;
  className?: string;
}

/**
 * Stat strip (server component). Bordered band of flex cells: a mono micro-label
 * over a Newsreader value (README §Stat strips). The workhorse KPI bar on stock
 * headers, calendars, alerts, watchlist summaries. Cells wrap on narrow widths.
 */
export function StatStrip({ items, surface = "light", className = "" }: StatStripProps) {
  const dark = surface === "dark";
  const shell = dark
    ? "border-dark-hairline-strong bg-dark-panel divide-dark-hairline"
    : "border-hairline bg-paper-tint divide-hairline";
  const label = dark ? "text-dark-text-faint" : "text-ink-faint";
  const value = dark ? "text-dark-text" : "text-ink";

  return (
    <dl
      className={`flex flex-wrap divide-x border ${shell} ${className}`}
    >
      {items.map((it, i) => {
        const deltaColor =
          it.dir === "up"
            ? dark
              ? "text-positive-dark"
              : "text-positive"
            : it.dir === "down"
              ? dark
                ? "text-negative-dark"
                : "text-negative"
              : dark
                ? "text-dark-text-faint"
                : "text-ink-muted";
        return (
          <div key={`${it.label}-${i}`} className="flex min-w-[104px] flex-1 flex-col gap-1 px-3.5 py-2.5">
            <dt className={`font-mono text-[8px] font-medium tracking-[0.14em] uppercase ${label}`}>
              {it.label}
            </dt>
            <dd className={`font-display text-[23px] leading-none tabular-nums ${value}`}>
              {it.value}
            </dd>
            {it.delta != null && (
              <span className={`font-mono text-[10px] tabular-nums ${deltaColor}`}>{it.delta}</span>
            )}
          </div>
        );
      })}
    </dl>
  );
}

import type { StatCell, WatchlistData } from "@/lib/data/sample/watchlist";

/**
 * Watchlist (1h) stat strip — a bordered paper-tint band of five equal cells
 * (Names · today's equal-weighted return · best · worst · alerts triggered),
 * divided by 1px rules. Sample-driven for the fidelity pass.
 */
function Cell({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex-1 px-[18px] py-3 ${last ? "" : "border-r border-hairline"}`}>
      <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{label}</div>
      <div className="mt-[3px] text-[16px] font-semibold text-ink">{children}</div>
    </div>
  );
}

export function WatchlistStatStrip({
  stats,
  best,
  worst,
  alertsTriggered,
}: {
  stats: StatCell[];
  best: WatchlistData["best"];
  worst: WatchlistData["worst"];
  alertsTriggered: WatchlistData["alertsTriggered"];
}) {
  const [names, ret] = stats;

  return (
    <div className="mt-4 flex flex-wrap border border-hairline bg-paper-tint sm:flex-nowrap">
      <Cell label={names.label}>{names.value}</Cell>
      <Cell label={ret.label}>
        <span className={ret.dir === "down" ? "text-negative" : "text-positive"}>{ret.value}</span>
      </Cell>
      <Cell label="Best">
        {best.ticker} <span className="text-positive">{best.pct}</span>
      </Cell>
      <Cell label="Worst">
        {worst.ticker} <span className="text-negative">{worst.pct}</span>
      </Cell>
      <Cell label="Alerts triggered today" last>
        {alertsTriggered.count}{" "}
        <span className="text-[11px] font-normal text-ink-muted">— {alertsTriggered.names}</span>
      </Cell>
    </div>
  );
}

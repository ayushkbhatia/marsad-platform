import type { SectorHeatmapCell } from "@/lib/data/markets";
import { fmtSignedPct } from "@/lib/reader/format";

/**
 * Sector breadth heatmap — a server-rendered, dependency-free treemap-ish grid
 * on the dark data-room surface. Tiles are sized by security count (√-weighted
 * flex-grow so one dominant bucket doesn't swallow the row) and colored by mean
 * change% via the design tokens' 9-step `--color-heatmap-*` scale (−3% … +3%).
 *
 * Honest degradation: a sector with no quoted names (`avgChangePct == null`)
 * renders a neutral panel tile labelled "no quotes" rather than a fake colour.
 * All inputs come from the public `getSectorHeatmap` reader (no premium data).
 */

/** Map mean change% (−3 … +3) onto the 9-step token scale (1 = deep red … 9 = deep green). */
function heatVar(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "var(--color-dark-panel)";
  const clamped = Math.max(-3, Math.min(3, pct));
  const bucket = Math.max(1, Math.min(9, Math.round(5 + (clamped / 3) * 4)));
  return `var(--color-heatmap-${bucket})`;
}

export function SectorHeatmap({ cells }: { cells: SectorHeatmapCell[] }) {
  const withData = cells.filter((c) => c.count > 0);
  if (withData.length === 0) {
    return (
      <div className="border border-dark-hairline bg-dark-panel px-4 py-10 text-center font-mono text-[11px] text-dark-text-faint">
        No sector breadth yet.
      </div>
    );
  }

  return (
    <div className="bg-dark-bg p-2">
      <div className="flex flex-wrap gap-1.5">
        {withData.map((c) => {
          const quoted = c.avgChangePct != null;
          return (
            <div
              key={c.key}
              className="flex min-w-[128px] flex-col justify-between gap-2 border border-dark-hairline/60 px-3 py-2.5"
              style={{
                backgroundColor: heatVar(c.avgChangePct),
                flexGrow: Math.sqrt(c.count),
                flexBasis: `${Math.max(128, Math.round(Math.sqrt(c.count) * 34))}px`,
              }}
              title={`${c.name} — ${c.count} names, ${c.quoted} quoted`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-ui text-[12px] font-semibold leading-tight text-dark-text">
                  {c.name}
                </span>
                <span className="font-mono text-[9px] tabular-nums text-dark-text-faint">
                  {c.count}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[15px] font-semibold tabular-nums text-dark-text">
                  {quoted ? fmtSignedPct(c.avgChangePct) : "—"}
                </span>
                <span className="font-mono text-[8.5px] tracking-[0.04em] text-dark-text-mid">
                  {quoted ? `▲${c.advancers} ▼${c.decliners}` : "no quotes"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

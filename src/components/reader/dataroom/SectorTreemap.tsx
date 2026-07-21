import type { CSSProperties } from "react";
import Link from "next/link";
import type { SectorHeatmapCell } from "@/lib/data/markets";
import type { HeatmapConstituent } from "@/lib/data/dataroom";
import { fmtSignedPct, fmtPrice } from "@/lib/reader/format";

/**
 * The heatmap's per-security tile grid — the "1e" nested treemap, extended
 * (not restyled) to a `surface` prop so the same component drives both the
 * dark terminal edition and the `?edition=paper` light edition. Two exports:
 *
 *   - `SectorTreemap`   — every sector as a compact strip of small tiles (the
 *                         default `/heatmap` landing).
 *   - `SectorFocusPanel`— one sector's constituents at a larger tile size (the
 *                         `?sector=` drilldown).
 *
 * Honest degradation: `securities.shares_outstanding` is null for ~94% of the
 * universe today (see 07-lake-enrichment §3), so there is no reliable market
 * cap to weight tiles by. Tile size here is instead driven by the magnitude of
 * the day's move — a real, available number — never a fabricated weight.
 */

type Surface = "light" | "dark";

/** 9-step dark scale — `globals.css` scopes `--color-heatmap-*` to "dark data-room only". */
function darkHeatVar(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "var(--color-dark-panel)";
  const clamped = Math.max(-3, Math.min(3, pct));
  const bucket = Math.max(1, Math.min(9, Math.round(5 + (clamped / 3) * 4)));
  return `var(--color-heatmap-${bucket})`;
}

/**
 * The light/paper edition has no sequential heatmap token to reach for, so the
 * scale is composed from the two existing direction tokens (`positive`/
 * `negative`) at varying opacity — composition, not a new hex or new token.
 */
function lightHeatClass(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "bg-paper-tint";
  const c = Math.max(-3, Math.min(3, pct));
  if (c <= -2) return "bg-negative/35";
  if (c <= -1) return "bg-negative/22";
  if (c <= -0.15) return "bg-negative/10";
  if (c < 0.15) return "bg-paper-tint";
  if (c < 1) return "bg-positive/12";
  if (c < 2) return "bg-positive/24";
  return "bg-positive/40";
}

function tileGrow(pct: number | null): number {
  return 1 + Math.min(Math.abs(pct ?? 0), 4);
}

function ConstituentTile({
  c,
  surface,
  size = "sm",
}: {
  c: HeatmapConstituent;
  surface: Surface;
  size?: "sm" | "lg";
}) {
  const dark = surface === "dark";
  const style: CSSProperties = {
    flexGrow: tileGrow(c.changePct),
    ...(dark ? { backgroundColor: darkHeatVar(c.changePct) } : {}),
  };
  const bgClass = dark ? "" : lightHeatClass(c.changePct);
  const text = dark ? "text-dark-text" : "text-ink";
  const border = dark ? "border-dark-hairline/60" : "border-hairline-soft";
  const lg = size === "lg";

  return (
    <Link
      href={`/stocks/${c.venueCode}/${c.ticker}`}
      className={`flex ${lg ? "min-w-[132px]" : "min-w-[84px]"} flex-col justify-between gap-1.5 border px-2.5 py-2 no-underline ${border} ${bgClass} ${text}`}
      style={style}
      title={`${c.name} — ${fmtSignedPct(c.changePct)}`}
    >
      <span className={`font-mono font-semibold tabular-nums ${lg ? "text-[13px]" : "text-[10.5px]"}`}>
        {c.ticker}
      </span>
      {lg && (
        <span className={`truncate font-ui text-[11px] ${dark ? "text-dark-text-mid" : "text-ink-muted"}`}>
          {c.name}
        </span>
      )}
      <div className="flex items-baseline justify-between gap-2">
        {lg && (
          <span className="font-mono text-[10.5px] tabular-nums opacity-80">{fmtPrice(c.last)}</span>
        )}
        <span className={`font-mono tabular-nums ${lg ? "text-[12px] font-semibold" : "text-[10px] font-semibold"}`}>
          {fmtSignedPct(c.changePct)}
        </span>
      </div>
    </Link>
  );
}

export function SectorTreemap({
  cells,
  constituentsByKey,
  surface,
  sectorHref,
}: {
  cells: SectorHeatmapCell[];
  constituentsByKey: Record<string, HeatmapConstituent[]>;
  surface: Surface;
  sectorHref: (sectorKey: string) => string;
}) {
  const dark = surface === "dark";
  const withData = cells.filter((c) => c.count > 0);

  return (
    <div className="flex flex-col gap-3">
      {withData.map((cell) => {
        const items = constituentsByKey[cell.key] ?? [];
        const up = (cell.avgChangePct ?? 0) > 0;
        const dirColor =
          cell.avgChangePct == null
            ? dark
              ? "text-dark-text-faint"
              : "text-ink-faint"
            : up
              ? dark
                ? "text-positive-dark"
                : "text-positive"
              : dark
                ? "text-negative-dark"
                : "text-negative";

        return (
          <div key={cell.key} className="flex flex-col gap-1">
            <Link
              href={sectorHref(cell.key)}
              className={`flex items-baseline gap-2 font-mono text-[9.5px] tracking-[0.14em] uppercase no-underline hover:underline underline-offset-2 ${
                dark ? "text-dark-text-faint hover:text-dark-text" : "text-ink-faint hover:text-ink"
              }`}
            >
              <span>{cell.name}</span>
              <span className="opacity-70">{cell.count} names</span>
              <span className={dirColor}>
                {cell.avgChangePct != null ? fmtSignedPct(cell.avgChangePct) : "no quotes"}
              </span>
            </Link>
            {items.length > 0 ? (
              <div className="flex flex-wrap gap-[2px]">
                {items.map((c) => (
                  <ConstituentTile key={c.securityId} c={c} surface={surface} />
                ))}
              </div>
            ) : (
              <div
                className={`border px-3 py-3 font-mono text-[10px] ${
                  dark ? "border-dark-hairline/60 text-dark-text-faint" : "border-hairline-soft text-ink-faint"
                }`}
              >
                No quoted names in this sector yet.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The `?sector=` drilldown: one sector's constituents at a larger tile size. */
export function SectorFocusPanel({ items, surface }: { items: HeatmapConstituent[]; surface: Surface }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-[3px]">
      {items.map((c) => (
        <ConstituentTile key={c.securityId} c={c} surface={surface} size="lg" />
      ))}
    </div>
  );
}

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

/**
 * 9-step scale, literal hex — copied 1:1 from `globals.css`'s
 * `--color-heatmap-1..9` (keep in sync if that palette ever changes; this
 * file does not edit globals.css). Previously built `var(--color-heatmap-${bucket})`
 * at runtime, which Tailwind v4 never emits into the compiled stylesheet
 * (its static scanner only picks up `@theme` colors that appear as an actual
 * utility class like `bg-heatmap-8`, not a computed `var()` string) — every
 * tile rendered with NO background at all, matching the same root cause
 * fixed in `SectorTreemap.tsx`'s `darkHeatVar`. Also applies the same signed
 * square-root push so realistic sub-1% moves are visibly distinct from
 * bucket 5 instead of collapsing into the near-black center of the scale.
 */
const HEATMAP_HEX: Record<number, string> = {
  1: "#7a291f",
  2: "#5c261f",
  3: "#32241e",
  4: "#232e22",
  5: "#203a27",
  6: "#1a5c32",
  7: "#1c6b38",
  8: "#1f7a3f",
  9: "#1f8a45",
};

/** Bucket 1..9, or `null` for a missing/non-finite move (renders the neutral panel color). */
function heatBucket(pct: number | null): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const clamped = Math.max(-3, Math.min(3, pct));
  const pushed = Math.sign(clamped) * Math.sqrt(Math.abs(clamped) / 3) * 3;
  return Math.max(1, Math.min(9, Math.round(5 + (pushed / 3) * 4)));
}

function heatVar(bucket: number | null): string {
  return bucket == null ? "var(--color-dark-panel)" : HEATMAP_HEX[bucket];
}

/**
 * Text sits directly on the tile fill, so each role needs its own contrast
 * check against the specific bucket color, not just `--color-dark-bg`
 * (measured against every bucket's hex; see `SectorTreemap.tsx#darkHeatVar`
 * for the full table). `text-dark-text` (12px name) only drops under 4.5:1
 * on bucket 9; the fainter `text-dark-text-faint`/`text-dark-text-mid`
 * (count + advancers/decliners, 8.5–9px) already fail badly by bucket 8. Ink
 * text is the better of two imperfect options past those points — neither
 * choice reaches AA on the brightest greens at this font size, which is a
 * palette-level limit (flagged to the lead) — but ink is measurably closer.
 */
function heatPrimaryText(bucket: number | null): string {
  return bucket === 9 ? "text-ink" : "text-dark-text";
}
function heatFaintText(bucket: number | null): string {
  // Solid ink, not a translucent `text-ink/NN` — opacity would blend back
  // toward the tile color and undo the contrast gain this is here for.
  return bucket != null && bucket >= 8 ? "text-ink" : "text-dark-text-faint";
}
function heatMidText(bucket: number | null): string {
  return bucket != null && bucket >= 8 ? "text-ink" : "text-dark-text-mid";
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
          const bucket = heatBucket(c.avgChangePct);
          return (
            <div
              key={c.key}
              className="flex min-w-[128px] flex-col justify-between gap-2 border border-dark-hairline/60 px-3 py-2.5"
              style={{
                backgroundColor: heatVar(bucket),
                flexGrow: Math.sqrt(c.count),
                flexBasis: `${Math.max(128, Math.round(Math.sqrt(c.count) * 34))}px`,
              }}
              title={`${c.name} — ${c.count} names, ${c.quoted} quoted`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`font-ui text-[12px] font-semibold leading-tight ${heatPrimaryText(bucket)}`}>
                  {c.name}
                </span>
                <span className={`font-mono text-[9px] tabular-nums ${heatFaintText(bucket)}`}>
                  {c.count}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`font-mono text-[15px] font-semibold tabular-nums ${heatPrimaryText(bucket)}`}>
                  {quoted ? fmtSignedPct(c.avgChangePct) : "—"}
                </span>
                <span className={`font-mono text-[8.5px] tracking-[0.04em] ${heatMidText(bucket)}`}>
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

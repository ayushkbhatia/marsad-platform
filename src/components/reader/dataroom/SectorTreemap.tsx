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

/**
 * 9-step dark scale, literal hex — copied 1:1 from `globals.css`'s
 * `--color-heatmap-1..9` (keep in sync if that palette ever changes; this
 * file does not edit globals.css). This used to reference the tokens via
 * `var(--color-heatmap-${bucket})`, which renders as a fully TRANSPARENT
 * background: Tailwind v4 only emits an `@theme` color's CSS custom property
 * when something in the scanned source matches it as a utility class
 * (`bg-heatmap-8` etc.); a plain runtime `var()` string built from a computed
 * bucket number is invisible to that static scan, so `--color-heatmap-*`
 * never made it into the compiled stylesheet at all (verified: zero
 * occurrences of "heatmap" in the built CSS, confirmed with devtools against
 * the running preview) — every tile has been rendering with NO background
 * color, not just a subtle one. Inlining the hex values sidesteps the
 * indirection entirely and needs no globals.css change.
 *
 * On top of that, the caption below reads "1D change, −3% → +3%" (a real,
 * intentional domain — do not change it here), but real GCC daily moves
 * cluster tightly inside that ±3% band (median well under ±1%). A LINEAR
 * map from pct → bucket crowds almost every tile into the three near-black
 * center buckets (4/5/6). A signed square-root curve pushes small moves
 * outward toward the red/green ends faster, while ±3% (the labeled domain
 * edge) still maxes out bucket 1/9 exactly as before — same domain, same 9
 * colors, more perceptible intensity at the magnitudes that actually occur.
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
function darkHeatBucket(pct: number | null): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const clamped = Math.max(-3, Math.min(3, pct));
  const pushed = Math.sign(clamped) * Math.sqrt(Math.abs(clamped) / 3) * 3;
  return Math.max(1, Math.min(9, Math.round(5 + (pushed / 3) * 4)));
}

function darkHeatVar(bucket: number | null): string {
  return bucket == null ? "var(--color-dark-panel)" : HEATMAP_HEX[bucket];
}

/**
 * Ticker/price text sits directly on the tile fill, so it needs its own
 * contrast check against each of the 9 background colors, not just against
 * `--color-dark-bg`. `text-dark-text` (#f0ede2) clears 4.5:1 (WCAG AA, small
 * text) on 8 of the 9 buckets — only the brightest green (bucket 9,
 * #1f8a45) drops it to 3.75:1. Ink-black text does better there (4.26:1,
 * still short of 4.5 — the palette itself cannot reach AA on that single
 * swatch at mono ticker sizes; flagged to the lead, a token-level fix is
 * out of scope here) but is worse everywhere else, so it's used only for
 * that one bucket rather than globally.
 */
function darkHeatTextClass(bucket: number | null): string {
  return bucket === 9 ? "text-ink" : "text-dark-text";
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
  const bucket = dark ? darkHeatBucket(c.changePct) : null;
  const style: CSSProperties = {
    flexGrow: tileGrow(c.changePct),
    ...(dark ? { backgroundColor: darkHeatVar(bucket) } : {}),
  };
  const bgClass = dark ? "" : lightHeatClass(c.changePct);
  const text = dark ? darkHeatTextClass(bucket) : "text-ink";
  // Bucket 9 (brightest green) also needs the muted name label bumped to the
  // same high-contrast ink text — `text-dark-text-mid` drops under 3:1 there
  // (see `darkHeatTextClass`).
  const mutedText = dark ? (bucket === 9 ? "text-ink" : "text-dark-text-mid") : "text-ink-muted";
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
        <span className={`truncate font-ui text-[11px] ${mutedText}`}>
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

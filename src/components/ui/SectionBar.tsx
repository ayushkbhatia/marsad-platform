import type { ReactNode } from "react";
import type { Surface } from "./types";

/**
 * "band" (default, unchanged) = the design's black `#14120e` section band.
 * "rule" = an uppercase label over a 2px ink bottom rule, no fill — the
 * design's *dominant* data-section header (e.g. "LIVE MARKETS", "THE WIRE",
 * "ANNOUNCEMENTS"; README §Geometry & motifs + 1b/1d/8a/23a specimens).
 */
export type SectionBarVariant = "band" | "rule";

export interface SectionBarProps {
  /** Letterspaced uppercase label rendered in mono (the design's black section band). */
  label: string;
  /** Optional right-aligned content (a count, a link, a toggle). */
  right?: ReactNode;
  surface?: Surface;
  /** Defaults to "band" so existing callers render unchanged. */
  variant?: SectionBarVariant;
  className?: string;
}

/**
 * Section header (server component). Two treatments per the design:
 *
 * - `variant="band"` (default): a `#14120e` band carrying a mono letterspaced
 *   uppercase label (README §Geometry & motifs). On a light surface the band
 *   is ink with paper text; on a dark surface it inverts to a panel tint so
 *   it reads as a divider, not a hole.
 * - `variant="rule"`: a Libre-Franklin uppercase label sitting directly on
 *   the surface, over a 2px solid ink bottom rule — no fill. This is the
 *   design's more common data-section header (front page "Live markets" /
 *   "The wire", newswire rail sections, calendar side-rail sections, etc).
 *
 * One primitive so every surface's section headers are identical.
 */
export function SectionBar({
  label,
  right,
  surface = "light",
  variant = "band",
  className = "",
}: SectionBarProps) {
  const dark = surface === "dark";

  if (variant === "rule") {
    const ruleColor = dark ? "border-dark-text" : "border-ink";
    const textColor = dark ? "text-dark-text" : "text-ink";
    return (
      <div
        className={`flex items-baseline justify-between gap-3 border-b-2 pb-2 ${ruleColor} ${className}`}
      >
        <span
          className={`font-sans text-[11px] font-bold tracking-[0.18em] uppercase ${textColor}`}
        >
          {label}
        </span>
        {right != null && <span className="flex items-center gap-2">{right}</span>}
      </div>
    );
  }

  const shell = dark
    ? "bg-dark-panel-alt text-dark-text-mid border-b border-dark-hairline"
    : "bg-ink text-paper-tint";
  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-[7px] ${shell} ${className}`}
    >
      <span className="font-mono text-[10px] font-semibold tracking-[0.1em] uppercase">
        {label}
      </span>
      {right != null && (
        <span className="flex items-center gap-2 font-mono text-[9px] text-dark-text-faint">
          {right}
        </span>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import type { Surface } from "./types";

export interface SectionBarProps {
  /** Letterspaced uppercase label rendered in mono (the design's black section band). */
  label: string;
  /** Optional right-aligned content (a count, a link, a toggle). */
  right?: ReactNode;
  surface?: Surface;
  className?: string;
}

/**
 * Black section bar (server component). The design heads every table/section with
 * a `#14120e` band carrying a mono letterspaced uppercase label (README §Geometry
 * & motifs). One primitive so every surface's section headers are identical.
 *
 * On a light surface the band is ink with paper text; on a dark surface it inverts
 * to a panel tint so it reads as a divider, not a hole.
 */
export function SectionBar({ label, right, surface = "light", className = "" }: SectionBarProps) {
  const dark = surface === "dark";
  const shell = dark
    ? "bg-dark-panel-alt text-dark-text-mid border-b border-dark-hairline"
    : "bg-ink text-paper-tint";
  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-[7px] ${shell} ${className}`}
    >
      <span className="font-mono text-[9px] font-semibold tracking-[0.16em] uppercase">
        {label}
      </span>
      {right != null && (
        <span className="flex items-center gap-2 font-mono text-[9px] tracking-[0.08em]">
          {right}
        </span>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import { DeskClock } from "./DeskClock";

export interface DeskTopBarProps {
  /** Breadcrumb segments, e.g. ["DESK", "DASHBOARD"] or ["DESK", "DATA DESK", "FEEDS & MARKETS"]. */
  crumbs: string[];
  /** Optional right-aligned chip before the clock (e.g. a live status pill). */
  right?: ReactNode;
}

/**
 * The 42px dark top bar above the paper canvas (05-desk-admin.md §1 / the
 * AdminRail.dc.html handoff). Static server component — part of each page's
 * sync shell, not the Suspense-wrapped body, since the breadcrumb is known
 * at render time and the only live bit (the clock) is its own client leaf.
 */
export function DeskTopBar({ crumbs, right }: DeskTopBarProps) {
  const last = crumbs[crumbs.length - 1];
  const lead = crumbs.slice(0, -1);
  return (
    <div className="flex h-[42px] flex-none items-center gap-3.5 bg-dark-bg px-[22px]">
      <span className="font-mono text-[9px] tracking-[0.14em] text-dark-text-faint">
        {lead.length > 0 ? `${lead.join(" / ")} / ` : ""}
        <span className="text-dark-text">{last}</span>
      </span>
      <span className="ml-auto flex items-center gap-3">
        {right}
        <DeskClock />
      </span>
    </div>
  );
}

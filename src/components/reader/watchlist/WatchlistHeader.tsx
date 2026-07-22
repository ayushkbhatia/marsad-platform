import Link from "next/link";
import type { WatchList } from "@/lib/data/sample/watchlist";

/**
 * Watchlist (1h) header — the serif "Watchlists" title, the list-switcher
 * pills (selected list is a solid-ink block, others outlined; "+ New list"
 * is a plain affordance), and the right-side Columns / Manage-alerts controls.
 *
 * Sample-driven for the fidelity pass; list switching + the columns picker
 * re-wire onto real per-user lists later (DEF-WATCHLIST-LIVE-DATA).
 */
export function WatchlistHeader({ lists, alertCount }: { lists: WatchList[]; alertCount: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3.5">
      <span className="font-display text-[27px] font-bold text-ink">Watchlists</span>

      <div className="ml-2.5 flex flex-wrap gap-1.5">
        {lists.map((l) =>
          l.selected ? (
            <span
              key={l.name}
              className="cursor-pointer bg-ink px-[13px] py-1.5 text-[11.5px] font-bold text-paper-tint"
            >
              {l.name} · {l.count}
            </span>
          ) : (
            <span
              key={l.name}
              className="cursor-pointer border border-hairline-strong px-[13px] py-1.5 text-[11.5px] text-ink-muted"
            >
              {l.name} · {l.count}
            </span>
          ),
        )}
        <span className="cursor-pointer px-1 py-1.5 text-[11.5px] text-ink-faint">+ New list</span>
      </div>

      <div className="ml-auto flex gap-2">
        <span className="cursor-pointer border border-hairline-strong px-[13px] py-[7px] text-[11px] font-semibold text-ink-muted">
          Columns ▾
        </span>
        <Link
          href="/watchlist"
          className="cursor-pointer border border-ink px-[13px] py-[7px] text-[11px] font-semibold text-ink"
        >
          Manage alerts · {alertCount} →
        </Link>
      </div>
    </div>
  );
}

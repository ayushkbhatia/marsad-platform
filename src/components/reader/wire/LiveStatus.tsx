"use client";

import { FreshnessBadge } from "@/components/ui";
import { useMarketOpen } from "@/lib/hooks/usePulse";

/**
 * The wire header's "● LIVE · N TODAY" status (1d) — a straight composition
 * of the shared `FreshnessBadge` primitive rather than a bespoke dot+label:
 * `state="live"` reads positive-green exactly like the design's `#0a7a3c`
 * spec when the relevant venue is trading; when every relevant venue is
 * closed it degrades to `state="offline"` (never a fabricated "live") — the
 * "positive when a venue trades" rule from the design brief.
 */
export function LiveStatus({ todayCount, venue }: { todayCount: number; venue?: string }) {
  const open = useMarketOpen(venue ? [venue] : undefined);
  return (
    <span className="ml-auto">
      <FreshnessBadge
        state={open ? "live" : "offline"}
        detail={`${todayCount.toLocaleString("en-US")} TODAY`}
      />
    </span>
  );
}

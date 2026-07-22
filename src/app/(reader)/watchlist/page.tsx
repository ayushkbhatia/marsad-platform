import type { Metadata } from "next";
import { SAMPLE_WATCHLIST } from "@/lib/data/sample/watchlist";
import { WatchlistHeader } from "@/components/reader/watchlist/WatchlistHeader";
import { WatchlistStatStrip } from "@/components/reader/watchlist/WatchlistStatStrip";
import { WatchlistTable } from "@/components/reader/watchlist/WatchlistTable";
import { WatchlistFooter } from "@/components/reader/watchlist/WatchlistFooter";

/**
 * Watchlist — design screen 1h. A single-column page: the list-switcher
 * header, a stat strip, a venue-grouped holdings table (ticker / company /
 * price / 1D+1W / Marsad Score tier / PT upside / next event / alert), then a
 * two-column Active-alerts + My-notes footer.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/watchlist.ts`), the
 * same seam pattern as 1b/1d. Watchlist is a MEMBER surface in the real
 * product (per-user lists, alerts, notes) — there is no `(auth)` group yet, so
 * this ships a shared sample list for the fidelity pass and stays ungated for
 * now; per-user data + auth gating re-wire by mapping onto this module's
 * view-model types and swapping `SAMPLE_WATCHLIST` (DEF-WATCHLIST-LIVE-DATA).
 * Fully static, so the route prerenders with the shell.
 */
export const metadata: Metadata = {
  title: "Watchlist",
  description: "Track GCC holdings — prices, Marsad Scores, alerts and notes across six venues.",
};

export default function WatchlistPage() {
  const d = SAMPLE_WATCHLIST;

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <WatchlistHeader lists={d.lists} alertCount={d.alertCount} />
        <WatchlistStatStrip
          stats={d.stats}
          best={d.best}
          worst={d.worst}
          alertsTriggered={d.alertsTriggered}
        />
        <WatchlistTable groups={d.groups} />
        <WatchlistFooter alerts={d.alerts} notes={d.notes} />
      </div>
    </div>
  );
}

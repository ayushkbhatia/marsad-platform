import type { Metadata } from "next";
import Link from "next/link";
import { getPresetScreenSummaries, screenerHref } from "@/lib/data/dataroom";
import { ScreenerGrid } from "@/components/reader/ScreenerGrid";
import {
  DataRoomChrome,
  ChromeButton,
  ChromeAction,
  ChromeMeta,
} from "@/components/reader/dataroom/DataRoomChrome";

/**
 * Screener — design 1f (dark data room).
 *
 * DESIGN PASS (1f): the page wears the shared data-room chrome (mode chip +
 * universe count + EXPORT CSV + SAVE AS ALERT) over the saved-screens strip
 * (MY SCREENER / EXPLORE toggle + screen pills), with the filter rail +
 * results grid below. `MarsadNav` is gone from this surface by design (mode
 * switch, not page nav — see `(dataroom)/layout.tsx`).
 *
 * DATA IS UNCHANGED AND REAL: the strip's pills are the curated `PRESET_SCREENS`
 * with LIVE match counts over the cached universe (`getPresetScreenSummaries`),
 * and the grid itself remains the client island calling `/api/screener/run`
 * over the constrained PUBLIC field allowlist (venue, sector, price, change%,
 * headline Score/rating) — premium ratio columns stay locked stubs, never
 * fetched. `noindex` per §8 (SEO backbone is stock pages / filings).
 */

export const metadata: Metadata = {
  title: "Screener",
  description: "Filter and sort GCC equities by venue, sector, price, change and the Marsad Score.",
  robots: { index: false, follow: false },
};

export default async function ScreenerPage() {
  const { summaries, universe } = await getPresetScreenSummaries();

  return (
    <div className="min-h-[70vh] bg-dark-bg text-dark-text">
      <DataRoomChrome
        mode="SCREENER"
        right={
          <>
            <ChromeMeta>UNIVERSE: {universe.toLocaleString("en-US")} GCC LISTINGS</ChromeMeta>
            <ChromeButton>EXPORT CSV</ChromeButton>
            <ChromeAction>SAVE AS ALERT</ChromeAction>
          </>
        }
      />

      {/* Saved-screens strip (design 1f) — real presets with live match counts. */}
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3.5">
        <span className="mr-2 flex border border-dark-hairline-soft">
          <span className="bg-dark-text px-[11px] py-[5px] font-ui text-[10px] font-bold text-dark-bg">
            MY SCREENER
          </span>
          <Link
            href="/screens"
            className="px-[11px] py-[5px] font-ui text-[10px] font-semibold text-dark-text-faint hover:text-dark-text"
          >
            EXPLORE ↗
          </Link>
        </span>
        <span className="mr-1 font-mono text-[9px] tracking-[0.14em] text-dark-text-faint">
          SAVED SCREENS
        </span>
        {summaries.map(({ screen, count }) => (
          <Link
            key={screen.id}
            href={screenerHref(screen.criteria)}
            title={`${screen.description} · ${count.toLocaleString("en-US")} match`}
            className="border border-dark-hairline-soft px-3 py-1.5 font-ui text-[11px] text-dark-text-faint hover:border-dark-hairline-strong hover:text-dark-text"
          >
            {screen.name}
            <span className="ml-1.5 font-mono text-[9px] text-dark-text-faint">{count}</span>
          </Link>
        ))}
        <Link
          href="/screens"
          className="px-1 py-1.5 font-ui text-[11px] text-dark-text-faint hover:text-dark-text"
        >
          + New screen
        </Link>
      </div>

      <ScreenerGrid />
    </div>
  );
}

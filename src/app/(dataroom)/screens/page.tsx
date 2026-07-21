import type { Metadata } from "next";
import Link from "next/link";
import { getPresetScreenSummaries } from "@/lib/data/dataroom";
import { PresetScreenCard } from "@/components/reader/dataroom/PresetScreenCard";

/**
 * Explore gallery (9a) — dark data-room. `public.screen_catalog` has no
 * producer yet (BUILD-STATUS §7), so this renders a curated STATIC set of
 * preset screens (`PRESET_SCREENS` in `lib/data/dataroom.ts`), each with a
 * live match count over the real (cached) screener universe. The 9a mockup's
 * personalized rails — "My screens", "Community", search, "Trending",
 * "Your library", forks/follows — all need data that doesn't exist (saved
 * screens, social graph, run analytics) and are deliberately left out rather
 * than faked. `noindex`.
 */

export const metadata: Metadata = {
  title: "Explore Screens",
  description: "Curated preset screens over the GCC equity universe — Score leaders, momentum, ratings and venue boards.",
  robots: { index: false, follow: false },
};

export default async function ScreensPage() {
  const { summaries, universe } = await getPresetScreenSummaries();

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="border-b-2 border-dark-text pb-4">
        <div className="flex items-baseline gap-3">
          <span className="flex border border-dark-hairline-strong">
            <Link
              href="/screener"
              className="px-4 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-dark-text-mid no-underline hover:text-dark-text"
            >
              MY SCREENER
            </Link>
            <span className="bg-dark-text px-4 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-dark-bg">
              EXPLORE
            </span>
          </span>
        </div>
        <h1 className="mt-4 font-display text-[30px] font-bold tracking-[-0.015em] text-dark-text">
          Find ideas across the GCC universe
        </h1>
        <p className="mt-1.5 font-ui text-[13px] text-dark-text-mid">
          Curated by the desk, run over the live public screener. Preview any screen, then open it in the
          Screener to filter, sort and export.
        </p>
      </header>

      <div className="mt-6 mb-3 font-mono text-[10px] font-bold tracking-[0.18em] text-dark-text-faint uppercase">
        Curated screens
      </div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {summaries.map(({ screen, count }) => (
          <PresetScreenCard key={screen.id} screen={screen} count={count} />
        ))}
      </div>
      <p className="mt-6 font-mono text-[9px] leading-[1.6] text-dark-text-faint">
        {universe.toLocaleString("en-US")} names in the public universe · delayed data, information only.
      </p>
    </div>
  );
}

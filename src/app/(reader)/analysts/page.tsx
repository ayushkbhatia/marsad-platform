import type { Metadata } from "next";
import { COVERAGE_DESK } from "@/lib/data/sample/analysts";
import { CoverageDesk } from "@/components/reader/analysts/CoverageDesk";

/**
 * The Coverage Desk — design screen 1i. The analyst leaderboard master page:
 * a ranked leaderboard, a "Latest from the desk" research strip, and a sidebar
 * (ratings changes, coverage by sector, request-coverage vote). Every
 * leaderboard row links to `/analysts/{slug}` — the 1j profile template.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/analysts.ts`), same
 * seam pattern as the other 1x screens. The real desk (`public.analysts`,
 * `analyst_calls`, section coverage) re-wires by mapping onto that module's
 * view-model types and swapping `COVERAGE_DESK` (DEF-ANALYSTS-LIVE-DATA);
 * `editorial.ts` + `AnalystLeaderboard` are the adapter basis. Fully static,
 * so the route prerenders.
 */
export const metadata: Metadata = {
  title: "The Coverage Desk",
  description: "Marsad's analyst leaderboard — every GCC call tracked, scored against the venue index, and public.",
};

export default function AnalystsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <CoverageDesk data={COVERAGE_DESK} />
      </div>
    </div>
  );
}

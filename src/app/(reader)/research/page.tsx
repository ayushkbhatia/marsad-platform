import type { Metadata } from "next";
import { RESEARCH_INDEX } from "@/lib/data/sample/research";
import { ResearchIndex } from "@/components/reader/research/ResearchIndex";

/**
 * Research index — design screen 1l. The research master page: topic filter +
 * venue/sort, a featured card, a 3-column article grid, and a Columns & series
 * email-digest footer. Every card links to `/articles/{slug}` — the 1k
 * article template.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/research.ts`), same
 * seam pattern as the other 1x screens. The real index (ARTICLE-type
 * `content_items`, section facets, the premium tag) re-wires by mapping onto
 * that module's view-model types and swapping `RESEARCH_INDEX`
 * (DEF-RESEARCH-LIVE-DATA); the existing `editorial.ts` + shared editorial
 * components are the adapter basis. Fully static, so the route prerenders.
 */
export const metadata: Metadata = {
  title: "Research",
  description: "Independent, timestamped equity research on GCC-listed names — banks, energy, real estate and more.",
};

export default function ResearchIndexPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <ResearchIndex data={RESEARCH_INDEX} />
      </div>
    </div>
  );
}

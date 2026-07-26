import { Suspense } from "react";
import type { Metadata } from "next";
import { buildResearchIndex } from "@/lib/data/adapters/research";
import { ResearchIndex } from "@/components/reader/research/ResearchIndex";
import { EmptyState } from "@/components/ui";

/**
 * Research index — design screen 1l, on REAL `content_items`.
 *
 * Un-orphans `listResearchArticles` / `getArticleSectionFacets`, both written in
 * wave-2 and then stranded when the design pass swapped this page onto a sample
 * module (DEF-RESEARCH-LIVE-DATA).
 *
 * When nothing is published the page renders an honest empty state rather than
 * a sample index. That matters here more than usual: every card links to a real
 * `/articles/[slug]`, so a fabricated card is a link to a 404.
 */
const TITLE = "Research";
const DESCRIPTION =
  "Desk research on the six GCC exchanges — filings-grounded analysis of Gulf listed companies.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function ResearchIndexPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <Suspense fallback={<IndexFallback />}>
          <ResearchBody />
        </Suspense>
      </div>
    </div>
  );
}

function IndexFallback() {
  return (
    <div aria-hidden>
      <div className="h-8 w-64 animate-pulse bg-hairline" />
      <div className="mt-5 h-[300px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function ResearchBody() {
  const data = await buildResearchIndex();

  if (!data) {
    return (
      <EmptyState
        variant="awaitingFeed"
        title="No research published yet"
        body="Desk pieces appear here as they are published. Nothing is listed on this page that you cannot open and read."
      />
    );
  }

  return <ResearchIndex data={data} />;
}

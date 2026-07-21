import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { listResearchArticles, getArticleSectionFacets } from "@/lib/data/editorial";
import { EmptyState } from "@/components/ui";
import { ArticleCard } from "@/components/reader/editorial/ArticleCard";
import { fmtDate } from "@/lib/reader/format";

/**
 * Research index (1l) — ARTICLE-type `content_items`, newest first, with a
 * `?section=` facet. RLS restricts every read to published rows
 * (`live`/`updated`/`retracted`); `content_items` has 3 rows today, all
 * `draft`/`approval`, so this page is a genuine `EmptyState awaitingFeed`
 * until the first piece goes live — the query/grouping below is real and
 * lights up unmodified the moment that happens.
 */

export const metadata: Metadata = {
  title: "Research",
  description: "Independent, timestamped equity research on GCC-listed names — banks, energy, real estate and more.",
};

type Search = { section?: string };

export default function ResearchIndexPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-4 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">Research</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">
          Independent, timestamped calls on GCC-listed names — every piece stays public and permanent.
        </p>
      </header>

      <Suspense fallback={<ResearchFallback />}>
        <ResearchBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function ResearchFallback() {
  return (
    <div className="mt-5 space-y-4">
      <div className="h-8 w-full animate-pulse bg-hairline-soft" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse bg-hairline-soft" />
        ))}
      </div>
    </div>
  );
}

function sectionHref(section: string | undefined): string {
  return section ? `/research?section=${encodeURIComponent(section)}` : "/research";
}

async function ResearchBody({ searchParams }: { searchParams: Promise<Search> }) {
  const { section } = await searchParams;
  const activeSection = (section ?? "").trim();

  const [articles, facets] = await Promise.all([
    listResearchArticles({ section: activeSection || undefined, limit: 25 }),
    getArticleSectionFacets(),
  ]);

  const [featured, ...rest] = articles;

  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={sectionHref(undefined)}
          className={`px-3 py-[6px] font-ui text-[11px] font-semibold transition-colors ${
            !activeSection ? "bg-ink text-paper-tint" : "border border-hairline-strong text-ink-muted hover:text-ink"
          }`}
        >
          All
        </Link>
        {facets.map((f) => (
          <Link
            key={f.section}
            href={sectionHref(f.section)}
            className={`px-3 py-[6px] font-ui text-[11px] font-semibold transition-colors ${
              activeSection === f.section
                ? "bg-ink text-paper-tint"
                : "border border-hairline-strong text-ink-muted hover:text-ink"
            }`}
          >
            {f.section}
          </Link>
        ))}
      </div>

      {articles.length === 0 ? (
        <EmptyState
          variant="awaitingFeed"
          title="No research published yet"
          body="The newsroom pipeline is live — three pieces are in draft/approval today. This index is wired to public.content_items (ARTICLE type, published statuses) and will populate the moment the first piece goes live."
        />
      ) : (
        <>
          {featured ? (
            <Link
              href={`/articles/${featured.slug}`}
              className="grid grid-cols-1 border border-ink hover:bg-paper-tint sm:grid-cols-[1fr_1.4fr]"
            >
              <div className="flex min-h-[220px] items-center justify-center border-b border-hairline sm:border-r sm:border-b-0">
                <span className="font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase">
                  {featured.section ?? "Featured"}
                </span>
              </div>
              <div className="flex flex-col gap-3 bg-paper-tint px-7 py-6">
                <div className="flex items-center gap-2.5">
                  <span className="font-ui text-[10px] font-bold tracking-[0.2em] text-ink uppercase">
                    Featured{featured.section ? ` · ${featured.section}` : ""}
                  </span>
                  {featured.isPremium ? (
                    <span className="bg-ink px-[5px] py-[2px] font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
                      Premium
                    </span>
                  ) : null}
                </div>
                <span className="text-balance font-display text-[28px] font-bold leading-[1.15] tracking-[-0.012em] text-ink">
                  {featured.headline}
                </span>
                {featured.dek ? (
                  <span className="font-ui text-[13.5px] leading-[1.6] text-ink-muted">{featured.dek}</span>
                ) : null}
                <span className="mt-auto font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
                  {fmtDate(featured.publishedAt)}
                  {featured.readMinutes ? ` · ${featured.readMinutes} MIN` : ""}
                </span>
              </div>
            </Link>
          ) : null}

          {rest.length > 0 ? (
            <div className="grid grid-cols-1 border-t border-l border-hairline sm:grid-cols-3">
              {rest.map((a) => (
                <ArticleCard key={a.id} article={a} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

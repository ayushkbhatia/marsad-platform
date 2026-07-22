import type { Metadata } from "next";
import { SAMPLE_ARTICLE, RESEARCH_INDEX } from "@/lib/data/sample/research";
import { ArticleView } from "@/components/reader/research/ArticleView";

/**
 * Article (1k) — the one reusable longform research template every research
 * card routes to. Design 1k: a 5-column article grid (copy column + sidebar)
 * over a full-width premium paywall band, with a drop-cap open, pull-quote,
 * labelled exhibit, and a fade-masked free-preview cutoff.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/research.ts`). For the
 * fidelity pass EVERY slug renders the single fully-resolved `SAMPLE_ARTICLE`
 * (the banks NIM piece) — the one piece the design bakes end-to-end — since 1k
 * is a layout, not a one-off. Real per-slug content, the RLS-gated premium
 * cut, `NewsArticle` JSON-LD and `notFound()` on a bad slug all re-wire by
 * mapping the real read onto the `Article` view-model and swapping the sample
 * (DEF-RESEARCH-LIVE-DATA); `editorial.ts` + the shared editorial components
 * are the adapter basis. Fully static — the known research slugs prerender via
 * `generateStaticParams`; any other slug renders the template on demand.
 */
export function generateStaticParams(): Array<{ slug: string }> {
  const slugs = new Set<string>([SAMPLE_ARTICLE.slug, RESEARCH_INDEX.featured.slug]);
  for (const c of RESEARCH_INDEX.cards) slugs.add(c.slug);
  for (const r of SAMPLE_ARTICLE.related) slugs.add(r.slug);
  return [...slugs].map((slug) => ({ slug }));
}

export const metadata: Metadata = {
  title: SAMPLE_ARTICLE.headline,
  description: SAMPLE_ARTICLE.dek,
};

export default function ArticlePage() {
  return (
    <div className="bg-paper">
      <ArticleView article={SAMPLE_ARTICLE} />
    </div>
  );
}

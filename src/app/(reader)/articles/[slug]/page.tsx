import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildArticle } from "@/lib/data/adapters/research";
import { getArticleBySlug, listPublishedArticleSlugs } from "@/lib/data/editorial";
import { ArticleView } from "@/components/reader/research/ArticleView";
import { JsonLd } from "@/components/reader/JsonLd";
import { siteUrl } from "@/lib/reader/format";

/**
 * Article (1k) — the reusable longform template, now on REAL `content_items`.
 *
 * WHAT THE DESIGN PASS BROKE AND THIS RESTORES. The pixel pass made every slug
 * render one baked sample piece, with `params` never read: that meant a static
 * `metadata` describing the wrong article on every URL, `generateStaticParams`
 * prerendering fabricated slugs, no `notFound()`, and no JSON-LD. Shipping that
 * against real data would emit wrong canonicals and duplicate content across
 * every article URL — the "template collapse" risk in `BRIDGE-BUILD-PLAN.md` §6.
 * Per-slug metadata, `NewsArticle` JSON-LD and `notFound()` are all back.
 *
 * THE PREMIUM CUT IS NOW REAL. Previously the paywall was a CSS mask with the
 * full text still in the HTML source — not a paywall. `content_blocks` RLS
 * returns only ungated blocks to an anon reader, so gated prose is physically
 * absent from the response.
 */
type Params = { slug: string };

export async function generateStaticParams(): Promise<Params[]> {
  const slugs = await listPublishedArticleSlugs(200);
  return slugs.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const a = await getArticleBySlug(slug);
  if (!a) return { title: "Article not found" };

  const description = a.dek ?? "";
  const canonical = `${siteUrl()}/articles/${a.slug}`;
  return {
    title: a.headline,
    description,
    alternates: { canonical },
    openGraph: {
      title: a.headline,
      description,
      type: "article",
      publishedTime: a.publishedAt ?? undefined,
      modifiedTime: a.updatedAt ?? undefined,
    },
    twitter: { card: "summary_large_image", title: a.headline, description },
  };
}

export default async function ArticlePage({ params }: { params: Promise<Params> }) {
  // Resolve before anything streams so an unknown slug can answer with a real
  // status rather than 200-with-a-404-body (see DEF-NOTFOUND-STATUS).
  const { slug } = await params;
  const detail = await getArticleBySlug(slug);
  if (!detail) notFound();

  const article = await buildArticle(slug);
  if (!article) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: detail.headline,
    description: detail.dek ?? undefined,
    datePublished: detail.publishedAt ?? undefined,
    dateModified: detail.updatedAt ?? undefined,
    author: { "@type": "Organization", name: article.authorName },
    publisher: { "@type": "Organization", name: "Marsad" },
    mainEntityOfPage: `${siteUrl()}/articles/${detail.slug}`,
    // Honest signal to crawlers when the body is genuinely truncated for anon.
    isAccessibleForFree: !detail.hasGatedRemainder,
  };

  return (
    <div className="bg-paper">
      <JsonLd data={jsonLd} />
      <ArticleView article={article} />
    </div>
  );
}

import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticleBySlug, getRelatedArticles, type ArticleDetail } from "@/lib/data/editorial";
import { RatingBadge } from "@/components/ui";
import { PremiumLock } from "@/components/reader/PremiumLock";
import { JsonLd } from "@/components/reader/JsonLd";
import { ArticleBlocks } from "@/components/reader/editorial/ArticleBlocks";
import { TickerRail } from "@/components/reader/editorial/TickerRail";
import { RelatedArticleRow } from "@/components/reader/editorial/ArticleCard";
import { fmtDate, fmtSignedPct, toRating, siteUrl } from "@/lib/reader/format";

/**
 * Article (1k) — server-side premium cut. No `fn_article_render` RPC exists
 * (confirmed via read-only SQL); the free/gated split is enforced by RLS on
 * `content_blocks` itself, so `getArticleBySlug` only ever receives the
 * free portion for an anon reader — see `src/lib/data/editorial.ts` header
 * for the full trail (RLS policy text, the byline-identity gap, the missing
 * metering RPC). No `generateStaticParams`: content is sparse and published
 * continuously, so params are runtime and the body is Suspense-wrapped
 * (cacheComponents rule) — same shape as `filings/[filingId]`.
 *
 * An unresolved slug is a genuine `notFound()` here (unlike `ipo/[offerSlug]`
 * or the analyst profile): `content_items` already has real rows and a real
 * publish lifecycle — a bad slug means a bad URL, not an unlaunched tier.
 */

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return { title: "Not found" };
  return {
    title: article.headline,
    description: article.dek ?? undefined,
  };
}

export default function ArticlePage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-12 sm:px-8">
      <Suspense fallback={<ArticleFallback />}>
        <ArticleBody params={params} />
      </Suspense>
    </div>
  );
}

function ArticleFallback() {
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <div className="h-4 w-24 animate-pulse bg-hairline-soft" />
        <div className="h-10 w-full animate-pulse bg-hairline" />
        <div className="h-6 w-2/3 animate-pulse bg-hairline-soft" />
        <div className="h-64 w-full animate-pulse bg-hairline-soft" />
      </div>
      <div className="h-40 animate-pulse bg-hairline-soft" />
    </div>
  );
}

function bylineText(article: ArticleDetail): string {
  if (article.byline.length === 0) return "Marsad Newsroom";
  return article.byline
    .map((b) => {
      const role = b.role ? b.role.replace(/_/g, " ") : null;
      const who = b.principal ?? "—";
      return role ? `${role} · ${who}` : who;
    })
    .join(" · ");
}

async function ArticleBody({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) notFound();

  const related = await getRelatedArticles(article.id, 3);
  const rating = article.rating;
  const ratingLabel = toRating(rating?.rating);

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.headline.slice(0, 110),
    url: `${siteUrl()}/articles/${article.slug}`,
    inLanguage: "en",
    ...(article.dek ? { description: article.dek } : {}),
    ...(article.publishedAt ? { datePublished: article.publishedAt } : {}),
    ...(article.updatedAt ? { dateModified: article.updatedAt } : {}),
    publisher: { "@type": "Organization", name: "Marsad" },
    isAccessibleForFree: !article.isPremium,
    ...(article.isPremium
      ? {
          hasPart: {
            "@type": "WebPageElement",
            isAccessibleForFree: false,
            cssSelector: ".paywalled",
          },
        }
      : {}),
  };

  return (
    <article className="grid gap-10 lg:grid-cols-[1fr_300px]">
      <JsonLd data={jsonLd} />

      <div className="min-w-0 max-w-[720px]">
        <div className="flex flex-wrap items-center gap-2.5">
          {article.section ? (
            <span className="font-ui text-[11px] font-bold tracking-[0.2em] text-ink uppercase">
              {article.section}
            </span>
          ) : null}
          {article.isPremium ? (
            <span className="bg-ink px-[6px] py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
              Premium research
            </span>
          ) : null}
          {article.status === "retracted" ? (
            <span className="border border-negative px-[6px] py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-negative uppercase">
              Retracted
            </span>
          ) : null}
        </div>

        <h1 className="mt-3 text-balance font-display text-heading-lg font-bold leading-[1.12] text-ink">
          {article.headline}
        </h1>

        {article.dek ? (
          <p className="mt-3 font-display text-[18px] leading-[1.5] text-ink-muted">{article.dek}</p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink border-b border-hairline-strong py-3.5">
          <div>
            <div className="font-ui text-[12.5px] font-semibold text-ink">{bylineText(article)}</div>
            <div className="mt-0.5 font-mono text-[9px] text-ink-faint">
              {fmtDate(article.publishedAt)}
              {article.readMinutes ? ` · ${article.readMinutes} MIN READ` : ""}
              {rating ? " · RATING ATTACHED" : ""}
            </div>
          </div>
        </div>

        {article.retractionNotice ? (
          <div className="mt-4 border-l-2 border-negative bg-paper-tint px-4 py-3">
            <span className="font-mono text-[9px] tracking-[0.14em] text-negative uppercase">Retraction notice</span>
            <p className="mt-1 font-ui text-[12.5px] leading-[1.6] text-ink-mid">{article.retractionNotice}</p>
          </div>
        ) : null}

        {rating ? (
          <div className="mt-5 flex flex-wrap items-center gap-3.5 border border-hairline-strong px-4 py-3">
            <span className="flex-none font-mono text-[8.5px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
              Rating attached
            </span>
            {rating.ticker ? (
              <Link
                href={`/stocks/${rating.venueCode}/${rating.ticker}`}
                className="font-mono text-[11px] font-semibold text-ink hover:underline underline-offset-2"
              >
                {rating.ticker}
              </Link>
            ) : null}
            {rating.name ? <span className="font-ui text-[12.5px] text-ink-mid">{rating.name}</span> : null}
            {ratingLabel ? <RatingBadge rating={ratingLabel} /> : null}
            {rating.priceTarget != null ? (
              <span className="font-ui text-[12px] font-semibold tabular-nums text-ink">
                PT {rating.priceTarget.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </span>
            ) : null}
            {rating.impliedUpsidePct != null ? (
              <span
                className={`ml-auto font-ui text-[11.5px] font-semibold tabular-nums ${
                  rating.impliedUpsidePct >= 0 ? "text-positive" : "text-negative"
                }`}
              >
                {fmtSignedPct(rating.impliedUpsidePct)} implied
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-7">
          <ArticleBlocks blocks={article.blocks} />
        </div>

        {article.hasGatedRemainder ? (
          <div className="paywalled mt-7">
            <PremiumLock
              variant="panel"
              title="Continue reading"
              teaser={
                article.remainingWordsEstimate && article.remainingWordsEstimate > 0
                  ? `~${article.remainingWordsEstimate.toLocaleString("en-US")} more words in this piece — Premium members read the full analysis and rating detail.`
                  : "The rest of this piece is for Premium members."
              }
            />
          </div>
        ) : null}
      </div>

      <aside className="flex flex-col gap-5">
        <TickerRail tickers={article.tickers} />

        {related.length > 0 ? (
          <div>
            <div className="border-b-2 border-ink pb-1.5">
              <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">Related</span>
            </div>
            {related.map((a) => (
              <RelatedArticleRow key={a.id} article={a} />
            ))}
          </div>
        ) : null}
      </aside>
    </article>
  );
}

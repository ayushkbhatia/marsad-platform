import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getNewsroomItemBySlugOrId,
  getRecentWiresExcluding,
  newsroomItemHref,
} from "@/lib/data/newsroom";
import { JsonLd } from "@/components/reader/JsonLd";
import { TickerRail } from "@/components/reader/editorial/TickerRail";
import { WireCitedBody } from "@/components/reader/newsroom/WireCitedBody";
import { fmtDateTime, siteUrl } from "@/lib/reader/format";

/**
 * Newsroom wire permalink (`/wire/[slug]`) — the autonomous newsroom's own
 * published WIRE, full render: headline, dek, cited body, ticker chips,
 * publish timestamp, "Marsad Newsroom" byline. WIRE (TPL-01) is always short
 * and never premium (`ops.templates.always_premium=false`, ≤40w to
 * auto-publish) — no `PremiumLock` here, unlike `/articles/[slug]`, which
 * stays the ARTICLE permalink and keeps the premium cut (that file's data
 * layer, `editorial.ts`, is untouched by this route).
 *
 * `getNewsroomItemBySlugOrId` resolves either the real slug (once
 * `20260722150000_newsroom_wire_slug_and_citations_read.sql` lands) or the
 * raw `content_items.id` — so this permalink already works today for item #7
 * at `/wire/b2459c8e-c28f-4d5b-a37f-df82022904e5`, and will resolve at the
 * clean slug URL the moment the lead applies the migration, with no code
 * change on this end.
 *
 * cacheComponents shape mirrors `articles/[slug]/page.tsx` exactly: static
 * shell, `<Suspense>`-wrapped async body, no `generateStaticParams` (content
 * is sparse + published continuously).
 */

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const item = await getNewsroomItemBySlugOrId(slug, { contentTypes: ["WIRE"] });
  if (!item) return { title: "Not found" };
  return {
    title: item.headline,
    description: item.dek ?? undefined,
  };
}

export default function WirePermalinkPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-12 sm:px-8">
      <Suspense fallback={<WirePermalinkFallback />}>
        <WirePermalinkBody params={params} />
      </Suspense>
    </div>
  );
}

function WirePermalinkFallback() {
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <div className="h-4 w-24 animate-pulse bg-hairline-soft" />
        <div className="h-10 w-full animate-pulse bg-hairline" />
        <div className="h-6 w-2/3 animate-pulse bg-hairline-soft" />
        <div className="h-32 w-full animate-pulse bg-hairline-soft" />
      </div>
      <div className="h-40 animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function WirePermalinkBody({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const item = await getNewsroomItemBySlugOrId(slug, { contentTypes: ["WIRE"] });
  if (!item) notFound();

  const related = await getRecentWiresExcluding(item.id, 4);

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: item.headline.slice(0, 110),
    url: `${siteUrl()}${newsroomItemHref(item)}`,
    inLanguage: "en",
    ...(item.dek ? { description: item.dek } : {}),
    ...(item.publishedAt ? { datePublished: item.publishedAt } : {}),
    ...(item.updatedAt ? { dateModified: item.updatedAt } : {}),
    author: { "@type": "Organization", name: "Marsad Newsroom" },
    publisher: { "@type": "Organization", name: "Marsad" },
    isAccessibleForFree: true,
  };

  return (
    <article className="grid gap-10 lg:grid-cols-[1fr_300px]">
      <JsonLd data={jsonLd} />

      <div className="min-w-0 max-w-[720px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="bg-ink px-[6px] py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
            Newsroom wire
          </span>
          {item.status === "retracted" ? (
            <span className="border border-negative px-[6px] py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-negative uppercase">
              Retracted
            </span>
          ) : null}
        </div>

        <h1 className="mt-3 text-balance font-display text-heading-lg font-bold leading-[1.12] text-ink">
          {item.headline}
        </h1>

        {item.dek ? (
          <p className="mt-3 font-display text-[18px] leading-[1.5] text-ink-muted">{item.dek}</p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink border-b border-hairline-strong py-3.5">
          <div>
            <div className="font-ui text-[12.5px] font-semibold text-ink">{item.bylineLabel}</div>
            <div className="mt-0.5 font-mono text-[9px] text-ink-faint">{fmtDateTime(item.publishedAt)}</div>
          </div>
        </div>

        {item.retractionNotice ? (
          <div className="mt-4 border-l-2 border-negative bg-paper-tint px-4 py-3">
            <span className="font-mono text-[9px] tracking-[0.14em] text-negative uppercase">Retraction notice</span>
            <p className="mt-1 font-ui text-[12.5px] leading-[1.6] text-ink-mid">{item.retractionNotice}</p>
          </div>
        ) : null}

        <div className="mt-7">
          <WireCitedBody
            blocks={item.blocks}
            citations={item.citations}
            proseClassName="font-display text-[17px] leading-[1.72] text-ink-soft"
          />
        </div>
      </div>

      <aside className="flex flex-col gap-5">
        <TickerRail tickers={item.tickers} />

        {related.length > 0 ? (
          <div>
            <div className="border-b-2 border-ink pb-1.5">
              <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
                More from the newsroom
              </span>
            </div>
            {related.map((r) => (
              <Link
                key={r.id}
                href={newsroomItemHref(r)}
                className="block border-b border-hairline-faint py-2.5 font-ui text-[13px] leading-[1.4] text-ink hover:underline underline-offset-2"
              >
                {r.headline}
              </Link>
            ))}
          </div>
        ) : null}
      </aside>
    </article>
  );
}

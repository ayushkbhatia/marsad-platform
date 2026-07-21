import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLearnDoc, getRelatedLearnDocs, listLearnDocSlugs } from "@/lib/learn/docs";
import { DraftBanner } from "@/components/reader/learn/DraftBanner";
import { LearnDocBlocks } from "@/components/reader/learn/LearnDocBlocks";
import { JsonLd } from "@/components/reader/JsonLd";
import { fmtDate, siteUrl } from "@/lib/reader/format";

/**
 * Learn doc detail (20f). Static content registry (`src/lib/learn/docs.ts`),
 * not a DB read — `generateStaticParams` enumerates the fixed 6-doc registry,
 * so every doc prerenders and an unknown slug 404s via `notFound()`.
 *
 * `terms` / `privacy` are `status: "draft-legal"` — structural skeletons the
 * build brief requires but explicitly forbids presenting as finished law. On
 * top of the in-page `DraftBanner`, this route also opts those two out of
 * indexing (`robots: { index: false }`) — a page whose own banner says "do not
 * rely on this" shouldn't rank in search as if it were Marsad's real Terms of
 * Service. This is a deliberate, easily-reversible deviation from 04 §8's
 * blanket "learn docs are indexable": flip it once the real terms/privacy
 * text ships. The other four docs (methodology, glossary, data-sources,
 * disclaimers) are final factual content and indexable as normal.
 */

type Params = { docSlug: string };

export async function generateStaticParams(): Promise<Params[]> {
  return listLearnDocSlugs().map((docSlug) => ({ docSlug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { docSlug } = await params;
  const doc = getLearnDoc(docSlug);
  if (!doc) return { title: "Not found" };

  const isDraft = doc.status === "draft-legal";
  return {
    title: doc.title,
    description: doc.dek,
    ...(isDraft ? { robots: { index: false, follow: true } } : {}),
    openGraph: { title: doc.title, description: doc.dek },
    twitter: { card: "summary", title: doc.title, description: doc.dek },
  };
}

export default async function LearnDocPage({ params }: { params: Promise<Params> }) {
  const { docSlug } = await params;
  const doc = getLearnDoc(docSlug);
  if (!doc) notFound();

  const related = getRelatedLearnDocs(doc);
  const isDraft = doc.status === "draft-legal";

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: doc.title,
    description: doc.dek,
    url: `${siteUrl()}/learn/${doc.slug}`,
    inLanguage: "en",
    dateModified: doc.updated,
    publisher: { "@type": "Organization", name: "Marsad" },
    isAccessibleForFree: true,
  };

  return (
    <div className="mx-auto max-w-[820px] px-5 py-8 sm:px-8">
      {!isDraft ? <JsonLd data={jsonLd} /> : null}

      <div className="flex items-center gap-2 font-ui text-[11px] text-ink-muted">
        <Link href="/learn" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
          Learn
        </Link>
        <span className="text-ink-faint">/</span>
        <span className="font-semibold text-ink">{doc.title}</span>
      </div>

      <header className="mt-3.5 border-b-2 border-ink pb-4">
        <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-faint uppercase">
          {doc.category}
        </span>
        <h1 className="mt-1.5 text-balance font-display text-heading-lg font-bold leading-[1.15] tracking-[-0.015em] text-ink">
          {doc.title}
        </h1>
        <p className="mt-2 font-display text-[15.5px] leading-[1.5] text-ink-muted">{doc.dek}</p>
        <p className="mt-2.5 font-mono text-[9.5px] text-ink-faint">
          {isDraft ? "DRAFT · LAST EDITED" : "LAST REVIEWED"} {fmtDate(doc.updated)}
        </p>
      </header>

      {isDraft && doc.draftNotice ? <DraftBanner notice={doc.draftNotice} /> : null}

      <div className="mt-7">
        <LearnDocBlocks blocks={doc.blocks} />
      </div>

      {related.length > 0 ? (
        <div className="mt-10 border-t border-hairline pt-5">
          <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
            See also
          </span>
          <div className="mt-2.5 flex flex-wrap gap-2.5">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/learn/${r.slug}`}
                className="border border-hairline-strong px-3.5 py-2 font-ui text-[12px] font-medium text-ink hover:border-ink hover:bg-paper-tint"
              >
                {r.title} →
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

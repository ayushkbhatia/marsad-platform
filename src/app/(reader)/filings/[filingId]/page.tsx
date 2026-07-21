import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFilingDetail } from "@/lib/data/filings";
import { JsonLd } from "@/components/reader/JsonLd";
import { pdfPublicUrl, fmtDateTime, venueName, siteUrl } from "@/lib/reader/format";

/**
 * Filing detail. No `generateStaticParams` (13.5k rows), so params are runtime →
 * the body runs inside a <Suspense> boundary (cacheComponents rule). The record
 * itself comes from the `use cache` `getFilingDetail`. Shows the full text where
 * present (~152 rows), else the source PDF link, plus any extracted facts.
 */

type Params = { filingId: string };

/** `generateMetadata` reads the same `use cache` fn the body calls — the extra
 * invocation costs nothing beyond the shared cache lookup (see CONVENTIONS §2
 * "memoizing data requests"). Machine-extracted filing text is strong
 * long-tail SEO (04-reader-app §8) so every one of the ~13.5k filings gets a
 * real title/description instead of inheriting the site default. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { filingId } = await params;
  const id = Number(filingId);
  if (!Number.isInteger(id) || id <= 0) return { title: "Not found" };
  const f = await getFilingDetail(id);
  if (!f) return { title: "Not found" };

  const title = (f.title ?? "Untitled filing").slice(0, 100);
  const description = (
    f.aiSummary ?? (f.ticker ? `${f.ticker} disclosure on ${venueName(f.venueCode)}.` : "GCC filing disclosure.")
  ).slice(0, 155);
  const ogImage = `/api/og/filing/${f.id}`;

  return {
    title,
    description,
    openGraph: { title, description, type: "article", images: [{ url: ogImage, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

export default function FilingDetailPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[820px] px-5 py-8 sm:px-8">
      <Suspense fallback={<DetailFallback />}>
        <FilingDetailBody params={params} />
      </Suspense>
    </div>
  );
}

function DetailFallback() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-24 animate-pulse bg-hairline-soft" />
      <div className="h-8 w-3/4 animate-pulse bg-hairline" />
      <div className="h-40 w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

/** Render arbitrary extracted-facts jsonb as read-only data (never as commands). */
function ExtractedFacts({ facts }: { facts: unknown }) {
  if (facts == null) return null;

  let entries: [string, unknown][] = [];
  if (Array.isArray(facts)) {
    entries = facts.map((v, i) => [String(i + 1), v]);
  } else if (typeof facts === "object") {
    entries = Object.entries(facts as Record<string, unknown>);
  } else {
    entries = [["value", facts]];
  }
  if (entries.length === 0) return null;

  const render = (v: unknown): string =>
    v == null
      ? "—"
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

  return (
    <section className="mt-8">
      <h2 className="mb-2 border-b border-hairline pb-1.5 font-display text-heading-sm font-semibold text-ink">
        Extracted facts
      </h2>
      <dl className="divide-y divide-hairline-faint border-y border-hairline-faint">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-start gap-4 py-2">
            <dt className="w-[180px] flex-none font-mono text-[10px] tracking-[0.04em] text-ink-muted uppercase">
              {k}
            </dt>
            <dd className="min-w-0 flex-1 break-words font-ui text-[12.5px] text-ink">{render(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

async function FilingDetailBody({ params }: { params: Promise<Params> }) {
  const { filingId } = await params;
  const id = Number(filingId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const f = await getFilingDetail(id);
  if (!f) notFound();

  const pdfUrl = pdfPublicUrl(f.pdfStorageKey);

  // Public filing metadata only (title / date / summary / issuer identity).
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": ["NewsArticle", "Report"],
    headline: (f.title ?? "Untitled filing").slice(0, 110),
    url: `${siteUrl()}/filings/${f.id}`,
    inLanguage: "en",
    ...(f.filedAt ? { datePublished: f.filedAt } : {}),
    ...(f.aiSummary ? { description: f.aiSummary } : {}),
    ...(f.ticker
      ? {
          about: {
            "@type": "Corporation",
            name: f.name ?? f.ticker,
            tickerSymbol: f.ticker,
            url: `${siteUrl()}/stocks/${f.venueCode}/${f.ticker}`,
          },
        }
      : {}),
    publisher: { "@type": "Organization", name: venueName(f.venueCode) },
    isAccessibleForFree: true,
  };

  return (
    <article>
      <JsonLd data={jsonLd} />
      <Link
        href="/filings"
        className="font-mono text-[10px] tracking-[0.06em] text-ink-muted hover:text-ink hover:underline underline-offset-2"
      >
        ← Filings wire
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {f.ticker ? (
          <Link
            href={`/stocks/${f.venueCode}/${f.ticker}`}
            className="font-mono text-[11px] font-semibold text-ink hover:underline underline-offset-2"
          >
            {f.ticker}
            <span className="ml-1 text-ink-faint">{venueName(f.venueCode)}</span>
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-ink-faint">{venueName(f.venueCode)}</span>
        )}
        {f.filingType ? (
          <span className="border border-ink-muted px-1.5 py-px font-mono text-[8.5px] tracking-[0.08em] text-ink-muted uppercase">
            {f.filingType}
          </span>
        ) : null}
        {f.isMarketMoving ? (
          <span className="bg-caution/15 px-1.5 py-px font-mono text-[8px] font-semibold tracking-[0.1em] text-caution-text uppercase">
            Market-moving
          </span>
        ) : null}
      </div>

      <h1 className="mt-3 font-display text-heading-lg font-bold leading-[1.15] text-ink">
        {f.title ?? "Untitled filing"}
      </h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-ink-faint">
        <span>Filed {fmtDateTime(f.filedAt)} UTC</span>
        {f.pdfPages ? <span>· {f.pdfPages} pages</span> : null}
        {f.sourceRef ? <span>· ref {f.sourceRef}</span> : null}
      </div>

      {pdfUrl ? (
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 border border-ink px-4 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
        >
          Open source PDF →
        </a>
      ) : null}

      {f.aiSummary ? (
        <section className="mt-6 border-l-2 border-ink bg-paper px-4 py-3">
          <span className="font-mono text-[9px] tracking-[0.16em] text-ink-faint uppercase">
            AI summary{f.aiSummaryModel ? ` · ${f.aiSummaryModel}` : ""}
          </span>
          <p className="mt-1.5 font-ui text-[13.5px] leading-[1.6] text-ink-mid">{f.aiSummary}</p>
        </section>
      ) : null}

      {f.fullText ? (
        <section className="mt-8">
          <h2 className="mb-2 border-b border-hairline pb-1.5 font-display text-heading-sm font-semibold text-ink">
            Full text
          </h2>
          <div className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap border border-hairline bg-paper p-4 font-ui text-[13px] leading-[1.6] text-ink-mid">
            {f.fullText}
          </div>
        </section>
      ) : (
        <p className="mt-6 border border-dashed border-hairline px-4 py-6 text-center font-ui text-[12.5px] text-ink-faint">
          No extracted full text for this filing.
          {pdfUrl ? " Use the source PDF above for the complete record." : ""}
        </p>
      )}

      <ExtractedFacts facts={f.extractedFacts} />
    </article>
  );
}

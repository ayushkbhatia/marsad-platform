import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity, type ResolvedSecurity } from "@/lib/securities/resolve";
import { buildStockHeader } from "@/lib/data/adapters/stock-header";
import { listPrerenderStocks } from "@/lib/data/stock-params";
import { StockHeader } from "@/components/reader/stock/StockHeader";
import { JsonLd } from "@/components/reader/JsonLd";
import { venueName, siteUrl } from "@/lib/reader/format";

/**
 * Stock workspace segment layout (design 3a–3d) — REAL DATA.
 *
 * Every `[venue]/[ticker]` used to render the same baked Saudi Aramco sample;
 * it now resolves the actual security and `notFound()`s on a miss. 705 of the
 * 762 tracked names carry a live quote, so this is the single biggest surface
 * the bridge lights up (see `docs/BRIDGE-BUILD-PLAN.md` P1).
 *
 * Prerender posture (owner decision **D-6(b)**): prerendering all 705 names ×
 * 7 tabs is ~4,900 pages for very little gain, so `generateStaticParams`
 * returns only the most-traded head of the distribution and everything else
 * renders on demand. `generateStaticParams` must stay a pure DB read — no
 * wall-clock, no request state.
 *
 * The header body is Suspense-wrapped because it reads per-request data under
 * `cacheComponents`; the fallback mirrors the header's geometry so the tab bar
 * does not jump when it resolves.
 */
type Params = { venue: string; ticker: string };

export async function generateStaticParams(): Promise<Params[]> {
  return listPrerenderStocks();
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) return { title: "Stock not found" };

  const title = `${sec.ticker} — ${sec.name}`;
  const description = `${sec.name} (${sec.ticker}, ${venueName(sec.venueCode)}) — ratios, financials, filings and ownership on Marsad.`;
  const ogImage = `/api/og/stock/${sec.venueCode}/${sec.ticker}`;
  return {
    title,
    description,
    alternates: { canonical: `${siteUrl()}/stocks/${sec.venueCode}/${sec.ticker}` },
    openGraph: { title, description, images: [{ url: ogImage, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

function HeaderFallback() {
  return (
    <div className="bg-paper px-7 pt-4" aria-hidden>
      <div className="h-4 w-64 animate-pulse bg-hairline-soft" />
      <div className="mt-3 h-12 w-96 animate-pulse bg-hairline" />
      <div className="mt-4 h-[42px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function StockHeaderBody({ sec }: { sec: ResolvedSecurity }) {
  const header = await buildStockHeader(sec);
  if (!header) notFound();

  const base = `/stocks/${sec.venueCode}/${sec.ticker}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Corporation",
    name: sec.name,
    tickerSymbol: sec.ticker,
    url: `${siteUrl()}${base}`,
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <StockHeader header={header} base={base} />
    </>
  );
}

export default async function StockLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<Params>;
}) {
  const { venue, ticker } = await params;

  // Resolve BEFORE anything streams. `notFound()` inside the Suspense child
  // below would only fire after the 200 shell had already been flushed, so an
  // unknown ticker served the 404 *body* with a 200 *status* — exactly the
  // wrong-canonical / duplicate-content failure the plan's risk register warns
  // about. `resolveSecurity` is `use cache`, so this costs nothing on the hot
  // path and the tab bodies reuse the same cached entry.
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  return (
    <div className="mx-auto max-w-[1440px] bg-paper">
      <Suspense fallback={<HeaderFallback />}>
        <StockHeaderBody sec={sec} />
      </Suspense>
      {children}
    </div>
  );
}

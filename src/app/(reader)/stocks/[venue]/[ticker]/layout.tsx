import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity, listSecurityParams } from "@/lib/securities/resolve";
import { getStockHeader } from "@/lib/data/stocks";
import { QuoteHeader } from "@/components/reader/QuoteHeader";
import { StockTabs } from "@/components/reader/StockTabs";
import { JsonLd } from "@/components/reader/JsonLd";
import { siteUrl, venueName } from "@/lib/reader/format";

/**
 * Stock-page segment layout. Resolves (venue, ticker) → security (404 if none),
 * renders the delayed QUOTE HEADER (client island seeded with the cached quote)
 * + the tab bar, then the active tab's page as `children`.
 *
 * All reads here are `use cache` (resolveSecurity, getStockHeader) so the shell
 * prerenders per prebuilt param. `generateStaticParams` supplies the full public
 * universe; unknown (venue, ticker) pairs fall through to `notFound()`.
 */

type Params = { venue: string; ticker: string };

export async function generateStaticParams(): Promise<Params[]> {
  return listSecurityParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) return { title: "Not found" };
  const title = `${sec.ticker} — ${sec.name}`;
  const description = `${sec.name} (${sec.ticker}, ${sec.venueCode}) — delayed price, filings, and the Marsad Score.`;
  const ogImage = `/api/og/stock/${sec.venueCode}/${sec.ticker}`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: ogImage, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

export default async function StockLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<Params>;
}) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const header = await getStockHeader(sec.id);
  if (!header) notFound();

  const base = `/stocks/${header.venueCode}/${header.ticker}`;
  const pageUrl = `${siteUrl()}${base}`;

  // Public identity structured data only (no financials / ratios / grades).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": ["Corporation", "FinancialProduct"],
    name: header.name,
    tickerSymbol: header.ticker,
    url: pageUrl,
    category: "Exchange-listed equity",
    identifier: [
      { "@type": "PropertyValue", propertyID: "ticker", value: header.ticker },
      { "@type": "PropertyValue", propertyID: "venue", value: header.venueCode },
    ],
    ...(header.currency ? { currency: header.currency } : {}),
    subjectOf: {
      "@type": "WebPage",
      url: pageUrl,
      name: `${header.ticker} — ${header.name}`,
    },
    provider: {
      "@type": "Organization",
      name: venueName(header.venueCode),
    },
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 sm:px-8">
      <JsonLd data={jsonLd} />
      <section className="border-b border-hairline pb-5">
        <QuoteHeader
          venueCode={header.venueCode}
          ticker={header.ticker}
          name={header.name}
          sector={header.sector}
          currency={header.currency}
          initialQuote={header.quote}
          initialFreshness={header.freshness}
        />
      </section>

      <div className="mt-1 border-b-2 border-ink">
        <StockTabs base={base} />
      </div>

      <div className="py-7">{children}</div>
    </div>
  );
}

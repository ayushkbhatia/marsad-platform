import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity, listSecurityParams } from "@/lib/securities/resolve";
import { getStockHeader } from "@/lib/data/stocks";
import { QuoteHeader } from "@/components/reader/QuoteHeader";
import { StockTabs } from "@/components/reader/StockTabs";

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
  return {
    title: `${sec.ticker} — ${sec.name}`,
    description: `${sec.name} (${sec.ticker}, ${sec.venueCode}) — delayed price, filings, and the Marsad Score.`,
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

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 sm:px-8">
      <section className="border-b border-hairline pb-5">
        <QuoteHeader
          venueCode={header.venueCode}
          ticker={header.ticker}
          name={header.name}
          currency={header.currency}
          initialQuote={header.quote}
          initialFreshness={header.freshness}
        />
      </section>

      <div className="mt-1 border-b border-hairline">
        <StockTabs base={base} />
      </div>

      <div className="py-7">{children}</div>
    </div>
  );
}

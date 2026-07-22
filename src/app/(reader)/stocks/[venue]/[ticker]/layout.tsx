import type { Metadata } from "next";
import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockHeader } from "@/components/reader/stock/StockHeader";

/**
 * Stock workspace segment layout (design 3a–3d). Renders the shared
 * `StockHeader` (breadcrumb / identity / price / tab bar) once, then the
 * active tab as `children`.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/stock.ts`): the
 * workspace is a template reused across every ticker, so for the fidelity
 * pass every `[venue]/[ticker]` renders the fully-resolved 2222 sample. The
 * real resolve (`resolveSecurity` → `notFound()`), the live `QuoteHeader`
 * island, `getStockHeader`, and the `Corporation` JSON-LD are the adapter
 * basis (DEF-STOCK-LIVE-DATA). The six known Tadawul slugs prerender via
 * `generateStaticParams`; any other renders on demand.
 */
type Params = { venue: string; ticker: string };

export function generateStaticParams(): Params[] {
  return [{ venue: "TDWL", ticker: SAMPLE_STOCK.header.ticker }];
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { ticker } = await params;
  const h = SAMPLE_STOCK.header;
  return {
    title: `${ticker} — ${h.name}`,
    description: `${h.name} (${h.ticker}, ${h.venueLabel}) — the Marsad stock workspace: ratios, financials, filings, ownership.`,
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
  const base = `/stocks/${venue}/${ticker}`;

  return (
    <div className="mx-auto max-w-[1440px] bg-paper">
      <StockHeader header={SAMPLE_STOCK.header} base={base} />
      {children}
    </div>
  );
}

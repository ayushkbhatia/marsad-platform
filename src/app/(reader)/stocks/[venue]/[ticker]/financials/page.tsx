import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getFinancialsForSecurity } from "@/lib/data/financials";
import { toStockFinancials } from "@/lib/data/adapters/stock-financials";
import { withSampleFallback } from "@/lib/data/adapters/fallback";
import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockFinancials } from "@/components/reader/stock/StockFinancials";
import { PremiumLock } from "@/components/reader/PremiumLock";
import { EmptyState } from "@/components/ui";

/**
 * Stock Financials tab (design 3b) — REAL filed statements (BRIDGE-BUILD-PLAN P1.6).
 *
 * Reads the free tier of `public.v_financials_public` (4 most recent quarters +
 * 2 most recent annual periods, headline lines only) and renders it through the
 * frozen `Financials` contract. Deep history, segments and the full line-item
 * break-up stay premium and sit behind `PremiumLock` below the tables.
 *
 * Same shape as the sibling real-data tabs (`earnings`, `dividends`): a plain
 * async page whose only awaits are `params` and `use cache` reads, so no
 * `<Suspense>` boundary is required (docs/frontend/CONVENTIONS.md §3 — the
 * boundary is for request-time/dynamic reads, which this page has none of).
 *
 * HONEST DEGRADATION:
 * - 136 of 762 securities have no filed statements — those render
 *   `EmptyState awaitingFeed` rather than another company's numbers.
 * - TDWL per-share figures are withheld by the view (DEF-TDWL-EPS-MAPPING) and
 *   the absence is stated in the table note, not silently filled.
 */

type Params = { venue: string; ticker: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) return { title: "Not found" };
  return { title: `Financials · ${sec.name}` };
}

export default async function StockFinancialsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const rows = await getFinancialsForSecurity(sec.id);

  // Law #2: a security with genuinely no filed statements gets the honest empty
  // state. The sample fallback below is only ever reached when real rows exist
  // but cannot be shaped into the contract — never as a stand-in for absent data.
  if (rows.length === 0) {
    return (
      <div className="px-7 pt-4 pb-[30px]">
        <EmptyState
          variant="awaitingFeed"
          title="No filed financial statements for this security yet"
          body="Quarterly and annual income, balance-sheet and cash-flow statements appear here as they are filed with the exchange and projected into the lake."
        />
      </div>
    );
  }

  // TODO(P8): retire fallback — D-7(b), once this surface is confirmed live.
  const financials = await withSampleFallback(
    "stock-financials",
    async () => toStockFinancials(rows),
    SAMPLE_STOCK.financials,
  );

  return (
    <div className="flex flex-col">
      <StockFinancials financials={financials} />
      <div className="px-7 pb-[30px]">
        <PremiumLock
          title="Full statement history"
          teaser={`${sec.name} files back to the start of lake coverage. Premium unlocks the complete quarterly and annual series, segment break-ups, line-item detail and the XLSX export — the free view shows the most recent eight quarters and ten financial years.`}
        />
      </div>
    </div>
  );
}

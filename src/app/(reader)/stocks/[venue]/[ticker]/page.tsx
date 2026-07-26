import { Suspense } from "react";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { buildStockOverview } from "@/lib/data/adapters/stock-overview";
import { StockOverview } from "@/components/reader/stock/StockOverview";

/**
 * Stock Overview tab (design 3a) — REAL DATA.
 *
 * Ratios, the price sparkline and the peer table come from
 * `v_key_ratios_public` / `ohlcv_daily` / `quotes_latest` / `v_scores_public`
 * via `adapters/stock-overview.ts`.
 *
 * The editorial half of the design (about, key points, desk view, pros/cons)
 * has NO backing column anywhere in the schema and stays sample-fed —
 * DEF-STOCK-EDITORIAL-FIELDS. Ratios the free view cannot serve (P/B, yield,
 * ROE, EV/EBITDA) render "—" rather than being derived from something they are
 * not, and P/E is suppressed on TDWL while DEF-TDWL-EPS-MAPPING is open.
 */
type Params = { venue: string; ticker: string };

async function OverviewBody({ venue, ticker }: Params) {
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  // NO sample fallback on a per-entity surface: serving another company's
  // overview would be worse than serving nothing. A genuinely unresolvable
  // security is a 404; a read failure surfaces as an error, not as Aramco.
  const overview = await buildStockOverview(sec);
  if (!overview) notFound();

  return <StockOverview overview={overview} />;
}

function OverviewFallback() {
  return (
    <div className="px-7 py-6" aria-hidden>
      <div className="h-16 w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 h-[200px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

export default async function StockOverviewPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  return (
    <Suspense fallback={<OverviewFallback />}>
      <OverviewBody venue={venue} ticker={ticker} />
    </Suspense>
  );
}

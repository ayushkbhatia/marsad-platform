import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getStockOverview, getOhlcvSeries } from "@/lib/data/stocks";
import { getFilingsForSecurity, getFilingsCountForSecurity } from "@/lib/data/filings";
import { getKeyRatiosStrip, getPeerComparison, getDividendBox } from "@/lib/data/stock-overview";
import { ScoreModule } from "@/components/ui";
import { FilingsList } from "@/components/reader/FilingsList";
import { KeyRatiosStrip } from "@/components/reader/stock/KeyRatiosStrip";
import { PeerComparisonTable } from "@/components/reader/stock/PeerComparisonTable";
import { DividendBox } from "@/components/reader/stock/DividendBox";
import { ProsConsCards } from "@/components/reader/stock/ProsConsCards";
import { AboutDeskView } from "@/components/reader/stock/AboutDeskView";
import { ChartPanel } from "@/components/reader/stock/ChartPanel";
import { toRating, currencyLabel, fmtDate } from "@/lib/reader/format";

/**
 * Overview tab — the Overview BODY (design screens 1g / 3a). The stock
 * HEADER (QuoteHeader) and StockTabs live in `layout.tsx` and are untouched;
 * everything below is owned by this route.
 *
 * PUBLIC-only surface: identity, the headline Marsad Score (grades LOCKED —
 * never fetched), the key-ratios strip (free half only), a real 1Y price
 * chart, the About/Desk-View + Pros/Cons chrome (honest awaiting state — no
 * content source exists yet for either), the dividend rail box (state-gated,
 * graceful "—"), a sector peer-comparison table (premium ratio columns
 * locked, never fetched), and the filings teaser.
 *
 * Every read is `use cache` (resolveSecurity / getStockOverview /
 * getKeyRatiosStrip / getPeerComparison / getDividendBox / getOhlcvSeries /
 * filings), so this prerenders per prebuilt param.
 */

type Params = { venue: string; ticker: string };

function deltaString(d: number | null): string {
  if (d == null || d === 0) return "▬ FLAT THIS WEEK";
  return d > 0 ? `▲ +${d} THIS WEEK` : `▼ −${Math.abs(d)} THIS WEEK`;
}

export default async function OverviewPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const [overview, filings, filingsCount, keyRatios, peers, dividendBox, chartSeries] = await Promise.all([
    getStockOverview(sec.id),
    getFilingsForSecurity(sec.id, 5),
    getFilingsCountForSecurity(sec.id),
    getKeyRatiosStrip(sec.id),
    getPeerComparison(sec.id),
    getDividendBox(sec.id),
    getOhlcvSeries(sec.id, "1Y"),
  ]);
  if (!overview) notFound();

  const { score } = overview;
  const base = `/stocks/${overview.venueCode}/${overview.ticker}`;
  const cur = currencyLabel(overview.currency);

  return (
    <div className="flex flex-col gap-8">
      {/* Key ratios strip — full width, above the main/rail split */}
      <KeyRatiosStrip data={keyRatios} />

      <div className="grid gap-8 lg:grid-cols-[1fr_356px]">
        {/* Main column */}
        <div className="flex flex-col gap-8">
          {/* About + Chart split */}
          <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
            <AboutDeskView name={overview.name} />
            <div className="flex flex-col gap-4">
              <ChartPanel series={chartSeries} currency={cur} chartHref={`${base}/chart`} />
              <ProsConsCards />
            </div>
          </div>

          {/* Sector peer comparison */}
          <PeerComparisonTable data={peers} />

          {/* Latest filings teaser */}
          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-hairline pb-1.5">
              <h2 className="font-display text-heading-sm font-semibold text-ink">Latest filings</h2>
              <Link
                href={`${base}/filings`}
                className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
              >
                All {filingsCount.toLocaleString("en-US")} →
              </Link>
            </div>
            <FilingsList items={filings} showSummary emptyLabel="No filings recorded for this security yet." />
          </section>
        </div>

        {/* Aside: Score + Dividend */}
        <aside className="flex flex-col gap-5">
          {score && score.score != null ? (
            <ScoreModule
              surface="light"
              variant="locked"
              score={score.score}
              rating={toRating(score.rating) ?? "Hold"}
              delta={deltaString(score.weeklyDelta)}
              footnote={`UPDATED ${fmtDate(score.computedAt)} · FACTOR GRADES PREMIUM`}
            />
          ) : (
            <ScoreModule
              surface="light"
              variant="pending"
              footnote="MARSAD SCORE · NOT YET COMPUTED FOR THIS SECURITY"
            />
          )}

          <DividendBox data={dividendBox} />
        </aside>
      </div>
    </div>
  );
}

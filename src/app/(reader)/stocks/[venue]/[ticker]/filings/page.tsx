import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getStockFilingsConcalls } from "@/lib/data/adapters/stock-filings";
import { StockFilingsConcalls } from "@/components/reader/stock/StockFilingsConcalls";
import { EmptyState } from "@/components/ui";

/**
 * Stock Filings & Concalls tab (design 3c) — REAL DATA (step P1.5).
 *
 * Was `SAMPLE_STOCK.filings` (Saudi Aramco) for every ticker. Now:
 * `resolveSecurity` → `getStockFilingsConcalls` → the frozen `FilingsConcalls`
 * contract. `public.filings` covers 658 of 762 securities; the remaining ~104
 * get the honest `awaitingFeed` state rather than someone else's filings.
 *
 * The earnings-call half of the design has NO producer (`public.transcripts` = 0
 * rows, `transcript_segments` = 0 → P7.6), so it renders `EmptyState
 * awaitingFeed` per Law #2. Reports, next events and related research have no
 * source either and render empty (see the adapter's section table).
 *
 * Cached reads only (`resolveSecurity`, `getFilingsForSecurity`,
 * `getFilingsCountForSecurity` are all `use cache`), so no `<Suspense>` boundary
 * is needed here — same shape as the sibling `earnings/` and `dividends/` tabs.
 * CONVENTIONS §3: `params` is a Promise; no `export const dynamic/revalidate`.
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
  return { title: `Filings & concalls · ${sec.name}` };
}

export default async function StockFilingsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const { filings, totalFilings, shownFilings, withAiSummary } = await getStockFilingsConcalls(sec.id);

  if (filings.announcements.length === 0) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-4 pb-[30px]">
        <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
          <span className="font-display text-[20px] font-semibold text-ink">Announcements</span>
          <span className="font-mono text-[9px] text-ink-faint">
            {sec.venueCode} FEED · {sec.ticker}
          </span>
        </div>
        <EmptyState
          variant="awaitingFeed"
          title={`No exchange filings on record for ${sec.name}`}
          body="Announcements appear here as the venue feed publishes them. 658 of 762 listed securities are covered today; this one has not filed through the feed yet."
        />
      </div>
    );
  }

  return (
    <>
      <StockFilingsConcalls filings={filings} />

      <div className="flex flex-col gap-3 px-7 pb-[30px]">
        {/* Earnings calls: `transcripts` = 0 rows. The honest empty state lives
            here because the section header inside StockFilingsConcalls has no
            empty slot — see the report note on that component. */}
        {filings.earningsCalls.length === 0 ? (
          <EmptyState
            variant="awaitingFeed"
            title="No earnings-call transcripts yet"
            body="Concall transcripts, decks and Marsad AI call summaries appear here once the transcript feed lands. Nothing is inferred in the meantime."
          />
        ) : null}

        <p className="font-mono text-[9px] leading-[1.6] tracking-[0.02em] text-ink-faint">
          Showing {shownFilings.toLocaleString("en-US")} of{" "}
          {totalFilings.toLocaleString("en-US")} filings on record for {sec.ticker} ·{" "}
          {sec.venueCode}
          {withAiSummary > 0
            ? ` · ${withAiSummary.toLocaleString("en-US")} carry a Marsad AI summary`
            : " · Marsad AI summaries are not yet generated for this venue"}
          . Filing dates are exchange publication timestamps; where a venue stamps
          ingest time instead, the publication time is read from the filing reference.
        </p>
      </div>
    </>
  );
}

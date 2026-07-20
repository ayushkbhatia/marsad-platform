import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getFilingsForSecurity, getFilingsCountForSecurity } from "@/lib/data/filings";
import { FilingsList } from "@/components/reader/FilingsList";

/**
 * Filings tab — the richest live surface (public.filings, 13.5k rows). Newest
 * filings for this security with the AI summary line. All `use cache`, so it
 * prerenders per param; the filings ingest revalidates via `stock:{id}`.
 */

type Params = { venue: string; ticker: string };

export default async function StockFilingsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const [filings, count] = await Promise.all([
    getFilingsForSecurity(sec.id, 100),
    getFilingsCountForSecurity(sec.id),
  ]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-heading-sm font-semibold text-ink">Filings</h2>
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          {count.toLocaleString("en-US")} total
          {count > filings.length ? ` · showing latest ${filings.length}` : ""}
        </span>
      </div>

      <FilingsList
        items={filings}
        showSummary
        emptyLabel="No filings recorded for this security yet."
      />

      <p className="mt-1 font-mono text-[9px] leading-[1.6] text-ink-faint">
        Disclosures are sourced from venue filing systems and may lag the official
        publication. Tap a filing for the full record.
      </p>
    </div>
  );
}

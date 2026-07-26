import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getOwnershipForSecurity } from "@/lib/data/stock-events";
import { toOwnership } from "@/lib/data/adapters/stock-ownership";
import { StockOwnership } from "@/components/reader/stock/StockOwnership";
import { EmptyState } from "@/components/ui";

/**
 * Stock Ownership & People tab (design 3d) — REAL READ, HONESTLY EMPTY.
 *
 * This page used to render the Saudi Aramco sample for every ticker. It now
 * reads `getOwnershipForSecurity` and maps it through
 * `adapters/stock-ownership`. `holders`, `holder_positions`,
 * `ownership_snapshots` and `company_people` are **all 0 rows** today
 * (measured against the live DB, 2026-07-26 — producer-pending,
 * DEF-SECTOR-DATA / BRIDGE-BUILD-PLAN P7.5), so every security currently
 * resolves to `EmptyState variant="awaitingFeed"`.
 *
 * That is deliberate: Law #2 forbids shipping a plausible shareholding table
 * for a security whose ownership nobody has published. No
 * `withSampleFallback` here — a known-empty producer is exactly the case the
 * fallback must not cover. The mapping is proven by the fixture test at
 * `src/lib/data/adapters/__tests__/stock-ownership.test.ts`, so the tab lights
 * up with no further front-end change the moment the producer lands.
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
  return { title: `Ownership & people · ${sec.name}` };
}

export default async function StockOwnershipPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const ownership = toOwnership(await getOwnershipForSecurity(sec.id));

  if (ownership) return <StockOwnership ownership={ownership} />;

  return (
    <div className="px-7 pt-4 pb-[30px]">
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
        <h2 className="font-display text-[20px] font-semibold text-ink">Ownership &amp; people</h2>
        <span className="font-mono text-[9px] tracking-[0.04em] text-ink-faint">
          {sec.ticker} · {sec.venueCode}
        </span>
      </div>

      <EmptyState
        className="mt-4"
        variant="awaitingFeed"
        title="No ownership disclosures published for this security yet"
        body="The shareholding pattern, top holders, board of directors and key management populate here once the ownership producer lands. Nothing is shown until the registrar and venue disclosures have actually been captured."
      />

      <p className="mt-4 font-mono text-[9px] leading-[1.6] tracking-[0.02em] text-ink-faint">
        Ownership data is sourced from venue shareholding disclosures, registrar records and
        company governance filings. Marsad does not estimate stakes it has not seen disclosed.
      </p>
    </div>
  );
}

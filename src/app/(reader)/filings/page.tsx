import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getGlobalFilings, getFilingsByTicker } from "@/lib/data/filings";
import { FilingsList } from "@/components/reader/FilingsList";

/**
 * Global filings register / wire. Reads `?ticker=` and `?cursor=` (runtime
 * searchParams) → the data-reading body runs inside a <Suspense> boundary so
 * the shell prerenders and the feed streams (cacheComponents rule).
 *
 * - no filter → newest across all venues, keyset-paged by `?cursor=` (filed_at).
 * - `?ticker=` → every security carrying that ticker (venue-ambiguous by design).
 */

const REGISTER_TITLE = "Filings wire";
const REGISTER_DESCRIPTION = "The live register of disclosures across all six GCC venues.";

export const metadata: Metadata = {
  title: REGISTER_TITLE,
  description: REGISTER_DESCRIPTION,
  openGraph: {
    title: REGISTER_TITLE,
    description: REGISTER_DESCRIPTION,
    images: [{ url: "/api/og/filings", width: 1200, height: 630, alt: REGISTER_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: REGISTER_TITLE,
    description: REGISTER_DESCRIPTION,
    images: ["/api/og/filings"],
  },
};

type Search = { ticker?: string; cursor?: string };

export default function FilingsRegisterPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  return (
    <div className="mx-auto max-w-[860px] px-5 py-8 sm:px-8">
      <header className="mb-5 border-b border-hairline pb-3">
        <h1 className="font-display text-heading font-bold text-ink">Filings wire</h1>
        <p className="mt-1 font-ui text-[13px] text-ink-muted">
          Disclosures across Tadawul, DFM, ADX, QE, MSX and BHB — newest first, delayed.
        </p>
      </header>

      <Suspense fallback={<RegisterFallback />}>
        <RegisterBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function RegisterFallback() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 w-full animate-pulse bg-hairline-soft" />
      ))}
    </div>
  );
}

async function RegisterBody({ searchParams }: { searchParams: Promise<Search> }) {
  const { ticker, cursor } = await searchParams;
  const filterTicker = (ticker ?? "").trim().toUpperCase();

  if (filterTicker) {
    const items = await getFilingsByTicker(filterTicker);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-ink-muted">
            Filtered to <span className="font-semibold text-ink">{filterTicker}</span> · {items.length} filings
          </span>
          <Link href="/filings" className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2">
            Clear filter ✕
          </Link>
        </div>
        <FilingsList
          items={items}
          showTicker
          showSummary
          emptyLabel={`No filings found for ticker ${filterTicker}.`}
        />
      </div>
    );
  }

  const page = await getGlobalFilings(cursor);
  return (
    <div className="flex flex-col gap-4">
      <FilingsList items={page.items} showTicker showSummary emptyLabel="No filings on the wire yet." />
      {page.nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={`/filings?cursor=${encodeURIComponent(page.nextCursor)}`}
            className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
          >
            Older filings →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

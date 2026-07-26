import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getNewswire } from "@/lib/data/adapters/newswire";
import { NewswireFilterRail } from "@/components/reader/wire/NewswireFilterRail";
import { NewswireFeed } from "@/components/reader/wire/NewswireFeed";
import { NewswireContextRail } from "@/components/reader/wire/NewswireContextRail";

/**
 * Newswire — design screen 1d. A 3-column broadsheet: a 232px FILTER/VENUE
 * rail, the centre "Wire" feed (date-grouped items, plain + "DEVELOPING"
 * variants, inline ticker chips, a degraded-feed banner), and a 300px context
 * rail (raw exchange filings, corporate actions, most read) — dividers at
 * 1px ink.
 *
 * **LIVE (step P2.2).** Content comes from `src/lib/data/adapters/newswire.ts`
 * — the canonical reference adapter — over real `public.filings` (14,632 rows)
 * and `public.venue_feed_status`. `SAMPLE_NEWSWIRE` is no longer imported here;
 * it stays in the repo as the other implementation of the same contract until
 * P8.5 retires it. There is deliberately NO sample fallback: the sample's
 * tickers, venues and headlines are invented, so serving them as "the wire"
 * would be fabrication rather than a placeholder (Law #2).
 *
 * Two sections are honestly EMPTY, not sample-filled — `corporateActions`
 * (`dividends`: 1,229 rows, 0 anon-visible, all `pending_confirm`) and
 * `mostRead` (no analytics store exists). See DEF-WIRE-CORPACTIONS /
 * DEF-WIRE-MOSTREAD.
 *
 * SHELL/BODY SPLIT: the page reads `searchParams` (`?venue=&type=&cursor=`)
 * and the clock (for today's count), so the reading body sits inside a
 * `<Suspense>` boundary and the shell prerenders — the cacheComponents rule
 * this repo follows on `/filings` and `/search`.
 */
const WIRE_TITLE = "Newswire";
const WIRE_DESCRIPTION = "The live wire of GCC disclosures — filter by venue and type, delayed.";

export const metadata: Metadata = {
  title: WIRE_TITLE,
  description: WIRE_DESCRIPTION,
  openGraph: {
    title: WIRE_TITLE,
    description: WIRE_DESCRIPTION,
    images: [{ url: "/api/og/wire", width: 1200, height: 630, alt: WIRE_TITLE }],
  },
  twitter: { card: "summary_large_image", title: WIRE_TITLE, description: WIRE_DESCRIPTION, images: ["/api/og/wire"] },
};

type Search = { venue?: string; type?: string; cursor?: string };

export default function WirePage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <div className="grid grid-cols-1 gap-y-8 lg:grid-cols-[232px_1fr_300px] lg:gap-x-[30px] lg:gap-y-0">
          <Suspense fallback={<WireFallback />}>
            <WireBody searchParams={searchParams} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function WireBody({ searchParams }: { searchParams: Promise<Search> }) {
  // The clock read happens HERE, behind `connection()`, and is passed into the
  // adapter as `todayISO` — never read inside a `use cache` function, where it
  // would freeze one caller's "today" into a shared cache entry (P0.7).
  await connection();
  const sp = await searchParams;
  const todayISO = new Date().toISOString().slice(0, 10);

  const { data: d } = await getNewswire({
    todayISO,
    venue: sp.venue,
    type: sp.type,
    cursor: sp.cursor,
  });

  return (
    <>
      <NewswireFilterRail categories={d.categories} venues={d.venues} />
      <NewswireFeed
        todayCount={d.todayCount}
        dateLabel={d.dateLabel}
        connection={d.connection}
        feed={d.feed}
        olderHref={d.olderHref}
      />
      <NewswireContextRail
        filings={d.filings}
        corporateActions={d.corporateActions}
        mostRead={d.mostRead}
      />
    </>
  );
}

/** Three-column skeleton matching the live grid, so the shell doesn't jump. */
function WireFallback() {
  return (
    <>
      <div className="lg:border-r lg:border-hairline lg:pr-6">
        <div className="h-5 border-b-2 border-ink" />
        <div className="mt-3 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-5 bg-paper-tint" />
          ))}
        </div>
      </div>
      <div>
        <div className="h-8 border-b-2 border-ink" />
        <div className="mt-3 space-y-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 border-b border-hairline-soft bg-paper-tint" />
          ))}
        </div>
      </div>
      <div className="lg:border-l lg:border-hairline lg:pl-6">
        <div className="h-5 border-b-2 border-ink" />
        <div className="mt-3 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 bg-paper-tint" />
          ))}
        </div>
      </div>
    </>
  );
}

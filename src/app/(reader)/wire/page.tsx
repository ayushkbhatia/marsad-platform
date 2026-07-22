import type { Metadata } from "next";
import { SAMPLE_NEWSWIRE } from "@/lib/data/sample/newswire";
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
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/newswire.ts`), the
 * same seam pattern as the 1b home page: it renders the page pixel-for-pixel
 * as it will look in production. The real wire — the live-poll +
 * keyset-paged `public.filings` feed, newsroom WIRE items, venue/type facet
 * counts, corporate actions, most-read — re-wires by mapping those reads onto
 * this module's view-model types and swapping `SAMPLE_NEWSWIRE` here; the
 * existing `WireStream`/`feed.ts`/`WireLeftRail`/`WireRightRail` infra is the
 * adapter basis (DEF-NEWSWIRE-LIVE-DATA). Fully static today, so the route
 * prerenders with the shell.
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

export default function WirePage() {
  const d = SAMPLE_NEWSWIRE;

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <div className="grid grid-cols-1 gap-y-8 lg:grid-cols-[232px_1fr_300px] lg:gap-x-[30px] lg:gap-y-0">
          <NewswireFilterRail categories={d.categories} venues={d.venues} />
          <NewswireFeed
            todayCount={d.todayCount}
            dateLabel={d.dateLabel}
            connection={d.connection}
            feed={d.feed}
          />
          <NewswireContextRail
            filings={d.filings}
            corporateActions={d.corporateActions}
            mostRead={d.mostRead}
          />
        </div>
      </div>
    </div>
  );
}

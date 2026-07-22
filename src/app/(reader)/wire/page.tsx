import { Suspense } from "react";
import type { Metadata } from "next";
import { getWireFilings, getFilingTypeFacets } from "@/lib/data/filings";
import { getWireVenueFacets, getFilingsTodayCount, getQuotesForSecurities } from "@/lib/data/wire";
import { listNewsroomContent } from "@/lib/data/newsroom";
import { WireStream } from "@/components/reader/WireStream";
import { WireHeader } from "@/components/reader/wire/WireHeader";
import { WireLeftRail } from "@/components/reader/wire/WireLeftRail";
import { WireRightRail } from "@/components/reader/wire/WireRightRail";
import { filingToWireItem, newsroomToWireItem, sortWireFeed } from "@/components/reader/wire/feed";

/**
 * Newswire (1d) — the 3-column broadsheet: a FILTER/VENUE left rail, the
 * center "Wire" feed (the newsroom's own published WIRE content_items
 * merged with the raw `public.filings` disclosure feed into one date-grouped
 * timeline — the newsroom items render with the design's "DEVELOPING"
 * treatment, filings render plain), and a right rail of the raw filings
 * feed + (scaffolded, honestly-empty) corporate actions / most-read.
 *
 * Facets are runtime searchParams (`?venue=`, `?type=`, `?cursor=`), so the
 * data body runs inside a <Suspense> boundary (cacheComponents rule); the
 * server renders the first faceted page, then `WireStream` appends newer
 * filings from `/api/pulse/wire` every 30s while the relevant venue is open.
 * `?cursor=` (the design's "Load earlier items") is a plain keyset-paged
 * navigation — same pattern as `/filings` — and, while paging into history,
 * suppresses both live polling and the newsroom cards (neither is meaningful
 * mid-history).
 *
 * Filing items link to /filings/[id]; newsroom wire items link to
 * /wire/[slug]. /filings remains the formal disclosure register (reachable
 * from the header's WIRE | FILINGS REGISTER toggle).
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
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <Suspense fallback={<WireFallback />}>
        <WireBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function WireFallback() {
  return (
    <div className="grid grid-cols-1 gap-y-6 lg:grid-cols-[232px_1fr_300px] lg:gap-x-[30px] lg:gap-y-0">
      <div className="h-[420px] w-full animate-pulse bg-hairline-soft" />
      <div className="space-y-3">
        <div className="h-8 w-full animate-pulse bg-hairline-soft" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-14 w-full animate-pulse bg-hairline-soft" />
        ))}
      </div>
      <div className="h-[420px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

/** Build a /wire URL preserving the other facet — never carries `cursor`
 *  forward, since changing a facet always starts back at the live edge. */
function wireHref(next: { venue?: string; type?: string }, current: { venue?: string; type?: string }): string {
  const venue = next.venue !== undefined ? next.venue : current.venue;
  const type = next.type !== undefined ? next.type : current.type;
  const p = new URLSearchParams();
  if (venue) p.set("venue", venue);
  if (type) p.set("type", type);
  const qs = p.toString();
  return qs ? `/wire?${qs}` : "/wire";
}

async function WireBody({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const venue = (sp.venue ?? "").trim().toUpperCase();
  const type = (sp.type ?? "").trim().toUpperCase();
  const cursor = (sp.cursor ?? "").trim() || undefined;
  const current = { venue: venue || undefined, type: type || undefined };

  const [page, typeFacets, venueFacets, newsroomWires, todayCount] = await Promise.all([
    getWireFilings({ venue, type, cursor, limit: 40 }),
    getFilingTypeFacets(),
    getWireVenueFacets(),
    cursor ? Promise.resolve([]) : listNewsroomContent({ contentTypes: ["WIRE"], limit: 5 }),
    getFilingsTodayCount({ venue, type }),
  ]);

  const secIds = page.items.map((f) => f.securityId).filter((n): n is number => n != null);
  const quotes = await getQuotesForSecurities(secIds);

  const initialFeed = sortWireFeed([
    ...page.items.map((f) => filingToWireItem(f, f.securityId != null ? quotes.get(f.securityId) : null)),
    ...newsroomWires.map(newsroomToWireItem),
  ]);

  const emptyLabel = venue || type ? "No items match this filter yet." : "No items on the wire yet.";

  return (
    <div className="grid grid-cols-1 gap-y-8 lg:grid-cols-[232px_1fr_300px] lg:gap-x-[30px] lg:gap-y-0">
      <WireLeftRail
        categories={typeFacets}
        venues={venueFacets}
        activeType={type || undefined}
        activeVenue={venue || undefined}
        hrefFor={(next) => wireHref(next, current)}
      />

      <div>
        <WireHeader todayCount={todayCount} venue={venue || undefined} />
        <WireStream
          initial={initialFeed}
          venue={venue || undefined}
          type={type || undefined}
          cursor={cursor}
          nextCursor={page.nextCursor}
          emptyLabel={emptyLabel}
        />
      </div>

      <WireRightRail rawFilings={page.items.slice(0, 6)} />
    </div>
  );
}

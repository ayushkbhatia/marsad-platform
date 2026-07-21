import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getWireFilings, getFilingTypeFacets } from "@/lib/data/filings";
import { listNewsroomContent } from "@/lib/data/newsroom";
import { WireStream } from "@/components/reader/WireStream";
import { WireCard } from "@/components/reader/newsroom/WireCard";
import { SectionBar } from "@/components/ui";
import { venueName } from "@/lib/reader/format";

/**
 * Newswire (1d) — two feeds sharing one page: the autonomous newsroom's own
 * published WIRE content_items (headline + dek + cited body — what the agent
 * pipeline actually wrote) above the raw `public.filings` disclosure feed
 * (the venue-sourced register this page has always shown). Facets
 * (`?venue=`, `?type=`) apply only to the filings feed below, as before.
 *
 * Facets are runtime searchParams, so the data body runs inside a <Suspense>
 * boundary (cacheComponents rule); the server renders the first faceted page
 * from the `use cache` `getWireFilings` (+ the newsroom wires from
 * `listNewsroomContent`), then the `WireStream` client island appends newer
 * filings from `/api/pulse/wire` every 30s while a venue is open.
 *
 * Filing items link to /filings/[id]; newsroom wire items link to
 * /wire/[slug]. /filings remains the formal disclosure register.
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

const VENUES = ["TDWL", "DFM", "ADX", "QE", "MSX", "BHB"] as const;

type Search = { venue?: string; type?: string };

export default function WirePage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <div className="mx-auto max-w-[900px] px-5 py-8 sm:px-8">
      <header className="mb-4 border-b border-hairline pb-3">
        <h1 className="font-display text-heading font-bold text-ink">Newswire</h1>
        <p className="mt-1 font-ui text-[13px] text-ink-muted">
          Every disclosure across the six GCC venues, newest first — delayed. Filter by venue and
          type; the wire updates itself during market hours.
        </p>
      </header>

      <Suspense fallback={<WireFallback />}>
        <WireBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function WireFallback() {
  return (
    <div className="space-y-3">
      <div className="h-8 w-full animate-pulse bg-hairline-soft" />
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 w-full animate-pulse bg-hairline-soft" />
      ))}
    </div>
  );
}

function FacetChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`border px-2 py-1 font-mono text-[10px] tracking-[0.04em] uppercase transition-colors ${
        active
          ? "border-ink bg-ink text-paper-tint"
          : "border-hairline-strong text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

/** Build a /wire URL preserving the other facet. */
function wireHref(next: Partial<Search>, current: Search): string {
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
  const current: Search = { venue: venue || undefined, type: type || undefined };

  const [page, typeFacets, newsroomWires] = await Promise.all([
    getWireFilings({ venue, type, limit: 40 }),
    getFilingTypeFacets(),
    listNewsroomContent({ contentTypes: ["WIRE"], limit: 5 }),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {/* From the newsroom — the agent pipeline's own published wires */}
      {newsroomWires.length > 0 ? (
        <section>
          <SectionBar label="From the newsroom" />
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {newsroomWires.map((item) => (
              <WireCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Facets */}
      <div className="flex flex-col gap-2 border border-hairline bg-paper px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[9px] tracking-[0.12em] text-ink-faint uppercase">Venue</span>
          <FacetChip href={wireHref({ venue: undefined }, current)} active={!venue}>
            All
          </FacetChip>
          {VENUES.map((v) => (
            <FacetChip key={v} href={wireHref({ venue: v }, current)} active={venue === v}>
              {venueName(v).split(" · ").pop() ?? v}
            </FacetChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[9px] tracking-[0.12em] text-ink-faint uppercase">Type</span>
          <FacetChip href={wireHref({ type: undefined }, current)} active={!type}>
            All
          </FacetChip>
          {typeFacets.slice(0, 9).map((t) => (
            <FacetChip key={t.type} href={wireHref({ type: t.type }, current)} active={type === t.type}>
              {t.type}
            </FacetChip>
          ))}
        </div>
      </div>

      <WireStream
        initial={page.items}
        venue={venue || undefined}
        type={type || undefined}
        emptyLabel={
          venue || type ? "No filings match this filter yet." : "No filings on the wire yet."
        }
      />
    </div>
  );
}

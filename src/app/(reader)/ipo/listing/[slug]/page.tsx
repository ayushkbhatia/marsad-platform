import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIpoOffer } from "@/lib/data/calendars";
import { toIpoListing } from "@/lib/data/adapters/ipo";
import { IpoListing } from "@/components/reader/ipo/IpoListing";
import { EmptyState } from "@/components/ui";

/**
 * IPO listing-day — design screen 22c, wired to the real `getIpoOffer` read
 * (build-plan step **P2.5**) via `data/adapters/ipo.ts`.
 *
 * TEMPLATE COLLAPSE, FIXED. Every `[slug]` used to render the same baked sample
 * debut ("Bina Modular Construction"), so an unknown slug answered 200 with a
 * fabricated first session — a made-up opening auction, VWAP and turnover
 * presented as a real listing. The slug is now resolved against `ipo_offers`
 * **in the page body, before anything renders**, and a miss is `notFound()`.
 *
 * ⚠️ STATUS CODE: the `notFound()` UI renders, but the response is 200 —
 * under `cacheComponents` a fully dynamic segment has already flushed its
 * shell. See the same note on `/ipo/[offerSlug]`: this is app-wide today, and
 * the fix (a non-empty `generateStaticParams`, which is a hard error while
 * empty) needs the producer. Reported to the lead.
 *
 * The debut record itself lives in `public.listing_debuts` — **0 rows**, and
 * there is no read function for that table in `src/lib/data/calendars.ts` yet
 * (requested from the lead: `getListingDebut(ipoId)`; that file belongs to
 * another slice). Until it exists this route passes `debut: null`, the adapter
 * returns `null`, and a resolved-but-undebuted offer renders `EmptyState
 * variant="awaitingFeed"` rather than another company's session. The mapping
 * against the real `listing_debuts` column set is fixture-tested
 * (`adapters/__tests__/ipo.test.ts`).
 *
 * `ipo_offers` has 0 rows today, so every slug currently 404s.
 */
type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const offer = await getIpoOffer(slug);
  if (!offer) return { title: "Not found" };

  const title = `${offer.companyName} — Listing day`;
  const description = `${offer.companyName} (${offer.venueCode}) debut session — offer price vs the opening auction, allocation recap and listed peers.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: "/api/og/ipo", width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: ["/api/og/ipo"] },
  };
}

export default async function IpoListingPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const offer = await getIpoOffer(slug);
  if (!offer) notFound();

  const data = toIpoListing({ offer, debut: null, slug });

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        {data ? (
          <IpoListing data={data} />
        ) : (
          <div className="px-7 pt-6 pb-10">
            <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-3">
              <span className="font-display text-[27px] font-bold text-ink">{offer.companyName}</span>
              <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-faint uppercase">
                {offer.venueCode} · listing day
              </span>
            </div>

            <EmptyState
              className="mt-6"
              variant="awaitingFeed"
              title="No debut session has been captured for this listing"
              body="The offer price against the opening auction, the intraday path, the allocation recap and the listed peers all appear here once the debut record is published. Nothing is shown in their place — Marsad does not reconstruct a first session it has not observed."
            />
          </div>
        )}
      </div>
    </div>
  );
}

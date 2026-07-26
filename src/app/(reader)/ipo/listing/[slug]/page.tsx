import type { Metadata } from "next";
import { SAMPLE_IPO_LISTING } from "@/lib/data/sample/ipo";
import { IpoListing } from "@/components/reader/ipo/IpoListing";

/**
 * IPO listing-day — design screen 22c. The debut-session view (offer vs open
 * vs last, intraday chart with a dashed offer-price reference, allocation
 * recap, a Marsad Score PENDING card, listed peers). Sample-seeded:
 * `listing_debuts` has 0 rows, so every `[slug]` renders the Bina template.
 * Real read basis is `getIpoJustListed` + intraday quotes (DEF-CALENDARS-LIVE-DATA).
 */
type Params = { slug: string };

export function generateMetadata(): Metadata {
  const title = `${SAMPLE_IPO_LISTING.company} — Listing day`;
  const description = `${SAMPLE_IPO_LISTING.company} (${SAMPLE_IPO_LISTING.ticker}) debut session — offer vs open vs last, allocation recap and listed peers.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: "/api/og/ipo", width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: ["/api/og/ipo"] },
  };
}

export default async function IpoListingPage({ params }: { params: Promise<Params> }) {
  await params; // slug is a template key during the design pass
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <IpoListing data={SAMPLE_IPO_LISTING} />
      </div>
    </div>
  );
}

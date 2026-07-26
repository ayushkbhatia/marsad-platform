import type { Metadata } from "next";
import { SAMPLE_IPO_DETAIL } from "@/lib/data/sample/ipo";
import { IpoDetail } from "@/components/reader/ipo/IpoDetail";

/**
 * IPO offer detail — design screen 22b. Sample-seeded: `ipo_offers` has 0 rows,
 * so every `[offerSlug]` renders the OQBI subscription-open template (the
 * design mock) during the design pass; the timeline band, offer-facts grid,
 * use-of-proceeds/financials and the premium-gated Marsad Take are all part of
 * the layout contract. Real read (`getIpoOffer` in `lib/data/calendars.ts`) is
 * the adapter basis (DEF-CALENDARS-LIVE-DATA).
 */
type Params = { offerSlug: string };

export function generateMetadata(): Metadata {
  const title = `${SAMPLE_IPO_DETAIL.company} — IPO`;
  const description = `${SAMPLE_IPO_DETAIL.company} (${SAMPLE_IPO_DETAIL.meta}) — pricing, offer facts and the retail subscription window.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: "/api/og/ipo", width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: ["/api/og/ipo"] },
  };
}

export default async function IpoOfferPage({ params }: { params: Promise<Params> }) {
  await params; // slug is a template key during the design pass
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <IpoDetail data={SAMPLE_IPO_DETAIL} />
      </div>
    </div>
  );
}

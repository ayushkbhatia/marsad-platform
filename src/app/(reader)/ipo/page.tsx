import type { Metadata } from "next";
import { SAMPLE_IPO_PIPELINE } from "@/lib/data/sample/ipo";
import { IpoPipeline } from "@/components/reader/ipo/IpoPipeline";

/**
 * IPO Center pipeline — design screen 22a. Sample-seeded: `ipo_offers` has 0
 * rows (no producer has landed the listings feed), so the stage bands render
 * from sample here. Real reads (`getIpoPipeline`/`getIpoJustListed`/
 * `getIpoKpis` in `lib/data/calendars.ts`) are the adapter basis
 * (DEF-CALENDARS-LIVE-DATA). Fully static, prerenders.
 */
const IPO_TITLE = "IPO Center";
const IPO_DESCRIPTION = "The Gulf listings pipeline — subscriptions, pricing and debuts across the six GCC venues.";

export const metadata: Metadata = {
  title: IPO_TITLE,
  description: IPO_DESCRIPTION,
  openGraph: {
    title: IPO_TITLE,
    description: IPO_DESCRIPTION,
    images: [{ url: "/api/og/ipo", width: 1200, height: 630, alt: IPO_TITLE }],
  },
  twitter: { card: "summary_large_image", title: IPO_TITLE, description: IPO_DESCRIPTION, images: ["/api/og/ipo"] },
};

export default function IpoPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <IpoPipeline data={SAMPLE_IPO_PIPELINE} />
      </div>
    </div>
  );
}

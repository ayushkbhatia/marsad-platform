import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getIpoOffer, type IpoOfferItem } from "@/lib/data/calendars";
import { toIpoOfferDetail } from "@/lib/data/adapters/ipo";
import { IpoDetail } from "@/components/reader/ipo/IpoDetail";

/**
 * IPO offer detail — design screen 22b, wired to the real `getIpoOffer` read
 * (build-plan step **P2.5**) via `data/adapters/ipo.ts`.
 *
 * TEMPLATE COLLAPSE, FIXED. Every `[offerSlug]` used to render the same baked
 * sample offer (OQ Base Industries), so an unknown slug answered 200 with
 * someone else's IPO — wrong canonicals, duplicate content, and a fabricated
 * subscription window presented as real (BRIDGE-BUILD-PLAN §6, "template
 * collapse"). The slug is now resolved against `ipo_offers` **before anything
 * renders** — in the page body, above the `<Suspense>` child, not inside it —
 * and a miss is `notFound()`. No offer's data is ever served under another
 * offer's URL.
 *
 * ⚠️ STATUS CODE: the `notFound()` UI renders, but under `cacheComponents` a
 * fully dynamic segment has already flushed its shell, so the response is 200
 * (verified with `curl -I`). That is app-wide today — `/wire/[slug]`,
 * `/filings/[filingId]`, `/articles/[slug]`, `/analysts/[slug]`,
 * `/earnings/[eventId]` and `/screens/[screenId]` all answer 200 on an unknown
 * key. The only route that answers a real 404 is `/stocks/[venue]/[ticker]`,
 * and it does so from a prerender-cache hit (`x-nextjs-prerender: 1`) that its
 * non-empty `generateStaticParams` makes possible — which cannot exist here
 * while `ipo_offers` is 0 rows (see the note below). Reported to the lead.
 *
 * `ipo_offers` has **0 rows** today (measured 2026-07-26), so every slug is a
 * miss.
 * The mapping is fixture-tested (`adapters/__tests__/ipo.test.ts`) and lights
 * up with no further front-end change when the producer lands (P7.2).
 */
type Params = { offerSlug: string };

/**
 * NO `generateStaticParams` HERE, DELIBERATELY. `ipo_offers` is 0 rows, and
 * under Cache Components an empty `generateStaticParams` is a hard error
 * ("all `generateStaticParams` functions must return at least one result" —
 * observed in the dev log, and it fails the build). Add one over
 * `getIpoPipeline()` + `ipoOfferSlug()` when the producer lands (P7.2); that
 * also puts this segment on the prerender path that lets `notFound()` answer
 * with a real 404 STATUS, which no page-level `notFound()` can do while the
 * segment is fully dynamic (see the note on the default export).
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { offerSlug } = await params;
  const offer = await getIpoOffer(offerSlug);
  if (!offer) return { title: "Not found" };

  const title = `${offer.companyName} — IPO`;
  const description = `${offer.companyName} (${offer.venueCode}) — offer terms, timeline and the retail subscription window as filed.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: "/api/og/ipo", width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: ["/api/og/ipo"] },
  };
}

export default async function IpoOfferPage({ params }: { params: Promise<Params> }) {
  // `connection()` FIRST: under cacheComponents a page-level `notFound()` cannot
  // change a status that has already been sent with a prerendered shell, so an
  // unknown slug answered 200-with-a-404-body. Opting the segment out of the
  // static shell before the lookup lets `notFound()` answer with a real 404 —
  // the same failure (and the same fix) as the stock routes in P1.
  await connection();
  const { offerSlug } = await params;
  const offer = await getIpoOffer(offerSlug);
  if (!offer) notFound();

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <Suspense fallback={<OfferFallback />}>
          <OfferBody offer={offer} slug={offerSlug} />
        </Suspense>
      </div>
    </div>
  );
}

async function OfferBody({ offer, slug }: { offer: IpoOfferItem; slug: string }) {
  // The timeline and the books-close countdown are relative to "today", which
  // is a wall-clock read — done here, in the dynamic child, and passed to the
  // pure adapter as an ISO string (CONVENTIONS §3).
  await connection();
  const todayISO = new Date().toISOString().slice(0, 10);

  return <IpoDetail data={toIpoOfferDetail({ offer, slug, todayISO })} />;
}

function OfferFallback() {
  return (
    <div className="px-7 pt-6 pb-10">
      <div className="h-4 w-40 animate-pulse bg-hairline-soft" />
      <div className="mt-4 h-9 w-80 animate-pulse bg-hairline" />
      <div className="mt-4 h-[70px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-6 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_340px]">
        <div className="h-64 w-full animate-pulse bg-hairline-soft" />
        <div className="h-64 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

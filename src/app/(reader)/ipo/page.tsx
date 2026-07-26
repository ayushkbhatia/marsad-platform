import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getIpoJustListed, getIpoKpis, getIpoPipeline } from "@/lib/data/calendars";
import { toIpoPipeline } from "@/lib/data/adapters/ipo";
import { IpoPipeline } from "@/components/reader/ipo/IpoPipeline";
import { EmptyState } from "@/components/ui";

/**
 * IPO Center pipeline — design screen 22a, wired to the real `ipo_offers` reads
 * (build-plan step **P2.5**) via `data/adapters/ipo.ts`.
 *
 * HONESTLY EMPTY, ON PURPOSE. Measured against the live DB 2026-07-26:
 * `ipo_offers` = **0 rows**, `ipo_timeline_events` = **0**, `listing_debuts` =
 * **0** (0 to `anon` as well). There is no Gulf offering on file. This page
 * used to render the sample pipeline ("OQ Base Industries", "Masar Logistics",
 * "Bayan Foods" …) which would have shipped fabricated subscriptions as if they
 * were live offers; per Law #2 it now renders `EmptyState
 * variant="awaitingFeed"` instead. No `withSampleFallback` here — a
 * known-empty producer is exactly the case that helper must not cover.
 *
 * The adapter is fully written and fixture-tested
 * (`src/lib/data/adapters/__tests__/ipo.test.ts`), so the pipeline lights up
 * with no further front-end change the moment the IPO producer lands (P7.2).
 *
 * The body is dynamic: `getIpoKpis` takes ISO date bounds so the cached reads
 * stay deterministic — the CALLER does the wall-clock read, hence
 * `connection()` inside a `<Suspense>` boundary (CONVENTIONS §3).
 */
const IPO_TITLE = "IPO Center";
const IPO_DESCRIPTION =
  "The Gulf listings pipeline — subscriptions, pricing and debuts across the six GCC venues. No offer is on file yet; the pipeline fills in when the listings feed lands.";

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
        <Suspense fallback={<IpoFallback />}>
          <IpoBody />
        </Suspense>
      </div>
    </div>
  );
}

async function IpoBody() {
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const monthEndISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  const yearStartISO = `${now.getUTCFullYear()}-01-01`;

  const [offers, justListed, kpis] = await Promise.all([
    getIpoPipeline(),
    getIpoJustListed(),
    getIpoKpis({ todayISO, monthEndISO, yearStartISO }),
  ]);

  // No `lastPrices` map: a debut's move needs a post-listing quote read this
  // slice does not own, and the contract's `changePct` cannot be honestly
  // filled without one (see the adapter's gap list).
  const data = toIpoPipeline({ offers, justListed, kpis });
  if (data) return <IpoPipeline data={data} />;

  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">IPO Center</span>
        <span className="text-[12px] text-ink-muted">
          The Gulf listings pipeline — subscriptions, pricing and debuts
        </span>
      </div>

      <EmptyState
        className="mt-6"
        variant="awaitingFeed"
        title="No Gulf offering is on file yet"
        body="Marsad holds no IPO offer, no subscription timeline and no listing debut — so there is no pipeline to publish, and nothing is being shown in its place. The stage bands, the just-listed tape and the offer pages all fill themselves in the moment the listings feed publishes its first prospectus."
      />

      <p className="mt-4 font-mono text-[9px] leading-[1.6] tracking-[0.02em] text-ink-faint">
        Offer terms are sourced from venue and regulator prospectus filings across Tadawul, DFM,
        ADX, QE, MSX and BHB. Marsad does not estimate a price range, a raise or a subscription
        window it has not seen filed.
      </p>
    </div>
  );
}

function IpoFallback() {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-44 animate-pulse bg-hairline" />
      </div>
      <div className="mt-4 h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-40 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

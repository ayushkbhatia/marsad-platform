import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import {
  getIpoPipeline,
  getIpoJustListed,
  getIpoKpis,
  classifyIpoStage,
  ipoOfferSlug,
  type IpoOfferItem,
  type IpoStageBucket,
} from "@/lib/data/calendars";
import { SectionBar, StatStrip, EmptyState } from "@/components/ui";
import Link from "next/link";
import { fmtDate } from "@/lib/reader/format";

/**
 * IPO Center pipeline (22a). `ipo_offers` has 0 rows today (confirmed empty
 * tier — no producer has landed) — the full pipeline-by-stage shell below is
 * still built against real columns/queries so it lights up unmodified the
 * moment offers are ingested; today every group renders `EmptyState
 * awaitingFeed`. `stage` has no live examples to confirm a vocabulary against,
 * so grouping uses `classifyIpoStage` (a documented best-effort bucketer, see
 * `src/lib/data/calendars.ts`).
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

const STAGE_LABELS: Record<Exclude<IpoStageBucket, "listed">, string> = {
  subscription_open: "Subscription open",
  bookbuilding: "Bookbuilding · institutional",
  announced: "Announced & filed",
  other: "In pipeline",
};
const STAGE_ORDER: Array<Exclude<IpoStageBucket, "listed">> = [
  "subscription_open",
  "bookbuilding",
  "announced",
  "other",
];

export default function IpoPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">IPO Center</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">
          The Gulf listings pipeline — subscriptions, pricing and debuts
        </p>
        <div className="ml-auto flex gap-2">
          <span className="border border-hairline-strong px-3 py-1.5 font-ui text-[11px] font-semibold text-ink-muted">
            Subscription alerts
          </span>
          <span className="border border-ink px-3 py-1.5 font-ui text-[11px] font-semibold text-ink">
            Add to calendar
          </span>
        </div>
      </header>

      <Suspense fallback={<IpoSkeleton />}>
        <IpoBody />
      </Suspense>
    </div>
  );
}

function IpoSkeleton() {
  return (
    <div className="mt-4 space-y-4">
      <div className="h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-[300px] animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

function addMonthEndISO(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}
function yearStartISO(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCFullYear()}-01-01`;
}

const ROW_GRID = "grid grid-cols-[56px_1fr_140px_90px_110px_80px] items-center gap-[10px]";

function IpoHeaderRow() {
  return (
    <div className={`${ROW_GRID} border-b border-hairline px-3 pt-1.5 pb-1`}>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Ticker</span>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Company</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Price range</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Raise</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Retail closes</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Listing</span>
    </div>
  );
}

function IpoOfferRow({ offer }: { offer: IpoOfferItem }) {
  const priceRange =
    offer.priceRangeLow != null && offer.priceRangeHigh != null
      ? `${offer.localCurrency} ${offer.priceRangeLow}–${offer.priceRangeHigh}`
      : offer.finalPrice != null
        ? `${offer.localCurrency} ${offer.finalPrice}`
        : "TBD";
  return (
    <Link
      href={`/ipo/${ipoOfferSlug(offer)}`}
      className={`${ROW_GRID} border-b border-hairline-faint px-3 py-[10px] text-ink hover:bg-paper-tint`}
    >
      <span className="font-mono text-[11px] font-semibold">{offer.ticker ?? "—"}</span>
      <span className="flex items-baseline gap-[7px] overflow-hidden">
        <span className="truncate text-[12.5px] font-semibold">{offer.companyName}</span>
        <span className="flex-none border border-hairline-soft px-1 py-px font-mono text-[7.5px] text-ink-faint">
          {offer.venueCode}
        </span>
      </span>
      <span className="text-right font-mono text-[11px] text-ink-muted">{priceRange}</span>
      <span className="text-right font-mono text-[11px]">
        {offer.raiseAmount == null ? "—" : `$${(offer.raiseAmount / 1e6).toFixed(0)}M`}
      </span>
      <span className="text-right font-mono text-[10px] text-ink-muted">
        {offer.retailCloseAt ? fmtDate(offer.retailCloseAt) : "—"}
      </span>
      <span className="text-right font-mono text-[10px] text-ink-muted">
        {offer.expectedListing ? fmtDate(offer.expectedListing) : "—"}
      </span>
    </Link>
  );
}

async function IpoBody() {
  // cacheComponents requires a dynamic source read before the wall clock.
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);

  const [pipeline, justListed, kpis] = await Promise.all([
    getIpoPipeline(),
    getIpoJustListed(3),
    getIpoKpis({ todayISO, monthEndISO: addMonthEndISO(todayISO), yearStartISO: yearStartISO(todayISO) }),
  ]);

  const groups = new Map<Exclude<IpoStageBucket, "listed">, IpoOfferItem[]>();
  for (const offer of pipeline) {
    const bucket = classifyIpoStage(offer.stage);
    if (bucket === "listed") continue;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(offer);
  }

  return (
    <>
      <StatStrip
        className="mt-4"
        items={[
          { label: "In pipeline", value: kpis.inPipeline.toLocaleString("en-US") },
          {
            label: "Subscription open",
            value: kpis.subscriptionOpen.toLocaleString("en-US"),
            dir: kpis.subscriptionOpen > 0 ? "up" : undefined,
          },
          { label: "Listing this month", value: kpis.listingThisMonth.toLocaleString("en-US") },
          { label: "Raised YTD · GCC", value: `$${(kpis.raisedYtd / 1e6).toFixed(1)}M` },
        ]}
      />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        {/* Main pipeline, grouped by stage */}
        <div>
          {pipeline.length === 0 ? (
            <EmptyState
              variant="awaitingFeed"
              title="No IPOs tracked yet"
              body="The listings pipeline populates here once the IPO producer job lands — announced floats, bookbuilding, retail subscription windows and debuts, grouped by stage."
            />
          ) : (
            STAGE_ORDER.map((bucket) => {
              const offers = groups.get(bucket);
              if (!offers || offers.length === 0) return null;
              return (
                <div key={bucket} className="mt-2.5">
                  <SectionBar
                    label={STAGE_LABELS[bucket]}
                    right={`${offers.length} OFFER${offers.length === 1 ? "" : "S"}`}
                  />
                  {/* ROW_GRID is a fixed-px 6-column track — narrower than a
                      390px mobile viewport. Scope the scroll to this row
                      region (not the page) so mobile gets a normal,
                      single-axis page instead of the whole layout overflowing
                      horizontally (WCAG 1.4.10 Reflow). The stage-band label
                      above stays put. */}
                  <div className="overflow-x-auto">
                    <IpoHeaderRow />
                    {offers.map((offer) => (
                      <IpoOfferRow key={offer.id} offer={offer} />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right rail */}
        <div className="border-l border-hairline pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Just listed
            </span>
          </div>
          {justListed.length === 0 ? (
            <p className="mt-3 border border-dashed border-hairline px-3 py-6 text-center font-mono text-[10.5px] leading-relaxed text-ink-faint">
              No completed listings tracked yet.
            </p>
          ) : (
            justListed.map((offer) => (
              <Link
                key={offer.id}
                href={`/ipo/${ipoOfferSlug(offer)}`}
                className="block border-b border-hairline-faint py-2.5 text-ink hover:bg-paper-tint"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] font-semibold">{offer.ticker ?? "—"}</span>
                  <span className="truncate font-ui text-[11px] text-ink-mid">{offer.companyName}</span>
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-faint">
                  {offer.expectedListing ? `Listed ${fmtDate(offer.expectedListing)}` : "Listed"} · {offer.venueCode}
                </div>
              </Link>
            ))
          )}

          <div className="mt-6 border border-hairline bg-paper-tint px-4 py-3.5">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint uppercase">
              How subscribing works
            </div>
            <ul className="mt-2 flex flex-col gap-1.5 font-ui text-[12px] text-ink-muted">
              <li>Retail vs institutional tranches</li>
              <li>Allocation &amp; refunds, explained</li>
              <li>Which brokers take applications</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

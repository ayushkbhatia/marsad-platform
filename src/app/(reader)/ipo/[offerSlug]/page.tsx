import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getIpoOffer, ipoOfferSlug, classifyIpoStage } from "@/lib/data/calendars";
import { EmptyState } from "@/components/ui";
import { PremiumLock } from "@/components/reader/PremiumLock";
import { JsonLd } from "@/components/reader/JsonLd";
import { fmtDate, fmtDateTime, venueName, siteUrl } from "@/lib/reader/format";

/**
 * IPO offer detail (22b). `ipo_offers` has 0 rows today — no
 * `generateStaticParams`, params are runtime and the body is Suspense-wrapped
 * (cacheComponents rule, same shape as `filings/[filingId]`). Per the brief,
 * an unresolved slug renders `EmptyState awaitingFeed` here (not `notFound()`)
 * because the whole tier is pre-launch, not because this one record is
 * missing — same treatment as the pipeline page.
 *
 * The design mock's "Financials snapshot" (FY23–FY25E revenue/EBITDA/net
 * income) has no backing column on `ipo_offers` — omitted rather than
 * fabricated. Everything else on this page maps to a real column.
 */

type Params = { offerSlug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { offerSlug } = await params;
  const offer = await getIpoOffer(offerSlug);
  if (!offer) return { title: "IPO Center" };
  return {
    title: `${offer.companyName} — IPO`,
    description: `${offer.companyName} (${venueName(offer.venueCode)}) IPO — pricing, offer facts and subscription window.`,
  };
}

export default function IpoOfferPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-10 sm:px-8">
      <Suspense fallback={<OfferFallback />}>
        <IpoOfferBody params={params} />
      </Suspense>
    </div>
  );
}

function OfferFallback() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-40 animate-pulse bg-hairline-soft" />
      <div className="h-9 w-2/3 animate-pulse bg-hairline" />
      <div className="h-64 animate-pulse bg-hairline-soft" />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-b border-hairline px-3.5 py-3">
      <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{label}</div>
      <div className="mt-1 font-mono text-[13px] font-semibold text-ink">{value}</div>
    </div>
  );
}

/** `use_of_proceeds` / `brokers` are arbitrary jsonb with no confirmed shape
 * (0 live rows to verify against) — rendered defensively as data. */
function JsonList({ data, empty }: { data: unknown; empty: string }) {
  if (data == null) {
    return <p className="mt-2 font-ui text-[12px] text-ink-faint">{empty}</p>;
  }
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((v, i) => [String(i + 1), v])
    : typeof data === "object"
      ? Object.entries(data as Record<string, unknown>)
      : [["value", data]];
  const render = (v: unknown): string => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <dl className="mt-2 divide-y divide-hairline-faint border-y border-hairline-faint">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-start gap-4 py-2">
          <dt className="w-[120px] flex-none font-mono text-[9.5px] tracking-[0.04em] text-ink-muted uppercase">{k}</dt>
          <dd className="min-w-0 flex-1 break-words font-ui text-[12px] text-ink">{render(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

async function IpoOfferBody({ params }: { params: Promise<Params> }) {
  const { offerSlug } = await params;
  const offer = await getIpoOffer(offerSlug);

  if (!offer) {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
          <Link href="/ipo" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
            IPO Center
          </Link>
          <span className="text-ink-faint">/</span>
          <span className="text-ink-faint">Offer</span>
        </div>
        <div className="mt-6">
          <EmptyState
            variant="awaitingFeed"
            title="This listing isn't tracked yet"
            body="IPO detail pages populate once the listings producer job lands and this offer is ingested. Check the pipeline for what's currently tracked."
            action={
              <Link href="/ipo" className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper">
                ← Back to IPO Center
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const pageUrl = `${siteUrl()}/ipo/${ipoOfferSlug(offer)}`;
  const bucket = classifyIpoStage(offer.stage);
  const stageLabel =
    bucket === "subscription_open"
      ? "Subscription open"
      : bucket === "bookbuilding"
        ? "Bookbuilding · institutional"
        : bucket === "listed"
          ? "Listed"
          : "Announced & filed";

  const priceRange =
    offer.priceRangeLow != null && offer.priceRangeHigh != null
      ? `${offer.localCurrency} ${offer.priceRangeLow}–${offer.priceRangeHigh}`
      : offer.finalPrice != null
        ? `${offer.localCurrency} ${offer.finalPrice}`
        : "TBD";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Corporation",
    name: offer.companyName,
    url: pageUrl,
    ...(offer.ticker ? { tickerSymbol: offer.ticker } : {}),
  };

  return (
    <article>
      <JsonLd data={jsonLd} />

      <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
        <Link href="/ipo" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
          IPO Center
        </Link>
        <span className="text-ink-faint">/</span>
        <span className="text-ink-mid">{offer.companyName}</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {offer.ticker ? (
          <span className="border border-ink px-2 py-[3px] font-mono text-[11px] font-semibold">{offer.ticker}</span>
        ) : null}
        <span className="font-display text-[26px] font-bold tracking-[-0.01em] text-ink">{offer.companyName}</span>
        <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-faint uppercase">
          {venueName(offer.venueCode)}
        </span>
        <span className="ml-auto bg-ink px-2.5 py-[5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
          {stageLabel}
        </span>
      </div>

      {/* Simplified timeline — only the date fields the schema actually carries
          (no announced/bookbuilt dates on ipo_offers). */}
      <div className="mt-4 flex flex-wrap border border-hairline">
        <div className="flex-1 border-r border-hairline px-4 py-2.5">
          <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Retail subscription</div>
          <div className="mt-0.5 font-ui text-[11px] font-semibold text-ink">
            {offer.retailOpenAt && offer.retailCloseAt
              ? `${fmtDate(offer.retailOpenAt)} – ${fmtDate(offer.retailCloseAt)}`
              : "Not yet scheduled"}
          </div>
        </div>
        <div className="flex-1 border-r border-hairline px-4 py-2.5">
          <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Refunds by</div>
          <div className="mt-0.5 font-ui text-[11px] font-semibold text-ink">
            {offer.refundsBy ? fmtDate(offer.refundsBy) : "—"}
          </div>
        </div>
        <div className="flex-1 px-4 py-2.5">
          <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Expected listing</div>
          <div className="mt-0.5 font-ui text-[11px] font-semibold text-ink">
            {offer.expectedListing ? fmtDate(offer.expectedListing) : "—"}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Offer facts
          </div>
          <div className="grid grid-cols-2 border-t border-l border-hairline sm:grid-cols-4">
            <Fact label="Price range" value={priceRange} />
            <Fact
              label="Offer size"
              value={
                offer.offerSizePct != null
                  ? `${offer.offerSizePct}%${offer.sharesOffered != null ? ` · ${(offer.sharesOffered / 1e9).toFixed(2)}bn sh` : ""}`
                  : "—"
              }
            />
            <Fact label="Raise" value={offer.raiseAmount == null ? "—" : `≈ $${(offer.raiseAmount / 1e6).toFixed(0)}M`} />
            <Fact label="Implied mkt cap" value={offer.impliedMcap == null ? "—" : `$${(offer.impliedMcap / 1e6).toFixed(0)}M`} />
            <Fact label="Retail tranche" value={offer.retailTranchePct == null ? "—" : `${offer.retailTranchePct}%`} />
            <Fact
              label="Min lot"
              value={
                offer.minLot == null
                  ? "—"
                  : (() => {
                      // Cost uses final_price once priced; before that, the top of
                      // the range (matches how the subscription-open example prices it).
                      const px = offer.finalPrice ?? offer.priceRangeHigh;
                      return `${offer.minLot} sh${px != null ? ` · ${offer.localCurrency} ${(offer.minLot * px).toFixed(2)}` : ""}`;
                    })()
              }
            />
            <Fact label="Dividend policy" value={offer.dividendPolicy ?? "—"} />
            <Fact label="Refunds by" value={offer.refundsBy ? fmtDate(offer.refundsBy) : "—"} />
          </div>

          <div className="mt-7 border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Use of proceeds
          </div>
          <JsonList data={offer.useOfProceeds} empty="Not disclosed yet." />

          <div className="mt-7 border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Implied multiples
          </div>
          <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Implied P/E (top)" value={offer.impliedPe == null ? "—" : `${offer.impliedPe.toFixed(1)}×`} />
            <Fact label="Implied yield (top)" value={offer.impliedYield == null ? "—" : `${offer.impliedYield.toFixed(1)}%`} />
            <Fact label="Object state" value={offer.objectState || "—"} />
          </div>
        </div>

        <aside>
          <div className="bg-ink px-4 py-4 text-paper-tint">
            <div className="font-mono text-[8px] tracking-[0.14em] text-hairline-strong uppercase">
              Retail subscription
            </div>
            <div className="mt-2 font-ui text-[12.5px] font-semibold">
              {offer.retailCloseAt ? `Closes ${fmtDateTime(offer.retailCloseAt)} UTC` : "Not yet scheduled"}
            </div>
            {offer.prospectusFilingId ? (
              <Link
                href={`/filings/${offer.prospectusFilingId}`}
                className="mt-3 block border border-paper-tint px-3 py-2 text-center font-ui text-[11px] font-semibold uppercase hover:bg-dark-panel-alt"
              >
                Prospectus filing →
              </Link>
            ) : null}
          </div>

          <div className="mt-5">
            <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Participating brokers
            </div>
            <JsonList data={offer.brokers} empty="No brokers listed yet." />
          </div>

          <div className="mt-5">
            <PremiumLock
              variant="inline"
              title="Marsad take"
              teaser="Fair-value read and subscribe/pass call — Premium."
            />
          </div>
        </aside>
      </div>
    </article>
  );
}

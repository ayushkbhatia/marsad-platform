import { Suspense } from "react";
import Link from "next/link";
import { buildLedgerMarkets, buildLedgerEditorial } from "@/lib/data/adapters/ledger";
import { LedgerLeadStory } from "@/components/reader/ledger/LeadStory";
import { LedgerSecondaryStories } from "@/components/reader/ledger/SecondaryStories";
import { LiveMarketsRail } from "@/components/reader/ledger/LiveMarketsRail";
import { LedgerWireRail } from "@/components/reader/ledger/WireRail";
import { LedgerMovers } from "@/components/reader/ledger/LedgerMovers";
import { SectionBar, PromoCard, EmptyState } from "@/components/ui";

/**
 * Ledger front page — design screen 1b, the canonical Home / Today. A
 * broadsheet split: an editorial main column (lead story + 2×3 secondary grid +
 * analyst-calls row) beside a 372px data rail (live markets, the wire, movers,
 * the Marsad Select teaser), divided by a 1px ink rule.
 *
 * BRIDGE P2 — the page is now HALF REAL, and the split is deliberate:
 *
 * - **Data rail = REAL** (`adapters/ledger.ts`): index levels from
 *   `index_levels`, movers from `mv_movers`/`quotes_latest`, the Live Markets
 *   focus card from `getIndexTape` + `getMarketState`, and its sparkline from
 *   `index_levels_daily`. Every mover now links to its real stock page — the
 *   sample shipped `href="#"` on all of them.
 * - **Editorial column = REAL** as of bridge P3 (`adapters/ledger.ts`): the lead
 *   and secondary stories come from published `content_items` and link to real
 *   `/articles/[slug]` pages. When nothing is published the column says so
 *   rather than showing sample headlines that link nowhere.
 * - **The analyst-calls row is GONE, not sampled.** `analyst_calls` is 0 rows,
 *   and the owner ruled against seeding fictional analysts issuing price targets
 *   on real securities. It returns when real analysts are onboarded
 *   (DEF-ANALYSTS-LIVE-DATA).
 * - **The macro row is EMPTY, not sampled** — no commodity/rates/FX producer
 *   exists, and a fabricated Brent print on a markets product is the most
 *   damaging possible placeholder (DEF-LEDGER-MACRO-SOURCE).
 *
 * The market rail reads are `use cache`, so the route still prerenders; the rail
 * sits behind its own `<Suspense>` so a slow read never blocks the masthead.
 */
export default function LedgerFrontPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-6 pb-[30px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_372px]">
          {/* Main column — REAL published desk content. */}
          <section className="lg:border-r lg:border-hairline lg:pr-[30px]">
            <Suspense fallback={<EditorialFallback />}>
              <EditorialColumn />
            </Suspense>
          </section>

          {/* Data rail — REAL market data. */}
          <aside className="mt-10 flex flex-col lg:mt-0 lg:pl-[26px]">
            <Suspense fallback={<MarketRailFallback />}>
              <MarketRail />
            </Suspense>

            <PromoCard
              className="mt-5"
              label="Marsad Select"
              headline="Five AI-ranked Gulf names for H2, rebalanced monthly."
              body="Premium members see the full list and every rebalance note."
              ctaText="Unlock with Premium"
              disabled
              hint="Subscription required"
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function EditorialFallback() {
  return (
    <div aria-hidden>
      <div className="h-[300px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-6 h-6 w-3/4 animate-pulse bg-hairline" />
    </div>
  );
}

async function EditorialColumn() {
  const e = await buildLedgerEditorial();

  if (!e.lead) {
    return (
      <EmptyState
        variant="awaitingFeed"
        title="No desk pieces published yet"
        body="The lead story and the day's reporting appear here as the desk publishes. Market data in the rail is live now."
      />
    );
  }

  return (
    <>
      <LedgerLeadStory lead={e.lead} />
      {e.secondary.length > 0 ? <LedgerSecondaryStories items={e.secondary} /> : null}
    </>
  );
}

function MarketRailFallback() {
  return (
    <div aria-hidden>
      <div className="h-4 w-32 animate-pulse bg-hairline-soft" />
      <div className="mt-2 h-[150px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 h-[120px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function MarketRail() {
  const m = await buildLedgerMarkets();

  return (
    <>
      <section>
        <SectionBar
          variant="rule"
          label="Live markets"
          right={
            m.live ? (
              <span
                className={`font-mono text-[9.5px] tracking-[0.08em] ${
                  m.live.open ? "text-positive" : "text-ink-faint"
                }`}
              >
                ● {m.live.open ? "OPEN" : "CLOSED"}
              </span>
            ) : null
          }
        />
        {m.live ? (
          <LiveMarketsRail live={m.live} />
        ) : (
          <EmptyState
            variant="awaitingFeed"
            title="Index levels unavailable"
            body="The GCC index feed has not reported yet. Levels appear here as soon as the poller lands them."
          />
        )}
      </section>

      <section className="mt-[18px]">
        <SectionBar
          variant="rule"
          label="The wire"
          right={
            <Link
              href="/wire"
              className="font-ui text-[11px] font-semibold text-ink-muted underline underline-offset-[3px] hover:text-ink"
            >
              All items →
            </Link>
          }
        />
        {m.wires.length > 0 ? (
          <div className="mt-1">
            <LedgerWireRail items={m.wires} />
          </div>
        ) : (
          <EmptyState variant="awaitingFeed" title="No filings yet" body="Exchange filings appear here as they land." />
        )}
      </section>

      <section className="mt-[18px]">
        <SectionBar variant="rule" label="Movers" />
        {m.gainers.length > 0 || m.losers.length > 0 ? (
          <LedgerMovers gainers={m.gainers} losers={m.losers} />
        ) : (
          <EmptyState variant="awaitingFeed" title="No movers yet" body="Ranked movers appear once quotes report." />
        )}
      </section>
    </>
  );
}

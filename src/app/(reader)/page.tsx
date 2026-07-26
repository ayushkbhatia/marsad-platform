import { Suspense } from "react";
import Link from "next/link";
import { SAMPLE_LEDGER } from "@/lib/data/sample/ledger";
import { buildLedgerMarkets } from "@/lib/data/adapters/ledger";
import { LedgerLeadStory } from "@/components/reader/ledger/LeadStory";
import { LedgerSecondaryStories } from "@/components/reader/ledger/SecondaryStories";
import { LedgerAnalystCalls } from "@/components/reader/ledger/AnalystCalls";
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
 * - **Editorial column = still SAMPLE** (lead, secondary, analyst calls). It
 *   becomes real in bridge P3, when `content_items` and `analyst_calls` carry
 *   seeded desk content. Until then it is clearly a placeholder rather than
 *   another entity's copy.
 * - **The macro row is EMPTY, not sampled** — no commodity/rates/FX producer
 *   exists, and a fabricated Brent print on a markets product is the most
 *   damaging possible placeholder (DEF-LEDGER-MACRO-SOURCE).
 *
 * The market rail reads are `use cache`, so the route still prerenders; the rail
 * sits behind its own `<Suspense>` so a slow read never blocks the masthead.
 */
export default function LedgerFrontPage() {
  const d = SAMPLE_LEDGER;

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-6 pb-[30px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_372px]">
          {/* Main column — lead, secondary grid, analyst calls. STILL SAMPLE (P3). */}
          <section className="lg:border-r lg:border-hairline lg:pr-[30px]">
            <LedgerLeadStory lead={d.lead} />
            <LedgerSecondaryStories items={d.secondary} />
            <LedgerAnalystCalls calls={d.calls} />
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

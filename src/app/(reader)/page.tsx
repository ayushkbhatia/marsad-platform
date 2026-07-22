import { Suspense } from "react";
import Link from "next/link";
import { getIndexTape, getTopMovers, getMarketState } from "@/lib/data/markets";
import { getGlobalFilings } from "@/lib/data/filings";
import { listNewsroomContent } from "@/lib/data/newsroom";
import { IndexTape } from "@/components/reader/IndexTape";
import { LedgerLeadStory } from "@/components/reader/ledger/LeadStory";
import { LedgerSecondaryStories } from "@/components/reader/ledger/SecondaryStories";
import { LedgerWireRail } from "@/components/reader/ledger/WireRail";
import { LedgerMovers } from "@/components/reader/ledger/LedgerMovers";
import { SectionBar, PromoCard, EmptyState } from "@/components/ui";

/**
 * Ledger front page — design screen 1b. A broadsheet split running the full
 * page: an editorial main column (the newsroom's lead WIRE at hero weight,
 * `text-article-title`, plus its remaining wires as a two-up story grid,
 * `border-r`) beside a 372px data rail (live index tape, the filings wire,
 * top movers, a Marsad Select teaser) — "From the newsroom" is still the
 * first place a reader sees the agent pipeline's own output
 * (03-agent-newsroom.md), just reshaped into 1b's lead-story slot instead of
 * a separate hero + card section.
 *
 * "Analyst calls today" (1b's fourth main-column module) is deliberately not
 * built here — there is no analyst-call data source in this codebase yet
 * (RatingBadge/ScoreModule cover a security's *current* score, not a dated
 * call feed), and fabricating one would violate the reader's empty-state law.
 * Parked as DEF-LEDGER-ANALYST-CALLS (`docs/BUILD-STATUS.md` §7).
 *
 * Sync page = static shell (just the max-width container). The request-time
 * reads (quotes for movers, the wire, the index tape, the newsroom wires,
 * market open/closed) stream inside a <Suspense> boundary so the route never
 * blocks on a dynamic read (cacheComponents blocking-route rule) — the stock
 * page / admin lake / Markets-page pattern. `getMarketState()` in particular
 * reads the current wall clock (not `use cache`), which is exactly why it's
 * documented as safe to call from "Markets/Ledger bodies" in markets.ts.
 */
export default function LedgerFrontPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <Suspense fallback={<LedgerSkeleton />}>
        <LedgerBody />
      </Suspense>
    </div>
  );
}

function LedgerSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_372px]">
      <div className="space-y-3">
        <div className="h-[220px] w-full animate-pulse bg-hairline-soft" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 w-full animate-pulse bg-hairline-soft" />
        ))}
      </div>
      <div className="h-[520px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function LedgerBody() {
  const [tape, movers, wire, newsroomWires, marketState] = await Promise.all([
    getIndexTape(),
    getTopMovers(6),
    getGlobalFilings(undefined, 6),
    listNewsroomContent({ contentTypes: ["WIRE"], limit: 7 }),
    getMarketState(),
  ]);

  const tapeVenues = [...new Set(tape.map((t) => t.venueCode))];
  const tapeSeed = tape.map((t) => ({
    code: t.code,
    name: t.name,
    venueCode: t.venueCode,
    level: t.level,
    change: t.change,
    changePct: t.changePct,
  }));

  const [lead, ...secondary] = newsroomWires;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_372px] lg:gap-0">
      {/* Main column — the newsroom lead + its remaining wires */}
      <section className="lg:border-r lg:border-hairline lg:pr-[30px]">
        {lead ? (
          <LedgerLeadStory item={lead} />
        ) : (
          <div className="border-b border-ink pb-6">
            <EmptyState
              variant="awaitingFeed"
              title="The newsroom hasn't published today."
              body="The autonomous pipeline publishes here the moment its first wire clears rules."
            />
          </div>
        )}

        {secondary.length > 0 ? <LedgerSecondaryStories items={secondary} /> : null}
      </section>

      {/* Data rail — live markets, the filings wire, movers, the Select teaser */}
      <aside className="flex flex-col gap-6 lg:pl-[26px]">
        <section>
          <SectionBar
            variant="rule"
            label="Live markets"
            right={
              <span
                className={`font-mono text-[9.5px] tracking-[0.08em] ${
                  marketState.anyOpen ? "text-positive" : "text-ink-faint"
                }`}
              >
                ● {marketState.anyOpen ? "OPEN" : "CLOSED"}
              </span>
            }
          />
          <div className="mt-3">
            <IndexTape initial={tapeSeed} venues={tapeVenues} />
          </div>
        </section>

        <section>
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
          <div className="mt-1">
            <LedgerWireRail items={wire.items} emptyLabel="No filings on the wire yet." />
          </div>
        </section>

        <section>
          <SectionBar variant="rule" label="Movers" />
          <LedgerMovers gainers={movers.gainers} losers={movers.losers} />
        </section>

        <PromoCard
          label="Marsad Select"
          headline="Five AI-ranked Gulf names for H2, rebalanced monthly."
          body="Premium members see the full list and every rebalance note."
          ctaText="Unlock with Premium"
          disabled
          hint="Subscription required"
        />
      </aside>
    </div>
  );
}

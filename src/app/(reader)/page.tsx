import Link from "next/link";
import { SAMPLE_LEDGER } from "@/lib/data/sample/ledger";
import { LedgerLeadStory } from "@/components/reader/ledger/LeadStory";
import { LedgerSecondaryStories } from "@/components/reader/ledger/SecondaryStories";
import { LedgerAnalystCalls } from "@/components/reader/ledger/AnalystCalls";
import { LiveMarketsRail } from "@/components/reader/ledger/LiveMarketsRail";
import { LedgerWireRail } from "@/components/reader/ledger/WireRail";
import { LedgerMovers } from "@/components/reader/ledger/LedgerMovers";
import { SectionBar, PromoCard } from "@/components/ui";

/**
 * Ledger front page — design screen 1b, the canonical Home / Today. A
 * broadsheet split: an editorial main column (lead story + 2×3 secondary
 * grid + analyst-calls row) beside a 372px data rail (live markets, the wire,
 * movers, the Marsad Select teaser), divided by a 1px ink rule.
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/ledger.ts`) — a
 * point-in-time snapshot rendering the page as it will look in production so
 * the design can be validated pixel-for-pixel. The real connectors (newsroom
 * wires, analyst calls, index levels, filings wire, movers) plug in by
 * mapping their DB reads onto that module's view-model types and swapping
 * `SAMPLE_LEDGER` here; the components below never see a DB shape, so the swap
 * is a one-file change. Fully static today (no request-time reads), so the
 * route prerenders with the shell.
 */
export default function LedgerFrontPage() {
  const d = SAMPLE_LEDGER;

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-6 pb-[30px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_372px]">
          {/* Main column — lead, secondary grid, analyst calls. */}
          <section className="lg:border-r lg:border-hairline lg:pr-[30px]">
            <LedgerLeadStory lead={d.lead} />
            <LedgerSecondaryStories items={d.secondary} />
            <LedgerAnalystCalls calls={d.calls} />
          </section>

          {/* Data rail — live markets, the wire, movers, the Select teaser. */}
          <aside className="mt-10 flex flex-col lg:mt-0 lg:pl-[26px]">
            <section>
              <SectionBar
                variant="rule"
                label="Live markets"
                right={
                  <span
                    className={`font-mono text-[9.5px] tracking-[0.08em] ${
                      d.live.open ? "text-positive" : "text-ink-faint"
                    }`}
                  >
                    ● {d.live.open ? "OPEN" : "CLOSED"}
                  </span>
                }
              />
              <LiveMarketsRail live={d.live} />
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
              <div className="mt-1">
                <LedgerWireRail items={d.wires} />
              </div>
            </section>

            <section className="mt-[18px]">
              <SectionBar variant="rule" label="Movers" />
              <LedgerMovers gainers={d.gainers} losers={d.losers} />
            </section>

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

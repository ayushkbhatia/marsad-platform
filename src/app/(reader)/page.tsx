import { Suspense } from "react";
import Link from "next/link";
import { getIndexTape, getTopMovers } from "@/lib/data/markets";
import { getGlobalFilings } from "@/lib/data/filings";
import { listNewsroomContent } from "@/lib/data/newsroom";
import { IndexTape } from "@/components/reader/IndexTape";
import { TopMovers } from "@/components/reader/TopMovers";
import { FilingsList } from "@/components/reader/FilingsList";
import { WireCard } from "@/components/reader/newsroom/WireCard";
import { SectionBar, EmptyState } from "@/components/ui";

/**
 * Ledger front page (1b) — the reader's home, inside the (reader) editorial
 * shell. Leads with the autonomous newsroom's own published WIRE(s) when any
 * exist ("From the newsroom" — the first place a reader sees the agent
 * pipeline's output, 03-agent-newsroom.md), then MARKET DATA + the filings
 * wire: the index tape, the latest disclosures, and top movers, with routes
 * into /markets, /wire and the stock pages.
 *
 * Sync page = static shell (the masthead). The request-time reads (quotes for
 * movers, the wire, the index tape, the newsroom wires) stream inside a
 * <Suspense> boundary so the shell prerenders and the whole route never
 * blocks on a dynamic read (cacheComponents blocking-route rule) — the stock
 * page / admin lake pattern.
 */
export default function LedgerFrontPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      {/* Masthead line (static shell) */}
      <header className="mb-6 border-b-2 border-ink pb-4">
        <p className="font-mono text-[9px] tracking-[0.22em] text-ink-faint uppercase">
          The Ledger · Independent GCC market research
        </p>
        <h1 className="mt-2 max-w-[760px] font-display text-heading-lg font-bold leading-[1.1] text-ink">
          Gulf markets, read closely.
        </h1>
        <p className="mt-2 max-w-[620px] font-ui text-[13.5px] leading-[1.55] text-ink-muted">
          Delayed prices, disclosures, and the Marsad Score across Tadawul, DFM, ADX, QE, MSX and
          BHB. No noise — the filings wire and the tape, first.
        </p>
      </header>

      <Suspense fallback={<LedgerSkeleton />}>
        <LedgerBody />
      </Suspense>
    </div>
  );
}

function LedgerSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-[260px] w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

async function LedgerBody() {
  const [tape, movers, wire, newsroomWires] = await Promise.all([
    getIndexTape(),
    getTopMovers(6),
    getGlobalFilings(undefined, 10),
    listNewsroomContent({ contentTypes: ["WIRE"], limit: 3 }),
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

  return (
    <>
      {/* From the newsroom — the autonomous pipeline's own published wires */}
      <section className="mb-8">
        <SectionBar label="From the newsroom" right={<Link href="/wire" className="hover:underline underline-offset-2">Full newswire →</Link>} />
        {newsroomWires.length > 0 ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {newsroomWires.map((item) => (
              <WireCard key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState
              title="The newsroom hasn't published today."
              body="The autonomous pipeline publishes here the moment its first wire clears rules."
            />
          </div>
        )}
      </section>

      {/* Index tape */}
      <section className="mb-8">
        <IndexTape initial={tapeSeed} venues={tapeVenues} />
      </section>

      {/* Wire + movers */}
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <section>
          <div className="mb-2 flex items-baseline justify-between border-b border-hairline pb-1.5">
            <h2 className="font-display text-heading-sm font-semibold text-ink">On the wire</h2>
            <Link
              href="/wire"
              className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
            >
              Full newswire →
            </Link>
          </div>
          <FilingsList items={wire.items} showTicker showSummary emptyLabel="No filings on the wire yet." />
        </section>

        <aside className="flex flex-col gap-8">
          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-hairline pb-1.5">
              <h2 className="font-display text-heading-sm font-semibold text-ink">Movers</h2>
              <Link
                href="/markets"
                className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
              >
                Markets →
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-6">
              <TopMovers gainers={movers.gainers} losers={movers.losers} />
            </div>
          </section>

          <section className="border border-hairline bg-paper p-4">
            <h3 className="font-mono text-[10px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
              Explore
            </h3>
            <ul className="mt-2 flex flex-col gap-1.5 font-ui text-[13px] text-ink">
              <li>
                <Link href="/markets" className="hover:underline underline-offset-2">
                  → Markets front (tape · heatmap · movers)
                </Link>
              </li>
              <li>
                <Link href="/wire" className="hover:underline underline-offset-2">
                  → Filings newswire
                </Link>
              </li>
              <li>
                <Link href="/screener" className="hover:underline underline-offset-2">
                  → Equity screener
                </Link>
              </li>
              <li>
                <Link href="/filings" className="hover:underline underline-offset-2">
                  → Filings register
                </Link>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}

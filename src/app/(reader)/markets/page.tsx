import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getIndexTape,
  getVenueFreshness,
  getMarketState,
  getSectorHeatmap,
  getTopMovers,
  type VenueFreshness,
  type VenueMarketState,
} from "@/lib/data/markets";
import { IndexTape } from "@/components/reader/IndexTape";
import { SectorHeatmap } from "@/components/reader/SectorHeatmap";
import { TopMovers } from "@/components/reader/TopMovers";
import { FreshnessBadge, type FreshnessState } from "@/components/ui";
import { toBadgeState } from "@/lib/market/freshness";
import { fmtClock } from "@/lib/reader/format";

/**
 * Markets front (2b) — the index-tape strip, per-venue freshness, a sector
 * breadth heatmap, and top movers. Every read is a `use cache` reader over
 * anon-RLS public tables (no premium data). The whole page prerenders as a
 * static shell holding the last cached snapshot; the index strip is a client
 * island that re-lights from `/api/pulse/indices`.
 *
 * Honest degradation: `public.index_levels` is empty today, so the tape renders
 * names + "awaiting data"; a `closed` venue reads DELAYED (never "live").
 */

const MARKETS_TITLE = "Markets";
const MARKETS_DESCRIPTION =
  "Index levels, venue freshness, sector breadth and top movers across the six GCC venues — delayed data.";

export const metadata: Metadata = {
  title: MARKETS_TITLE,
  description: MARKETS_DESCRIPTION,
  openGraph: {
    title: MARKETS_TITLE,
    description: MARKETS_DESCRIPTION,
    images: [{ url: "/api/og/markets", width: 1200, height: 630, alt: MARKETS_TITLE }],
  },
  twitter: { card: "summary_large_image", title: MARKETS_TITLE, description: MARKETS_DESCRIPTION, images: ["/api/og/markets"] },
};

/** Floor a feed block to a badge state that can never read "live" (delayed product). */
function delayedState(state: string | null | undefined): FreshnessState {
  const s = toBadgeState(state);
  return s === "live" ? "delayed" : s;
}

function MarketStateChip({ st }: { st: VenueMarketState | undefined }) {
  if (!st) return null;
  if (st.isHoliday) {
    return (
      <span className="border border-caution px-1.5 py-px font-mono text-[8.5px] tracking-[0.08em] text-caution-text uppercase">
        Holiday{st.holidayName ? ` · ${st.holidayName}` : ""}
      </span>
    );
  }
  if (st.isOpen) {
    return (
      <span className="bg-positive-fill px-1.5 py-px font-mono text-[8.5px] font-semibold tracking-[0.08em] text-paper-tint uppercase">
        Open
      </span>
    );
  }
  return (
    <span className="border border-hairline-strong px-1.5 py-px font-mono text-[8.5px] tracking-[0.08em] text-ink-muted uppercase">
      Closed{st.opensLocal ? ` · opens ${st.opensLocal}` : ""}
    </span>
  );
}

function VenueCard({
  fresh,
  state,
}: {
  fresh: VenueFreshness;
  state: VenueMarketState | undefined;
}) {
  const clock = fmtClock(fresh.lastSync);
  return (
    <div className="flex flex-col gap-2 border border-hairline bg-paper px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-[13px] font-semibold text-ink">
          {fresh.venueName ?? fresh.venue}
        </span>
        <span className="font-mono text-[9px] text-ink-faint">{fresh.venue}</span>
      </div>
      <MarketStateChip st={state} />
      <FreshnessBadge
        state={delayedState(fresh.state)}
        surface="light"
        detail={clock ? `SYNCED ${clock} UTC` : fresh.detail ?? undefined}
      />
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between border-b border-hairline pb-1.5">
      <h2 className="font-display text-heading-sm font-semibold text-ink">{title}</h2>
      {hint ? <span className="font-mono text-[10px] text-ink-faint">{hint}</span> : null}
    </div>
  );
}

/**
 * Sync page = static shell. Under cacheComponents the request-time reads
 * (getMarketState reads the current time; the quotes/heatmap/movers reads are
 * request-time) must live inside a <Suspense> boundary so the shell prerenders
 * and the data streams — awaiting them in the page body would block the whole
 * route (blocking-route insight). Mirrors the stock page / admin lake pattern.
 */
export default function MarketsPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="mb-5">
        <h1 className="font-display text-heading font-bold text-ink">Markets</h1>
        <p className="mt-1 font-ui text-[13px] text-ink-muted">
          Six GCC venues — Tadawul, DFM, ADX, QE, MSX and BHB. All data delayed at least 15 minutes.
        </p>
      </header>

      <Suspense fallback={<MarketsSkeleton />}>
        <MarketsBody />
      </Suspense>
    </div>
  );
}

function MarketsSkeleton() {
  return (
    <div className="space-y-9">
      <div className="h-[70px] w-full animate-pulse bg-hairline-soft" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[92px] animate-pulse bg-hairline-soft" />
        ))}
      </div>
      <div className="h-[160px] w-full animate-pulse bg-hairline-soft" />
      <div className="h-[220px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function MarketsBody() {
  const [tape, freshness, marketState, heatmap, movers] = await Promise.all([
    getIndexTape(),
    getVenueFreshness(),
    getMarketState(),
    getSectorHeatmap(),
    getTopMovers(8),
  ]);

  const stateByVenue = new Map<string, VenueMarketState>();
  for (const v of marketState.venues) stateByVenue.set(v.venueCode, v);

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
      {/* Index tape */}
      <section className="mb-9">
        <SectionHead
          title="Index tape"
          hint={marketState.anyOpen ? "some venues open" : "all venues closed"}
        />
        <IndexTape initial={tapeSeed} venues={tapeVenues} />
      </section>

      {/* Venue freshness */}
      <section className="mb-9">
        <SectionHead title="Venue freshness" hint="scrape-only · delayed" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {freshness.map((v) => (
            <VenueCard key={v.venue} fresh={v} state={stateByVenue.get(v.venue)} />
          ))}
          {freshness.length === 0 ? (
            <p className="col-span-full border border-dashed border-hairline px-4 py-8 text-center font-mono text-[11px] text-ink-faint">
              No venue feed status reported.
            </p>
          ) : null}
        </div>
        <p className="mt-2 font-mono text-[9px] tracking-[0.04em] text-ink-faint">
          Boursa Kuwait — coming soon.
        </p>
      </section>

      {/* Sector heatmap */}
      <section className="mb-9">
        <SectionHead title="Sector breadth" hint="avg change% · weighted by count" />
        <SectorHeatmap cells={heatmap} />
      </section>

      {/* Top movers */}
      <section>
        <SectionHead title="Top movers" hint={`${movers.universe.toLocaleString("en-US")} quoted names`} />
        <TopMovers gainers={movers.gainers} losers={movers.losers} />
        <div className="mt-4">
          <Link
            href="/screener"
            className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
          >
            Open the screener →
          </Link>
        </div>
      </section>
    </>
  );
}

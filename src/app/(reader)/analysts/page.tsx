import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { loadCoverageDesk } from "@/lib/data/adapters/analysts";
import { CoverageDesk } from "@/components/reader/analysts/CoverageDesk";
import { EmptyState } from "@/components/ui";

/**
 * The Coverage Desk — design screen 1i. The analyst leaderboard master page:
 * a ranked leaderboard, a "Latest from the desk" research strip, and a sidebar
 * (ratings changes, coverage by sector, request-coverage vote). Every
 * leaderboard row links to `/analysts/{slug}` — the 1j profile template.
 *
 * NO SAMPLE HERE ANY MORE (build-plan step **P3.5**). This page used to render
 * `COVERAGE_DESK` — six named analysts with win rates, follower counts and
 * price targets on real listed companies. Owner ruling 2026-07-27: Marsad does
 * not publish invented people making invented investment calls. `analysts` and
 * `analyst_calls` are both 0 rows (measured against the live DB the same day),
 * so the desk reads live through `adapters/analysts.ts` and renders the honest
 * `EmptyState variant="awaitingFeed"` until a real roster is onboarded. The
 * adapter is fixture-tested (`adapters/__tests__/analysts.test.ts`), so the
 * leaderboard lights up with no further front-end change.
 */
export const metadata: Metadata = {
  title: "The Coverage Desk",
  description: "Marsad's analyst leaderboard — every GCC call tracked, scored against the venue index, and public.",
};

export default function AnalystsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <Suspense fallback={<DeskFallback />}>
          <DeskBody />
        </Suspense>
      </div>
    </div>
  );
}

async function DeskBody() {
  // "Ratings changes — this week" is measured against the wall clock, so the
  // read happens HERE, behind `connection()`, and is passed into the adapter as
  // an ISO string — never read inside a `use cache` scope, where one caller's
  // "today" would freeze into a shared cache entry (CONVENTIONS §3).
  await connection();
  const nowISO = new Date().toISOString().slice(0, 10);
  const desk = await loadCoverageDesk(nowISO);

  if (!desk) {
    return (
      <>
        <div className="flex flex-wrap items-baseline gap-4 border-b-2 border-ink pb-3.5">
          <span className="font-display text-[27px] font-bold text-ink">The Coverage Desk</span>
          <span className="text-[12px] text-ink-muted">
            Every Marsad call — tracked, scored against its venue index, and public.
          </span>
        </div>
        <EmptyState
          className="mt-6"
          variant="awaitingFeed"
          title="The coverage desk is launching."
          body="Marsad publishes analyst track records only for real, onboarded analysts — no placeholder names, no invented calls. Leaderboard positions and individual analyst pages appear here as soon as the first analysts are onboarded and their calls start closing."
        />
      </>
    );
  }

  return <CoverageDesk data={desk} />;
}

function DeskFallback() {
  return (
    <div>
      <div className="h-8 w-72 animate-pulse bg-hairline" />
      <div className="mt-5 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_360px]">
        <div className="h-80 w-full animate-pulse bg-hairline-soft" />
        <div className="h-80 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

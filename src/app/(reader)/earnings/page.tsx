import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getEarningsLedger } from "@/lib/data/adapters/earnings-calendar";
import { EarningsCalendar } from "@/components/reader/calendars/EarningsCalendar";
import { EmptyState } from "@/components/ui";

/**
 * Earnings calendar — design screen 8a, wired to real `public.earnings_events`
 * (build-plan step **P2.3**) via `data/adapters/earnings-calendar.ts`.
 *
 * Real: the tickers, `fiscal_period`, reported EPS and prior EPS. Not real, and
 * therefore rendered as "—" with a note on the surface: street consensus and the
 * Marsad desk estimate (`eps_consensus`/`eps_marsad` NULL on all 9,180 rows,
 * `public.estimates` empty — DEF-ESTIMATES-AGG / plan P7.3), plus the
 * BEAT/MISS verdict and surprise/reaction figures. The day grouping is an
 * INGEST stamp, not a reporting calendar (DEF-EARNINGS-REPORTDATE) — the ledger
 * labels it "RECORDED <date>" and says so in the note.
 *
 * The body is dynamic: `getEarningsKpis`/`getEarningsAhead` take ISO date
 * bounds so the cached reads stay deterministic, which means the CALLER does the
 * wall-clock read — hence `connection()` here and a `<Suspense>` boundary above
 * it (cacheComponents rule, same shape as `earnings/[eventId]`).
 */
export const metadata: Metadata = {
  title: "Earnings Calendar",
  description:
    "GCC earnings prints on file — reported EPS by company and fiscal period. Street consensus and desk estimates are not published yet.",
};

export default function EarningsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <Suspense fallback={<EarningsFallback />}>
          <EarningsBody />
        </Suspense>
      </div>
    </div>
  );
}

async function EarningsBody() {
  // `connection()` marks the clock read below as the deliberate dynamic read it
  // is; the cached calendar reads then receive plain ISO strings.
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const weekAheadISO = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  const data = await getEarningsLedger({ todayISO, weekAheadISO });

  if (!data) {
    return (
      <div className="px-7 pt-[22px] pb-[30px]">
        <div className="border-b-2 border-ink pb-3.5">
          <span className="font-display text-[27px] font-bold text-ink">Earnings calendar</span>
        </div>
        <EmptyState
          className="mt-6"
          variant="awaitingFeed"
          title="No earnings prints are readable yet"
          body="Nothing is being shown in place of them — this page fills itself in as soon as the earnings feed returns rows."
        />
      </div>
    );
  }

  return <EarningsCalendar data={data} />;
}

function EarningsFallback() {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-56 animate-pulse bg-hairline" />
      </div>
      <div className="mt-4 h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-9 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-[300px] animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

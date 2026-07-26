import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import {
  getDividendCalendar,
  getDividendKpis,
  getDividendYieldLeaders,
  getDividendsAhead,
} from "@/lib/data/calendars";
import { toDividendWeek } from "@/lib/data/adapters/dividends-calendar";
import { DividendCalendar } from "@/components/reader/calendars/DividendCalendar";
import { EmptyState } from "@/components/ui";

/**
 * Dividend calendar — design screen 23a, wired to the real `public.dividends`
 * reads (build-plan step **P2.4**) via `data/adapters/dividends-calendar.ts`.
 *
 * HONESTLY EMPTY, ON PURPOSE. Measured against the live DB 2026-07-26:
 * 1,229 rows, **0** with an `ex_date`, **0** at `state='live'` — and the
 * `world_read` policy filters on `state`, so as `anon` the table returns **0
 * rows**. There is no ex-date ledger to draw. This page used to render the
 * sample week (Aramco / Salik / QNBK / "Najm Insurance") which would have
 * shipped fabricated declarations as if they were real; per Law #2 it now
 * renders `EmptyState variant="awaitingFeed"` instead. No `withSampleFallback`
 * here — a known-empty producer is exactly the case that helper must not cover.
 *
 * The adapter is fully written and fixture-tested
 * (`src/lib/data/adapters/__tests__/dividends-calendar.test.ts`), so the
 * calendar lights up with no further front-end change the moment the dividend
 * confirmation producer lands (plan P7.1 / DEF-DIVIDENDS-CONFIRM).
 *
 * The body is dynamic: `getDividendKpis`/`getDividendsAhead` take ISO date
 * bounds so the cached reads stay deterministic, which means the CALLER does
 * the wall-clock read — hence `connection()` and a `<Suspense>` boundary above
 * it (CONVENTIONS §3, same shape as `/earnings` and `/filings`).
 */
export const metadata: Metadata = {
  title: "Dividend Calendar",
  description:
    "GCC ex-dates, payouts and yields by day. No dividend on file carries a confirmed ex-date yet — the ledger fills in when the confirmation feed lands.",
};

export default function DividendsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <Suspense fallback={<DividendsFallback />}>
          <DividendsBody />
        </Suspense>
      </div>
    </div>
  );
}

async function DividendsBody() {
  // `connection()` marks the clock read below as the deliberate dynamic read it
  // is; the cached calendar reads then receive plain ISO strings.
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const weekAheadISO = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  const [calendar, ahead, yieldLeaders, kpis] = await Promise.all([
    getDividendCalendar(),
    getDividendsAhead({ todayISO }),
    getDividendYieldLeaders(),
    getDividendKpis({ todayISO, weekAheadISO }),
  ]);

  const data = toDividendWeek({ calendar, ahead, yieldLeaders, kpis });
  if (data) return <DividendCalendar data={data} />;

  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">Dividend calendar</span>
        <span className="text-[12px] text-ink-muted">Ex-dates, payouts and yields across GCC venues</span>
      </div>

      <EmptyState
        className="mt-6"
        variant="awaitingFeed"
        title="No dividend has a confirmed ex-date yet"
        body="Marsad holds 1,229 declared dividends, but not one of them carries a confirmed ex-date, record date or pay date — so there is no day-by-day ledger to publish. Nothing is being shown in its place. The calendar, the yield leaders and the ex-date reminders all fill themselves in the moment the confirmation feed publishes dated declarations."
      />

      <p className="mt-4 font-mono text-[9px] leading-[1.6] tracking-[0.02em] text-ink-faint">
        Dividend dates are sourced from venue disclosures and registrar records. Marsad does not
        estimate an ex-date, a pay date or a yield it has not seen published.
      </p>
    </div>
  );
}

function DividendsFallback() {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-56 animate-pulse bg-hairline" />
      </div>
      <div className="mt-4 h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-40 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

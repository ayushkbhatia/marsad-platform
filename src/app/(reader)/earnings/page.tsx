import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import {
  getEarningsCalendar,
  getEarningsAhead,
  getEarningsKpis,
  type EarningsEventItem,
} from "@/lib/data/calendars";
import { SectionBar, StatStrip, EmptyState } from "@/components/ui";
import { fmtSignedPct, venueName } from "@/lib/reader/format";

/**
 * Earnings calendar (8a) — day-ledger grouped by `report_date`, most-recent
 * first. Ground truth (verified against the live DB, see
 * `src/lib/data/calendars.ts` header): the 4190-row table is entirely
 * historical (max report_date 2026-07-19, zero future rows) and
 * eps_consensus/eps_marsad/verdict/surprise_pct are NULL on every row — no
 * estimates producer has landed yet. This page is therefore built as a real
 * reporting LOG (actual vs prior, y/y, confirmed/estimated date status) rather
 * than fabricating a consensus column that doesn't exist; the "ahead" rail and
 * KPI counts are wired against `report_date >= today` and will light up the
 * moment forward-scheduled events are ingested.
 *
 * Sync page = static shell; the wall-clock read ("today", for the ahead
 * split + KPIs) happens in the dynamic `<Suspense>` child via `connection()`
 * (cacheComponents rule) — the market page / stock page pattern.
 */

const EARNINGS_TITLE = "Earnings calendar";
const EARNINGS_DESCRIPTION =
  "The GCC reporting calendar — confirmed and estimated report dates, actuals vs prior, across all six venues.";

export const metadata: Metadata = {
  title: EARNINGS_TITLE,
  description: EARNINGS_DESCRIPTION,
  openGraph: {
    title: EARNINGS_TITLE,
    description: EARNINGS_DESCRIPTION,
    images: [{ url: "/api/og/earnings", width: 1200, height: 630, alt: EARNINGS_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: EARNINGS_TITLE,
    description: EARNINGS_DESCRIPTION,
    images: ["/api/og/earnings"],
  },
};

type Search = { cursor?: string };

export default function EarningsPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">Earnings calendar</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">
          The GCC reporting log — report dates, actuals and prior-period EPS
        </p>
        <div className="ml-auto flex gap-2">
          <span className="border border-hairline-strong px-3 py-1.5 font-ui text-[11px] font-semibold text-ink-muted">
            Watchlist only
          </span>
          <span className="border border-ink px-3 py-1.5 font-ui text-[11px] font-semibold text-ink">
            Add to calendar
          </span>
        </div>
      </header>

      <Suspense fallback={<EarningsSkeleton />}>
        <EarningsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function EarningsSkeleton() {
  return (
    <div className="mt-4 space-y-4">
      <div className="h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-[300px] animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function fmtDayBand(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ROW_GRID = "grid grid-cols-[64px_1fr_58px_64px_64px_58px_78px] items-center gap-[10px]";

function DateStatusTag({ state }: { state: string }) {
  const confirmed = state === "confirmed";
  return (
    <span
      className={`text-right font-mono text-[8px] font-semibold tracking-[0.06em] uppercase ${
        confirmed ? "text-positive" : "text-ink-faint"
      }`}
    >
      {confirmed ? "● Confirmed" : "○ Estimated"}
    </span>
  );
}

function EarningsHeaderRow() {
  return (
    <div className={`${ROW_GRID} border-b border-hairline px-3 pt-1.5 pb-1`}>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Ticker</span>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Company</span>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Period</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Actual</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Prior</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Y/Y</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Date</span>
    </div>
  );
}

function EarningsRow({ r }: { r: EarningsEventItem }) {
  const yoyColor = r.epsYoyPct == null ? "text-ink-faint" : r.epsYoyPct >= 0 ? "text-positive" : "text-negative";
  return (
    <Link
      href={`/earnings/${r.id}`}
      className={`${ROW_GRID} border-b border-hairline-faint px-3 py-[9px] text-ink hover:bg-paper-tint`}
    >
      <span className="font-mono text-[11px] font-semibold">{r.ticker}</span>
      <span className="flex items-baseline gap-[7px] overflow-hidden">
        <span className="truncate text-[12px]">{r.name}</span>
        <span className="flex-none border border-hairline-soft px-1 py-px font-mono text-[7.5px] text-ink-faint">
          {r.venueCode}
        </span>
      </span>
      <span className="font-mono text-[10px] text-ink-muted">{r.fiscalPeriod}</span>
      <span className="text-right font-mono text-[11px] font-semibold tabular-nums">
        {r.epsActual == null ? "—" : r.epsActual.toFixed(2)}
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-ink-muted">
        {r.epsPrior == null ? "—" : r.epsPrior.toFixed(2)}
      </span>
      <span className={`text-right font-mono text-[10.5px] font-semibold tabular-nums ${yoyColor}`}>
        {fmtSignedPct(r.epsYoyPct)}
      </span>
      <DateStatusTag state={r.dateState} />
    </Link>
  );
}

async function EarningsBody({ searchParams }: { searchParams: Promise<Search> }) {
  // cacheComponents requires a dynamic source read before the wall clock — see
  // src/lib/data/markets.ts getMarketState for the same gate.
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const weekAheadISO = addDaysISO(todayISO, 7);

  const { cursor } = await searchParams;

  const [calendar, ahead, kpis] = await Promise.all([
    getEarningsCalendar({ cursor }),
    getEarningsAhead({ todayISO, limit: 8 }),
    getEarningsKpis({ todayISO, weekAheadISO }),
  ]);

  const latestFlat = calendar.days.flatMap((d) => d.rows).slice(0, 6);

  return (
    <>
      <StatStrip
        className="mt-4"
        items={[
          { label: "Confirmed dates", value: kpis.confirmedDates.toLocaleString("en-US") },
          { label: "Estimated dates", value: kpis.estimatedDates.toLocaleString("en-US") },
          { label: "Reporting today", value: kpis.reportingToday.toLocaleString("en-US") },
          { label: "Ahead this week", value: kpis.aheadThisWeek.toLocaleString("en-US") },
        ]}
      />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        {/* Main day-ledger */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
              Most recent first
            </span>
            <span className="ml-auto font-mono text-[9px] text-ink-faint">
              EPS in local ccy · Y/Y = actual vs prior period
            </span>
          </div>

          {calendar.days.length === 0 ? (
            <EmptyState
              variant="empty"
              title="No reporting days in range"
              body="No earnings events matched this window."
            />
          ) : (
            calendar.days.map((day) => (
              <div key={day.date} className="mt-2.5">
                <SectionBar
                  label={fmtDayBand(day.date)}
                  right={`${day.count} EVENT${day.count === 1 ? "" : "S"}`}
                />
                {/* ROW_GRID is a fixed-px 7-column track (~450px min) — narrower
                    than a 390px mobile viewport. Scope the scroll to this row
                    region (not the page) so mobile gets a normal, single-axis
                    page instead of the whole layout overflowing horizontally
                    (WCAG 1.4.10 Reflow). The day-band label above stays put. */}
                <div className="overflow-x-auto">
                  <EarningsHeaderRow />
                  {day.rows.map((r) => (
                    <EarningsRow key={r.id} r={r} />
                  ))}
                </div>
              </div>
            ))
          )}

          {calendar.nextCursor ? (
            <div className="mt-5 flex justify-center">
              <Link
                href={`/earnings?cursor=${encodeURIComponent(calendar.nextCursor)}`}
                className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
              >
                Older reports →
              </Link>
            </div>
          ) : null}
        </div>

        {/* Right rail */}
        <div className="border-l border-hairline pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Ahead
            </span>
          </div>
          {ahead.length === 0 ? (
            <p className="mt-3 border border-dashed border-hairline px-3 py-6 text-center font-mono text-[10.5px] leading-relaxed text-ink-faint">
              No confirmed or estimated report dates ahead of today yet — the ledger below is fully
              historical until forward dates are scheduled.
            </p>
          ) : (
            ahead.map((r) => (
              <Link
                key={r.id}
                href={`/earnings/${r.id}`}
                className="block border-b border-hairline-faint py-2.5 text-ink hover:bg-paper-tint"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] font-semibold">{r.ticker}</span>
                  <span className="truncate font-ui text-[11px] text-ink-mid">{r.name}</span>
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-faint">
                  {fmtDayBand(r.reportDate)} · {r.fiscalPeriod}
                </div>
              </Link>
            ))
          )}

          <div className="mt-6 flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Latest prints
            </span>
          </div>
          {latestFlat.length === 0 ? (
            <p className="mt-3 font-mono text-[10.5px] text-ink-faint">No recent prints.</p>
          ) : (
            latestFlat.map((r) => (
              <Link
                key={r.id}
                href={`/earnings/${r.id}`}
                className="block border-b border-hairline-faint py-2.5 text-ink hover:bg-paper-tint"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] font-semibold">{r.ticker}</span>
                  <span className="truncate font-ui text-[11px] text-ink-mid">{r.name}</span>
                  {r.epsYoyPct != null ? (
                    <span
                      className={`ml-auto font-mono text-[10px] font-semibold ${
                        r.epsYoyPct >= 0 ? "text-positive" : "text-negative"
                      }`}
                    >
                      {fmtSignedPct(r.epsYoyPct)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-faint">
                  {fmtDayBand(r.reportDate)} · EPS {r.epsActual == null ? "—" : r.epsActual.toFixed(2)}
                  {r.venueCode ? ` · ${venueName(r.venueCode)}` : ""}
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </>
  );
}

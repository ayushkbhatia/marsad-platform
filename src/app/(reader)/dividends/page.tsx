import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import {
  getDividendCalendar,
  getDividendsAhead,
  getDividendYieldLeaders,
  getDividendKpis,
  type DividendItem,
} from "@/lib/data/calendars";
import { SectionBar, StatStrip, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/reader/format";

/**
 * Dividend calendar (23a) — day-ledger grouped by EX-DATE, pay-date a column,
 * SPECIAL div_type flagged, payout_ratio > 1 flagged as cut-risk.
 *
 * Ground truth (verified live, see `src/lib/data/calendars.ts` header): anon
 * RLS on `dividends` only exposes `state = 'live'` rows — every one of the
 * 1147 rows today is `state = 'pending_confirm'`, so this page legitimately
 * renders zero rows until a confirmation job lands. On top of that `ex_date`
 * is NULL on all rows today, so even a `state='live'` row wouldn't place on
 * this ledger without a backfill. Both gaps are flagged to the lead — the
 * query/grouping/pagination below is correct and will light up unmodified.
 */

const DIVIDENDS_TITLE = "Dividend calendar";
const DIVIDENDS_DESCRIPTION = "Ex-dates, pay dates and yields across the six GCC venues — delayed, confirmed-only.";

export const metadata: Metadata = {
  title: DIVIDENDS_TITLE,
  description: DIVIDENDS_DESCRIPTION,
  openGraph: {
    title: DIVIDENDS_TITLE,
    description: DIVIDENDS_DESCRIPTION,
    images: [{ url: "/api/og/dividends", width: 1200, height: 630, alt: DIVIDENDS_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: DIVIDENDS_TITLE,
    description: DIVIDENDS_DESCRIPTION,
    images: ["/api/og/dividends"],
  },
};

type Search = { cursor?: string };

export default function DividendsPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">Dividend calendar</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">
          Ex-dates, payouts and yields across GCC venues
        </p>
        <div className="ml-auto flex gap-2">
          <span className="border border-hairline-strong px-3 py-1.5 font-ui text-[11px] font-semibold text-ink-muted">
            Watchlist only
          </span>
          <span className="border border-ink px-3 py-1.5 font-ui text-[11px] font-semibold text-ink">
            Export .ics
          </span>
        </div>
      </header>

      <Suspense fallback={<DividendsSkeleton />}>
        <DividendsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function DividendsSkeleton() {
  return (
    <div className="mt-4 space-y-4">
      <div className="h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
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

const ROW_GRID = "grid grid-cols-[64px_1fr_74px_92px_64px_88px] items-center gap-[10px]";

function DivTypeTag({ type }: { type: string }) {
  if (type === "SPECIAL") {
    return (
      <span className="bg-ink px-1.5 py-[3px] font-mono text-[8px] font-semibold text-paper-tint">SPECIAL</span>
    );
  }
  return <span className="border border-hairline-strong px-1.5 py-[2px] font-mono text-[8px] text-ink-muted">{type || "—"}</span>;
}

function DividendHeaderRow() {
  return (
    <div className={`${ROW_GRID} border-b border-hairline px-3 pt-1.5 pb-1`}>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Ticker</span>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Company</span>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Type</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">DPS</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Payout</span>
      <span className="text-right font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">Pay date</span>
    </div>
  );
}

function DividendRow({ r }: { r: DividendItem }) {
  const cutRisk = r.payoutRatio != null && r.payoutRatio > 1;
  return (
    <Link
      href={r.venueCode && r.ticker !== "—" ? `/stocks/${r.venueCode}/${r.ticker}` : "/dividends"}
      className={`${ROW_GRID} border-b border-hairline-faint px-3 py-[9px] text-ink hover:bg-paper-tint`}
    >
      <span className="font-mono text-[11px] font-semibold">{r.ticker}</span>
      <span className="flex items-baseline gap-[7px] overflow-hidden">
        <span className="truncate text-[12px]">{r.name}</span>
        <span className="flex-none border border-hairline-soft px-1 py-px font-mono text-[7.5px] text-ink-faint">
          {r.venueCode}
        </span>
      </span>
      <DivTypeTag type={r.divType} />
      <span className="text-right font-mono text-[11px] tabular-nums">
        {r.dps == null ? "—" : `${r.currency} ${r.dps.toFixed(4)}`}
      </span>
      <span className={`text-right font-mono text-[10.5px] font-semibold tabular-nums ${cutRisk ? "text-negative" : "text-ink-muted"}`}>
        {r.payoutRatio == null ? "—" : `${(r.payoutRatio * 100).toFixed(0)}%${cutRisk ? " ⚠" : ""}`}
      </span>
      <span className="text-right font-mono text-[10px] text-ink-muted">{r.payDate ? fmtDate(r.payDate) : "—"}</span>
    </Link>
  );
}

async function DividendsBody({ searchParams }: { searchParams: Promise<Search> }) {
  // cacheComponents requires a dynamic source read before the wall clock.
  await connection();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const weekAheadISO = addDaysISO(todayISO, 7);

  const { cursor } = await searchParams;

  const [calendar, ahead, yieldLeaders, kpis] = await Promise.all([
    getDividendCalendar({ cursor }),
    getDividendsAhead({ todayISO, limit: 6 }),
    getDividendYieldLeaders(6),
    getDividendKpis({ todayISO, weekAheadISO }),
  ]);

  return (
    <>
      <StatStrip
        className="mt-4"
        items={[
          { label: "Going ex this week", value: kpis.goingExThisWeek.toLocaleString("en-US") },
          { label: "Payouts this week", value: kpis.payoutsThisWeek.toLocaleString("en-US") },
          {
            label: "Median yield",
            value: kpis.medianYieldPct == null ? "—" : `${kpis.medianYieldPct.toFixed(1)}%`,
          },
          { label: "Specials", value: kpis.specials.toLocaleString("en-US") },
        ]}
      />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        {/* Main day-ledger */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
              Most recent ex-date first
            </span>
            <span className="ml-auto font-mono text-[9px] text-ink-faint">
              Own before the ex-date open to receive · DPS in local ccy
            </span>
          </div>

          {calendar.days.length === 0 ? (
            <EmptyState
              variant="awaitingFeed"
              title="No confirmed dividends yet"
              body="Ex-dates publish here once a disclosure is cross-checked and confirmed against the source filing. Nothing has cleared that gate yet."
            />
          ) : (
            calendar.days.map((day) => (
              <div key={day.date} className="mt-2.5">
                <SectionBar label={fmtDayBand(day.date)} right={`${day.count} EX-DATE${day.count === 1 ? "" : "S"}`} />
                {/* ROW_GRID is a fixed-px 6-column track — narrower than a
                    390px mobile viewport. Scope the scroll to this row region
                    (not the page) so mobile gets a normal, single-axis page
                    instead of the whole layout overflowing horizontally
                    (WCAG 1.4.10 Reflow). The day-band label above stays put. */}
                <div className="overflow-x-auto">
                  <DividendHeaderRow />
                  {day.rows.map((r) => (
                    <DividendRow key={r.id} r={r} />
                  ))}
                </div>
              </div>
            ))
          )}

          {calendar.nextCursor ? (
            <div className="mt-5 flex justify-center">
              <Link
                href={`/dividends?cursor=${encodeURIComponent(calendar.nextCursor)}`}
                className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
              >
                Older ex-dates →
              </Link>
            </div>
          ) : null}
        </div>

        {/* Right rail */}
        <div className="border-l border-hairline pl-6">
          <div className="border border-ink bg-paper-tint px-4 py-3.5">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint uppercase">Goes ex soon</div>
            {ahead.length === 0 ? (
              <p className="mt-2 font-ui text-[12px] leading-relaxed text-ink-muted">
                No confirmed ex-dates in the days ahead yet.
              </p>
            ) : (
              <>
                <p className="mt-1.5 font-display text-[15px] font-semibold leading-tight text-ink">
                  {ahead[0].ticker} goes ex {fmtDayBand(ahead[0].exDate ?? "")}
                </p>
                <p className="mt-1 font-ui text-[11px] leading-relaxed text-ink-muted">
                  {ahead.length} name{ahead.length === 1 ? "" : "s"} trade ex in the coming days.
                </p>
              </>
            )}
          </div>

          <div className="mt-6">
            <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
              <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
                Yield leaders · GCC
              </span>
            </div>
            {yieldLeaders.length === 0 ? (
              <p className="mt-3 font-mono text-[10.5px] text-ink-faint">No confirmed yields to rank yet.</p>
            ) : (
              yieldLeaders.map((r) => (
                <div key={r.id} className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5">
                  <span className="w-[52px] flex-none font-mono text-[10px] font-semibold">{r.ticker}</span>
                  <span className="flex-1 truncate font-ui text-[11.5px]">{r.name}</span>
                  <span className="font-mono text-[11px] font-semibold">
                    {r.yieldAtAnnounce == null ? "—" : `${r.yieldAtAnnounce.toFixed(1)}%`}
                  </span>
                </div>
              ))
            )}
            <p className="mt-2 font-mono text-[8px] leading-relaxed text-ink-faint">
              PAYOUT &gt; 100% FLAGGED — DISTRIBUTION EXCEEDS EARNINGS; CUT RISK.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

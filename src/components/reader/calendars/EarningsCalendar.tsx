import Link from "next/link";
import type { EarningsWeek, EarningsRow } from "@/lib/contracts/calendars";
import { KpiStrip, CalendarLedger, ColHead, CompanyCell } from "./CalendarKit";

/**
 * Earnings calendar (design 8a) — a week ledger where the MARSAD desk-estimate
 * column sits beside street consensus and the prior actual, and `Δ EST` is a
 * confirmation STATE (● CONF green vs ○ EST muted), not a number. Right rail:
 * already-reported scorecard + a heavyweight-ahead card. Sample-driven
 * (DEF-CALENDARS-LIVE-DATA).
 */
const COLS = "grid-cols-[70px_1fr_54px_60px_66px_66px_62px_30px]";

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function earningsRow(r: EarningsRow) {
  return (
    <>
      <span className="font-mono text-[11px] font-semibold text-ink">{r.ticker}</span>
      <CompanyCell company={r.company} venue={r.venue} />
      <span
        className={`py-[2px] text-center font-mono text-[8px] font-semibold ${
          r.session === "POST" ? "bg-ink text-paper-tint" : "border border-hairline-strong text-ink-muted"
        }`}
      >
        {r.session}
      </span>
      <span className="text-right font-mono text-[11px] text-ink-muted">{r.consensus}</span>
      <span className="text-right font-mono text-[11px] font-bold text-ink">{r.marsad}</span>
      <span className="text-right font-mono text-[11px] text-ink-faint">{r.prior}</span>
      <span className={`text-right font-mono text-[8px] ${r.confirmed ? "text-positive" : "text-ink-faint"}`}>
        {r.confirmed ? "● CONF" : "○ EST"}
      </span>
      <span className="text-center text-ink-muted">→</span>
    </>
  );
}

export function EarningsCalendar({ data }: { data: EarningsWeek }) {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">Earnings calendar</span>
        <span className="text-[12px] text-ink-muted">The MENA reporting week — consensus vs Marsad estimates</span>
        <div className="ml-auto flex gap-2">
          <span className="cursor-pointer border border-hairline-strong px-[13px] py-[7px] text-[11px] font-semibold text-ink-muted">
            Watchlist only
          </span>
          <span className="cursor-pointer border border-ink px-[13px] py-[7px] text-[11px] font-semibold text-ink">
            Add to calendar
          </span>
        </div>
      </div>

      <KpiStrip kpis={data.kpis} />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px] lg:gap-x-[30px]">
        <CalendarLedger
          weekLabel={data.weekLabel}
          footnote={data.footnote}
          gridCols={COLS}
          rowHref={(r: EarningsRow) => `/stocks/${r.venueCode}/${r.ticker}`}
          days={data.days}
          renderRow={earningsRow}
          headers={
            <>
              <ColHead label="Ticker" />
              <ColHead label="Company" />
              <ColHead label="Session" />
              <ColHead label="Cons." align="right" />
              <ColHead label="MARSAD" align="right" />
              <ColHead label="Prior" align="right" />
              <ColHead label="Δ Est" align="right" />
              <span />
            </>
          }
        />

        <aside className="lg:border-l lg:border-hairline lg:pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Already reported</span>
            <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">Scorecard →</span>
          </div>
          {data.reported.map((r) => (
            <div key={r.ticker} className="cursor-pointer border-b border-hairline-faint py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] font-semibold text-ink">{r.ticker}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{r.company}</span>
                <span className={`font-mono text-[10px] font-semibold ${r.surprisePct < 0 ? "text-negative" : "text-positive"}`}>
                  {fmtPct(r.surprisePct)}
                </span>
              </div>
              <div className="mt-[3px] flex items-baseline gap-2">
                <span className="font-mono text-[8px] text-ink-faint">{r.when}</span>
                <span className={`ml-auto font-mono text-[8.5px] ${r.priceReaction < 0 ? "text-negative" : "text-positive"}`}>
                  {fmtPct(r.priceReaction)}
                </span>
              </div>
            </div>
          ))}

          <div className="mt-[18px] border border-ink bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{data.heavyweight.kicker}</div>
            <div className="mt-[7px] font-display text-[16px] font-semibold leading-[1.3] text-ink">
              {data.heavyweight.headline}
            </div>
            <div className="mt-[5px] text-[11px] leading-[1.5] text-ink-muted">{data.heavyweight.body}</div>
            <Link
              href="/stocks/TDWL/2222"
              className="mt-2 inline-block bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase"
            >
              {data.heavyweight.cta}
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

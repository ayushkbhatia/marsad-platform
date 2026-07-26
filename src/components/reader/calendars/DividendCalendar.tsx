import type { DividendWeek, DividendRow } from "@/lib/data/sample/calendars";
import { KpiStrip, CalendarLedger, ColHead, CompanyCell } from "./CalendarKit";

/**
 * Dividend calendar (design 23a) — a week ledger grouped by EX-DATE (the
 * actionable one). SPECIAL dividends get an inverted type chip; the yield-
 * leaders rail flags payout > 100% red as a cut-risk signal. Right rail:
 * goes-ex-tomorrow, yield leaders, ex-date reminders. Sample-driven
 * (DEF-CALENDARS-LIVE-DATA).
 */
const COLS = "grid-cols-[64px_1fr_76px_96px_64px_90px_34px]";

function dividendRow(r: DividendRow) {
  return (
    <>
      <span className="font-mono text-[11px] font-semibold text-ink">{r.ticker}</span>
      <CompanyCell company={r.company} venue={r.venue} />
      <span>
        <span
          className={`font-mono text-[8px] ${
            r.type === "SPECIAL"
              ? "bg-ink px-1.5 py-0.5 font-semibold text-paper-tint"
              : "border border-hairline-strong px-1.5 py-0.5 text-ink-muted"
          }`}
        >
          {r.type}
        </span>
      </span>
      <span className="text-right font-mono text-[11px] text-ink">{r.dps}</span>
      <span className="text-right font-mono text-[11px] font-bold text-ink">{r.yield}</span>
      <span className="text-right font-mono text-[10px] text-ink-muted">{r.payDate}</span>
      <span className="text-right">
        {r.alertSet ? (
          <span className="bg-ink px-[5px] py-0.5 font-mono text-[8px] text-paper-tint">SET</span>
        ) : (
          <span className="cursor-pointer text-ink-muted">◇</span>
        )}
      </span>
    </>
  );
}

export function DividendCalendar({ data }: { data: DividendWeek }) {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">Dividend calendar</span>
        <span className="text-[12px] text-ink-muted">Ex-dates, payouts and yields across GCC venues</span>
        <div className="ml-auto flex gap-2">
          <span className="cursor-pointer border border-hairline-strong px-[13px] py-[7px] text-[11px] font-semibold text-ink-muted">
            Watchlist only
          </span>
          <span className="cursor-pointer border border-ink px-[13px] py-[7px] text-[11px] font-semibold text-ink">
            Export .ics
          </span>
        </div>
      </div>

      <KpiStrip kpis={data.kpis} />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px] lg:gap-x-[30px]">
        <CalendarLedger
          weekLabel={data.weekLabel}
          footnote={data.footnote}
          gridCols={COLS}
          rowHref={(r: DividendRow) => `/stocks/${r.venueCode}/${r.ticker}`}
          days={data.days}
          renderRow={dividendRow}
          headers={
            <>
              <ColHead label="Ticker" />
              <ColHead label="Company" />
              <ColHead label="Type" />
              <ColHead label="DPS" align="right" />
              <ColHead label="Yield" align="right" />
              <ColHead label="Pay date" align="right" />
              <ColHead label="Alert" align="right" />
            </>
          }
        />

        <aside className="lg:border-l lg:border-hairline lg:pl-6">
          <div className="border border-ink bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{data.goesExTomorrow.kicker}</div>
            <div className="mt-[7px] font-display text-[16px] font-semibold leading-[1.3] text-ink">
              {data.goesExTomorrow.headline}
            </div>
            <div className="mt-[5px] text-[11px] leading-[1.5] text-ink-muted">{data.goesExTomorrow.body}</div>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
              <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Yield leaders · GCC</span>
              <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">Screen →</span>
            </div>
            {data.yieldLeaders.map((y) => (
              <div key={y.ticker} className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5">
                <span className="w-12 flex-none font-mono text-[10px] font-semibold text-ink">{y.ticker}</span>
                <span className="flex-1 text-[11.5px] text-ink-mid">{y.company}</span>
                <span className="font-mono text-[11px] font-bold text-ink">{y.yield}</span>
                <span className={`font-mono text-[7.5px] ${y.payoutRisk ? "text-negative" : "text-ink-faint"}`}>
                  {y.payout}
                </span>
              </div>
            ))}
            <div className="mt-2 font-mono text-[8px] leading-[1.6] text-[#a8a396]">{data.yieldLeadersNote}</div>
          </div>

          <div className="mt-[18px] border border-ink bg-paper-tint px-4 py-3.5">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{data.reminders.kicker}</div>
            <div className="mt-[7px] font-display text-[16px] font-semibold leading-[1.3] text-ink">
              {data.reminders.headline}
            </div>
            <div className="mt-[5px] text-[11px] leading-[1.5] text-ink-muted">{data.reminders.body}</div>
            <span className="mt-2 inline-block cursor-pointer bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">
              {data.reminders.cta}
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

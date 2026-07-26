import Link from "next/link";
import type { EarningsLedgerRow, EarningsLedgerView } from "@/lib/data/adapters/earnings-calendar";
import { KpiStrip, CalendarLedger, ColHead, CompanyCell } from "./CalendarKit";

/**
 * Earnings calendar (design 8a), wired to real `public.earnings_events` rows
 * (build-plan step P2.3).
 *
 * The design's two signature columns — street consensus and the MARSAD desk
 * estimate — have NO data upstream (`eps_consensus` / `eps_marsad` are NULL on
 * all 9,180 rows; `public.estimates` is empty). They are kept in the layout and
 * render "—" so the gap is visible, and the surface carries a note saying they
 * are not published yet. The design's per-row "● CONF / ○ EST" chip is gone:
 * `date_state` qualifies a `report_date` that is itself an ingest stamp, so a
 * green CONFIRMED would assert a company-confirmed reporting date that does not
 * exist. In its place the ledger shows the one column that IS real — the
 * reported EPS actual — plus a single honest state line. See the adapter header
 * for the measured counts behind every one of these calls.
 */
const COLS = "grid-cols-[68px_1fr_62px_54px_60px_58px_60px_28px]";

function earningsRow(r: EarningsLedgerRow) {
  return (
    <>
      <span className="font-mono text-[11px] font-semibold text-ink">{r.ticker}</span>
      <CompanyCell company={r.company} venue={r.venue} />
      <span className="font-mono text-[9px] text-ink-muted">{r.period}</span>
      <span className="text-right font-mono text-[11px] text-ink-faint">{r.consensus}</span>
      <span className="text-right font-mono text-[11px] text-ink-faint">{r.marsad}</span>
      <span className="text-right font-mono text-[11px] text-ink-faint">{r.prior}</span>
      <span className="text-right font-mono text-[11px] font-bold text-ink">{r.actual}</span>
      <span className="text-center text-ink-muted">→</span>
    </>
  );
}

export function EarningsCalendar({ data }: { data: EarningsLedgerView }) {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">{data.title}</span>
        <span className="text-[12px] text-ink-muted">{data.subtitle}</span>
      </div>

      <KpiStrip kpis={data.kpis} />

      <div className="mt-3 border-l-2 border-caution bg-paper-tint px-3.5 py-2.5">
        <span className="font-mono text-[8.5px] font-semibold tracking-[0.16em] text-caution-text uppercase">
          Data note
        </span>
        <p className="mt-1 text-[11.5px] leading-[1.55] text-ink-mid">{data.dataNote}</p>
        <p className="mt-1 text-[11.5px] leading-[1.55] text-ink-mid">{data.stateNote}</p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px] lg:gap-x-[30px]">
        <CalendarLedger
          weekLabel={data.ledgerLabel}
          footnote={data.footnote}
          gridCols={COLS}
          rowHref={(r: EarningsLedgerRow) => `/earnings/${r.eventId}`}
          days={data.days}
          renderRow={earningsRow}
          headers={
            <>
              <ColHead label="Ticker" />
              <ColHead label="Company" />
              <ColHead label="Period" />
              <ColHead label="Cons." align="right" />
              <ColHead label="Marsad" align="right" />
              <ColHead label="Prior" align="right" />
              <ColHead label="Actual" align="right" />
              <span />
            </>
          }
        />

        <aside className="lg:border-l lg:border-hairline lg:pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Latest prints</span>
          </div>
          {data.recent.map((r) => (
            <Link
              key={r.eventId}
              href={`/earnings/${r.eventId}`}
              className="block border-b border-hairline-faint py-2.5 hover:bg-paper-tint"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] font-semibold text-ink">{r.ticker}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{r.company}</span>
                <span className="font-mono text-[10px] font-semibold text-ink">{r.actual}</span>
              </div>
              <div className="mt-[3px] flex items-baseline gap-2">
                <span className="font-mono text-[8px] text-ink-faint">
                  {r.period} · {r.recordedOn}
                </span>
                {r.prior && <span className="ml-auto font-mono text-[8.5px] text-ink-faint">{r.prior}</span>}
              </div>
            </Link>
          ))}

          <div className="mt-[18px] border border-hairline-strong bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint uppercase">Reporting ahead</div>
            {data.ahead.length > 0 ? (
              <div className="mt-2">
                {data.ahead.map((r) => (
                  <Link
                    key={r.eventId}
                    href={`/earnings/${r.eventId}`}
                    className="flex items-baseline gap-2 border-b border-hairline-faint py-1.5 last:border-b-0"
                  >
                    <span className="font-mono text-[10px] font-semibold text-ink">{r.ticker}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{r.company}</span>
                    <span className="font-mono text-[9px] text-ink-faint">{r.period}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mt-[7px] text-[11px] leading-[1.5] text-ink-muted">{data.aheadNote}</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

import Link from "next/link";
import type { IpoPipelineData, PipelineOffer, JustListed } from "@/lib/contracts/ipo";
import { KpiStrip } from "@/components/reader/calendars/CalendarKit";

/**
 * IPO Center pipeline (design 22a) — offers grouped into stage bands
 * (subscription open / bookbuilding / announced), each an ink day-bar-style
 * header over a fixed-track ledger. The RETAIL-CLOSES cell is an ink countdown
 * chip while books are open; COVERED is green when subscribed, muted for
 * institutional-only / undersubscribed. Right rail: just-listed tape + an
 * alert card + how-subscribing-works. Sample-driven (DEF-CALENDARS-LIVE-DATA).
 */
const COLS = "grid-cols-[56px_1fr_136px_80px_112px_74px_22px]";

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function OfferRow({ offer }: { offer: PipelineOffer }) {
  return (
    <div className={`grid ${COLS} items-center gap-2.5 border-b border-hairline-faint px-3 py-[10px] hover:bg-paper-tint`}>
      <span className="font-mono text-[11px] font-semibold text-ink">{offer.ticker}</span>
      <span className="flex items-baseline gap-[7px] overflow-hidden">
        <span className="truncate text-[12px] text-ink">{offer.company}</span>
        <span className="flex-none border border-hairline-soft px-1 py-px font-mono text-[7.5px] text-ink-faint">{offer.venue}</span>
      </span>
      <span className="text-right font-mono text-[10.5px] text-ink-muted">{offer.priceRange}</span>
      <span className="text-right font-mono text-[11px] text-ink">{offer.raise}</span>
      <span className="text-right">
        {offer.closesChip ? (
          <span className="bg-ink px-[7px] py-[3px] font-mono text-[8.5px] font-semibold text-paper-tint">{offer.closes}</span>
        ) : (
          <span className="font-mono text-[10px] text-ink-muted">{offer.closes}</span>
        )}
      </span>
      <span
        className={`text-right font-mono text-[10.5px] ${
          offer.covered === "" ? "" : offer.coveredMuted ? "text-ink-faint" : "font-semibold text-positive"
        }`}
      >
        {offer.covered}
      </span>
      <span className="text-center text-ink-muted">→</span>
    </div>
  );
}

function ColHead({ label, align }: { label: string; align?: "right" | "center" }) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return <span className={`font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase ${a}`}>{label}</span>;
}

function JustListedRow({ item }: { item: JustListed }) {
  return (
    <div className="cursor-pointer border-b border-hairline-faint py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] font-semibold text-ink">{item.ticker}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{item.company}</span>
        <span className="font-mono text-[11px] font-bold text-ink">{item.price}</span>
        <span className={`font-mono text-[9px] font-semibold ${item.changePct < 0 ? "text-negative" : "text-positive"}`}>
          {pct(item.changePct)}
        </span>
      </div>
      <div className="mt-[3px] font-mono text-[8px] text-ink-faint">
        {item.listed} · {item.venue}
      </div>
    </div>
  );
}

export function IpoPipeline({ data }: { data: IpoPipelineData }) {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">IPO Center</span>
        <span className="text-[12px] text-ink-muted">The Gulf listings pipeline — subscriptions, pricing and debuts</span>
        <div className="ml-auto flex gap-2">
          <span className="cursor-pointer border border-hairline-strong px-[13px] py-[7px] text-[11px] font-semibold text-ink-muted">
            Subscription alerts
          </span>
          <span className="cursor-pointer border border-ink px-[13px] py-[7px] text-[11px] font-semibold text-ink">
            Add to calendar
          </span>
        </div>
      </div>

      <KpiStrip kpis={data.kpis} />

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px] lg:gap-x-[30px]">
        <div>
          {data.stages.map((stage, si) => (
            <div key={stage.label}>
              <div className={`flex flex-wrap items-baseline gap-3 bg-ink px-3 py-[7px] text-paper-tint ${si === 0 ? "mt-1" : "mt-4"}`}>
                <span className="font-mono text-[10px] font-semibold tracking-[0.1em]">{stage.label}</span>
                <span className="ml-auto font-mono text-[9px] text-[#a8a396]">{stage.meta}</span>
              </div>
              <div className={`grid ${COLS} gap-2.5 border-b border-hairline px-3 pt-[7px] pb-[5px]`}>
                <ColHead label="Ticker" />
                <ColHead label="Company" />
                <ColHead label="Price range" align="right" />
                <ColHead label="Raise" align="right" />
                <ColHead label="Retail closes" align="right" />
                <ColHead label="Covered" align="right" />
                <span />
              </div>
              {stage.offers.map((offer) => (
                <OfferRow key={`${offer.ticker}-${offer.company}`} offer={offer} />
              ))}
            </div>
          ))}
        </div>

        <aside className="lg:border-l lg:border-hairline lg:pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Just listed</span>
            <Link href="/ipo/listing/bina-modular-construction" className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">
              Debuts →
            </Link>
          </div>
          {data.justListed.map((item) => (
            <JustListedRow key={item.ticker} item={item} />
          ))}

          <div className="mt-5 border border-ink bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{data.neverMiss.kicker}</div>
            <div className="mt-[7px] font-display text-[16px] font-semibold leading-[1.3] text-ink">{data.neverMiss.headline}</div>
            <div className="mt-[5px] text-[11px] leading-[1.5] text-ink-muted">{data.neverMiss.body}</div>
            <span className="mt-2 inline-block cursor-pointer bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">
              {data.neverMiss.cta}
            </span>
          </div>

          <div className="mt-[18px] border border-hairline bg-paper-tint px-4 py-3.5">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint uppercase">How subscribing works</div>
            <ul className="mt-2 flex flex-col gap-1.5 font-ui text-[12px] text-ink-muted">
              {data.howItWorks.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

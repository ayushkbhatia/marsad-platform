import Link from "next/link";
import type { IpoOfferDetail, TimelineStep } from "@/lib/contracts/ipo";

/**
 * IPO offer detail (design 22b) — a stage timeline band, an 8-cell offer-facts
 * grid, use-of-proceeds bars beside a financials snapshot, and a right rail
 * with the retail-close countdown, participating brokers and a premium-gated
 * Marsad Take (blurred behind an unlock). Sample-driven (DEF-CALENDARS-LIVE-DATA).
 */
function TimelineCell({ step }: { step: TimelineStep }) {
  const isCurrent = step.state === "current";
  const diamond = step.state === "done" ? "◆" : step.state === "current" ? "◆" : "◇";
  const diamondColor =
    step.state === "done" ? "text-positive" : step.state === "current" ? "text-paper-tint" : "text-ink-faint";
  return (
    <div
      className={`flex-1 border-r border-hairline px-3.5 py-[11px] last:border-r-0 ${isCurrent ? "bg-ink" : ""} ${
        isCurrent ? "flex-[1.25]" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`text-[9px] ${diamondColor}`}>{diamond}</span>
        <span
          className={`font-mono text-[8px] tracking-[0.1em] uppercase ${isCurrent ? "text-paper-tint" : "text-ink-faint"}`}
        >
          {step.label}
        </span>
      </div>
      <div className={`mt-1 font-ui text-[11px] font-semibold ${isCurrent ? "text-paper-tint" : "text-ink"}`}>
        {step.value}
      </div>
    </div>
  );
}

export function IpoDetail({ data }: { data: IpoOfferDetail }) {
  const fin = data.financials;
  return (
    <div className="px-7 pt-6 pb-10">
      <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
        <Link href="/ipo" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
          IPO Center
        </Link>
        <span className="text-ink-faint">/</span>
        <span className="text-ink-mid">{data.company}</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="border border-ink px-2 py-[3px] font-mono text-[11px] font-semibold text-ink">{data.ticker}</span>
        <span className="font-display text-[30px] font-bold tracking-[-0.01em] text-ink">{data.company}</span>
        <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-faint uppercase">{data.meta}</span>
        <span className="ml-auto bg-[#0f5f31] px-2.5 py-[5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
          {data.statusChip}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap border border-hairline">
        {data.timeline.map((step) => (
          <TimelineCell key={step.label} step={step} />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_340px]">
        <div>
          <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Offer facts
          </div>
          <div className="grid grid-cols-2 border-t border-l border-hairline sm:grid-cols-4">
            {data.facts.map((f) => (
              <div key={f.label} className="border-r border-b border-hairline px-3.5 py-3">
                <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{f.label}</div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-ink">{f.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-7 grid grid-cols-1 gap-7 sm:grid-cols-2">
            <div>
              <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
                Use of proceeds
              </div>
              <div className="mt-3 flex flex-col gap-3">
                {data.useOfProceeds.map((p) => (
                  <div key={p.label}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11.5px] text-ink-mid">{p.label}</span>
                      <span className="font-mono text-[10px] font-semibold text-ink">{p.pct}</span>
                    </div>
                    <div className="mt-1 h-[6px] bg-hairline-soft">
                      <div className="h-full bg-ink" style={{ width: `${p.barWidth}px` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3.5 border-l-2 border-ink bg-paper-tint px-3 py-2.5 text-[10.5px] leading-[1.55] text-ink-muted">
                {data.proceedsNote}
              </div>
            </div>

            <div>
              <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
                Financials snapshot
              </div>
              <div className="mt-1 grid grid-cols-[1fr_46px_46px_50px] border-b border-hairline py-[7px]">
                {fin.periods.map((p, i) => (
                  <span
                    key={p}
                    className={`font-mono text-[8px] tracking-[0.06em] uppercase ${i === 0 ? "text-ink-faint" : "text-right"} ${
                      i === fin.periods.length - 1 ? "font-semibold text-ink" : "text-ink-faint"
                    }`}
                  >
                    {p}
                  </span>
                ))}
              </div>
              {fin.rows.map((r) => {
                const isYield = r.label.toLowerCase().includes("yield");
                return (
                  <div key={r.label} className="grid grid-cols-[1fr_46px_46px_50px] items-baseline border-b border-hairline-faint py-[7px]">
                    <span className="text-[11px] text-ink-mid">{r.label}</span>
                    {r.values.map((v, i) => (
                      <span
                        key={i}
                        className={`text-right font-mono text-[11px] ${
                          i === r.values.length - 1
                            ? isYield
                              ? "font-bold text-positive"
                              : "font-bold text-ink"
                            : "text-ink-muted"
                        }`}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside>
          <div className="bg-ink px-4 py-4 text-paper-tint">
            <div className="font-mono text-[8px] tracking-[0.14em] text-[#a8a396] uppercase">{data.countdown.kicker}</div>
            <div className="mt-1.5 font-display text-[40px] font-bold leading-none">{data.countdown.value}</div>
            <div className="mt-2 font-mono text-[9px] tracking-[0.06em] text-[#a8a396] uppercase">{data.countdown.sub}</div>
            <span className="mt-3.5 block cursor-pointer bg-paper-tint px-3 py-2.5 text-center font-ui text-[12px] font-semibold text-ink">
              {data.countdown.cta}
            </span>
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 font-ui text-[10.5px] text-[#c9c4b6]">
              <span className="inline-block h-3 w-3 border border-[#6b6960]" />
              Remind me before books close
            </label>
          </div>

          <div className="mt-5">
            <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Participating brokers
            </div>
            {data.brokers.map((b) => (
              <div key={b} className="flex items-center justify-between border-b border-hairline-faint py-2.5">
                <span className="text-[12px] text-ink">{b}</span>
                <span className="cursor-pointer font-mono text-[9px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
                  Apply →
                </span>
              </div>
            ))}
          </div>

          <div className="relative mt-5 overflow-hidden border border-ink bg-paper-tint px-[15px] py-[15px]">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-ink">◆</span>
              <span className="font-ui text-[10px] font-bold tracking-[0.16em] text-ink uppercase">Marsad take</span>
              <span className="ml-auto bg-ink px-2 py-[3px] font-mono text-[7.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
                Premium
              </span>
            </div>
            <div className="mt-2.5 select-none blur-[5px]">
              <div className="font-display text-[15px] font-semibold leading-[1.35] text-ink">{data.marsadTake.headline}</div>
              <div className="mt-1.5 text-[11px] leading-[1.5] text-ink-muted">{data.marsadTake.body}</div>
            </div>
            <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-paper-tint via-paper-tint/90 to-transparent pb-[15px] pt-8">
              <span className="cursor-pointer bg-ink px-4 py-2 font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">
                {data.marsadTake.cta}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

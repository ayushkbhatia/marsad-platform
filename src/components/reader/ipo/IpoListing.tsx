import Link from "next/link";
import type { IpoListingData, ListingKpi, ListedPeer } from "@/lib/contracts/ipo";

/**
 * IPO listing-day (design 22c) — the debut session. A 5-cell KPI strip (offer
 * vs opened vs last), an intraday chart with a dashed offer-price reference
 * line, a wire card, the allocation recap, a Marsad Score PENDING card (scores
 * need 90 trading days) and listed peers. Sample-driven (DEF-CALENDARS-LIVE-DATA).
 */
function KpiCell({ k, last }: { k: ListingKpi; last: boolean }) {
  return (
    <div className={`flex-1 px-[18px] py-[13px] ${last ? "" : "border-r border-hairline"}`}>
      <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{k.label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-display text-[26px] font-bold text-ink">{k.value}</span>
        {k.delta ? (
          <span className={`font-mono text-[11px] font-semibold ${k.dir === "down" ? "text-negative" : "text-positive"}`}>
            {k.delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PeerRow({ peer }: { peer: ListedPeer }) {
  return (
    <Link
      href={`/stocks/${peer.venue}/${peer.ticker}`}
      className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5 hover:bg-paper-tint"
    >
      <span className="w-12 flex-none font-mono text-[10px] font-semibold text-ink">{peer.ticker}</span>
      <span className="flex-1 truncate text-[11.5px] text-ink-mid">{peer.company}</span>
      <span className="font-mono text-[11px] font-bold text-ink">{peer.price}</span>
      <span className={`w-11 text-right font-mono text-[9px] font-semibold ${peer.changePct < 0 ? "text-negative" : "text-positive"}`}>
        {peer.changePct > 0 ? "+" : ""}
        {peer.changePct.toFixed(1)}%
      </span>
      <span className="w-[62px] text-right font-mono text-[8px] text-ink-faint">{peer.scoreRating}</span>
    </Link>
  );
}

export function IpoListing({ data }: { data: IpoListingData }) {
  const c = data.chart;
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
        <span className="bg-ink px-2 py-[4px] font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
          Listed today
        </span>
        <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-faint uppercase">{data.meta}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] tracking-[0.06em] text-ink-muted uppercase">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-positive" />
          {data.liveLabel}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap border border-hairline bg-paper-tint sm:flex-nowrap">
        {data.kpis.map((k, i) => (
          <KpiCell key={k.label} k={k} last={i === data.kpis.length - 1} />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_340px]">
        <div>
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">First session · vs offer</span>
            <span className="font-mono text-[9px] text-ink-faint">10:00 — 14:32 GST · 1-MIN</span>
          </div>

          <div className="relative mt-3 border border-hairline bg-paper-tint">
            <svg viewBox="0 0 720 240" preserveAspectRatio="none" className="block h-[240px] w-full">
              {/* offer-price reference (dashed) */}
              <line x1="0" y1={c.offerY} x2="720" y2={c.offerY} stroke="#a8a396" strokeWidth="1" strokeDasharray="4 4" />
              <polyline points={c.points} fill="none" stroke="#1a1a1a" strokeWidth="1.5" />
            </svg>
            <span className="absolute bottom-1.5 right-2.5 font-mono text-[8.5px] tracking-[0.06em] text-ink-faint uppercase">
              {c.offerLabel}
            </span>
            <span
              className="absolute left-2.5 font-mono text-[8.5px] font-semibold tracking-[0.06em] text-positive uppercase"
              style={{ top: `${c.openTop}px` }}
            >
              {c.openLabel}
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] tracking-[0.04em] text-ink-muted uppercase">
            {data.chartCaptions.map((cap, i) => (
              <span key={cap} className={i === 0 ? "text-ink" : ""}>
                {cap}
              </span>
            ))}
          </div>

          <div className="mt-5 border-l-2 border-ink bg-paper-tint px-4 py-3">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{data.wire.kicker}</div>
            <div className="mt-1.5 font-display text-[15px] font-semibold leading-[1.35] text-ink">{data.wire.headline}</div>
            <Link href="/wire" className="mt-2 inline-block font-mono text-[9.5px] font-semibold tracking-[0.06em] text-ink-muted uppercase underline underline-offset-[3px]">
              {data.wire.cta}
            </Link>
          </div>
        </div>

        <aside>
          <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Allocation recap
          </div>
          {data.allocation.map((a) => (
            <div key={a.label} className="flex items-baseline justify-between border-b border-hairline-faint py-2.5">
              <span className="text-[11.5px] text-ink-mid">{a.label}</span>
              <span className="font-mono text-[11px] font-semibold text-ink">{a.value}</span>
            </div>
          ))}

          <div className="mt-5 border border-dashed border-hairline-strong px-[15px] py-[15px]">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-ink-faint">◇</span>
              <span className="font-ui text-[10px] font-bold tracking-[0.16em] text-ink uppercase">Marsad Score · Pending</span>
            </div>
            <div className="mt-2 text-[11px] leading-[1.55] text-ink-muted">{data.scorePending}</div>
            <span className="mt-2.5 inline-block cursor-pointer font-mono text-[9.5px] font-semibold tracking-[0.06em] text-ink-muted uppercase underline underline-offset-[3px]">
              Methodology →
            </span>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
              <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Listed peers</span>
              <Link href="/compare" className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">
                Compare →
              </Link>
            </div>
            {data.listedPeers.map((peer) => (
              <PeerRow key={peer.ticker} peer={peer} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

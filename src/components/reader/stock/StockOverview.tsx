import type { Overview, Peer } from "@/lib/data/sample/stock";

/**
 * Stock Overview tab (design 3a) — a 9-metric key-ratios strip, a 2-column
 * split (About / key-points + Marsad Desk View | a tabbed price chart +
 * Pros/Cons cards), and a peer-comparison table (self-row highlighted).
 * Sample-driven for the fidelity pass (DEF-STOCK-LIVE-DATA).
 */
const PEER_COLS = "grid-cols-[88px_1fr_92px_58px_54px_56px_60px_74px_76px_62px_58px]";

function withFootnotes(text: string) {
  return text.split(/(\[\d+\])/).map((part, i) =>
    /^\[\d+\]$/.test(part) ? (
      <sup key={i} className="cursor-pointer text-[9px] text-ink-muted">
        {part}
      </sup>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ChartTab({ label, active }: { label: string; active?: boolean }) {
  return active ? (
    <span className="cursor-pointer bg-ink px-2 py-[3px] text-[9.5px] font-bold text-paper-tint">{label}</span>
  ) : (
    <span className="cursor-pointer border border-hairline-strong px-2 py-[2.5px] text-[9.5px] text-ink-muted">
      {label}
    </span>
  );
}

function PeerHead({ label, align }: { label: string; align?: "right" | "center" }) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return <span className={`font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase ${a}`}>{label}</span>;
}

function PeerRow({ p }: { p: Peer }) {
  const cell = p.self ? "font-semibold text-ink" : "text-ink-muted";
  return (
    <div
      className={`grid ${PEER_COLS} items-center gap-2.5 border-b border-hairline-faint px-2.5 py-[9px] ${
        p.self ? "border-l-[3px] border-l-ink bg-paper-tint" : "cursor-pointer hover:bg-paper-tint"
      }`}
    >
      <span className={`font-mono text-[10.5px] ${p.self ? "font-bold text-ink" : "font-semibold text-ink"}`}>
        {p.ticker}
      </span>
      <span className={`min-w-0 truncate text-[12px] ${p.self ? "font-bold text-ink" : "text-ink"}`}>{p.company}</span>
      <span className={`text-right text-[11px] font-semibold tabular-nums ${cell}`}>{p.price}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.pe}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.pb}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.yield}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.roe}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.evEbitda}</span>
      <span className={`text-right text-[11px] ${cell}`}>{p.mktCap}</span>
      <span
        className={`text-right text-[11px] font-semibold tabular-nums ${p.ytd.startsWith("−") ? "text-negative" : "text-positive"}`}
      >
        {p.ytd}
      </span>
      <span
        className={`justify-self-center font-mono text-[10px] font-${p.self ? "bold" : "semibold"} ${
          p.self ? "bg-ink px-2 py-[2px] text-paper-tint" : "border border-ink px-[7px] py-px text-ink"
        }`}
      >
        {p.score}
      </span>
    </div>
  );
}

export function StockOverview({ overview: o }: { overview: Overview }) {
  return (
    <div className="px-7 pt-4 pb-[30px]">
      {/* Key ratios. */}
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">Key ratios</span>
        <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">Edit ratios</span>
      </div>
      <div className="grid grid-cols-3 border border-ink sm:grid-cols-5 lg:grid-cols-9">
        {o.keyRatios.map((r, i) => (
          <div key={r.label} className={`px-3 py-2.5 ${i < o.keyRatios.length - 1 ? "border-r border-hairline-soft" : ""}`}>
            <div className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase">{r.label}</div>
            <div className="mt-[3px] text-[15px] font-semibold tabular-nums text-ink">{r.value}</div>
          </div>
        ))}
      </div>

      {/* Split. */}
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1.4fr] lg:gap-x-[30px]">
        {/* Left — about + key points + desk view. */}
        <div>
          <div className="border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
            About · key points
          </div>
          <p className="mt-3 font-display text-[14.5px] leading-[1.62] text-ink-soft">{withFootnotes(o.aboutHtml)}</p>
          <div className="mt-3 flex flex-col gap-[7px]">
            {o.keyPoints.map((k) => (
              <div key={k} className="flex gap-2.5 text-[12.5px] leading-[1.55] text-ink-mid">
                <span className="mt-2 h-1 w-1 flex-none bg-ink" />
                <span>{k}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 border border-hairline bg-paper-tint px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] rotate-45 bg-ink" aria-hidden />
              <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink">MARSAD DESK VIEW</span>
            </div>
            <div className="mt-[7px] font-display text-[13.5px] italic leading-[1.5] text-ink-mid">
              {"“"}
              {o.deskView.quote}
              {"”"}
            </div>
            <div className="mt-1.5 font-mono text-[8.5px] text-ink-faint uppercase">{o.deskView.byline}</div>
          </div>
        </div>

        {/* Right — chart + pros/cons. */}
        <div>
          <div className="flex items-center gap-1 border-b-2 border-ink pb-[7px]">
            <span className="mr-auto font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">Chart</span>
            {o.chartTabs.map((t, i) => (
              <ChartTab key={t} label={t} active={i === 0} />
            ))}
          </div>
          <div className="relative border border-t-0 border-hairline-soft bg-paper">
            <svg width="100%" height="236" viewBox="0 0 800 236" preserveAspectRatio="none" className="block">
              {[47, 94, 141, 188].map((y) => (
                <line key={y} x1="0" y1={y} x2="800" y2={y} stroke="#eceadf" strokeWidth="1" />
              ))}
              <polygon points={o.chart.areaPoints} fill="rgba(20,18,14,.055)" />
              <polyline points={o.chart.linePoints} fill="none" stroke="#14120e" strokeWidth="1.6" />
            </svg>
            <span className="absolute top-2 left-2.5 font-mono text-[8.5px] text-[#a8a396]">{o.chart.note}</span>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className="border border-t-[3px] border-hairline border-t-positive px-[15px] py-3">
              <div className="text-[9.5px] font-bold tracking-[0.16em] text-positive">PROS</div>
              <div className="mt-2 flex flex-col gap-1.5 text-[12px] leading-[1.55] text-ink-mid">
                {o.pros.map((p) => (
                  <span key={p}>— {p}</span>
                ))}
              </div>
            </div>
            <div className="border border-t-[3px] border-hairline border-t-negative px-[15px] py-3">
              <div className="text-[9.5px] font-bold tracking-[0.16em] text-negative">CONS</div>
              <div className="mt-2 flex flex-col gap-1.5 text-[12px] leading-[1.55] text-ink-mid">
                {o.cons.map((c) => (
                  <span key={c}>— {c}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-2 font-mono text-[8.5px] italic text-ink-faint">{o.prosConsNote}</div>
        </div>
      </div>

      {/* Peer comparison. */}
      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-2">
          <span className="font-display text-[20px] font-semibold text-ink">
            Peer comparison{" "}
            <span className="ml-2 font-mono text-[9px] font-normal text-ink-faint">GCC INTEGRATED ENERGY & GAS</span>
          </span>
          <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">
            Open in screener →
          </span>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[860px]">
            <div className={`grid ${PEER_COLS} gap-2.5 border-b border-hairline px-2.5 pt-2 pb-1.5`}>
              <PeerHead label="Ticker" />
              <PeerHead label="Company" />
              <PeerHead label="Price" align="right" />
              <PeerHead label="P/E" align="right" />
              <PeerHead label="P/B" align="right" />
              <PeerHead label="Yield" align="right" />
              <PeerHead label="ROE" align="right" />
              <PeerHead label="EV/EBITDA" align="right" />
              <PeerHead label="Mkt cap" align="right" />
              <PeerHead label="YTD" align="right" />
              <PeerHead label="Score" align="center" />
            </div>
            {o.peers.map((p) => (
              <PeerRow key={p.ticker} p={p} />
            ))}
          </div>
        </div>
        <div className="mt-2 font-mono text-[8.5px] text-ink-faint">{o.peersMedian}</div>
      </div>
    </div>
  );
}

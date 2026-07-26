import Link from "next/link";
import type { AnalystProfile as Profile, CoverageRow } from "@/lib/contracts/analysts";
import { TagChip } from "@/components/reader/research/TagChip";

/**
 * Analyst Profile (1j) — the one reusable track-record layout every 1i
 * leaderboard row routes to. Header (avatar + rank + bio + Follow), a 5-cell
 * stat strip, then a 2-column body: a 24-month cumulative-performance line
 * chart (analyst solid vs venue dashed) + Current coverage table on the left,
 * and a dark Pinned-call card + Published research + Disclosure on the right.
 *
 * Sample-driven for the fidelity pass; the real per-analyst read (bio, stats,
 * chart series, coverage, calls) re-wires later (DEF-ANALYSTS-LIVE-DATA). The
 * chart renders the design's pre-plotted polylines — swap for a real charting
 * library when the series is wired.
 */
const COV_COLS = "grid-cols-[72px_1fr_116px_96px_64px_84px]";

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function CoverageRowLink({ r }: { r: CoverageRow }) {
  return (
    <Link
      href={`/stocks/${r.venueCode}/${r.ticker}`}
      className={`grid ${COV_COLS} items-center gap-3 border-b border-hairline-faint px-2 py-[9.5px] hover:bg-paper-tint`}
    >
      <span className="font-mono text-[11px] font-semibold text-ink">{r.ticker}</span>
      <span className="min-w-0 truncate text-[12.5px] text-ink">{r.company}</span>
      <span className="border border-ink py-[3px] text-center text-[9px] font-bold tracking-[0.08em] text-ink uppercase">
        {r.rating}
      </span>
      <span className="text-right text-[12px] font-semibold tabular-nums text-ink">{r.target}</span>
      <span className="text-right font-mono text-[9.5px] text-ink-faint">{r.since}</span>
      <span
        className={`text-right text-[12px] font-semibold tabular-nums ${r.callReturn < 0 ? "text-negative" : "text-positive"}`}
      >
        {fmtPct(r.callReturn)}
      </span>
    </Link>
  );
}

function LbHeader({ label, align }: { label: string; align?: "right" }) {
  return (
    <span className={`font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase ${align === "right" ? "text-right" : ""}`}>
      {label}
    </span>
  );
}

export function AnalystProfile({ profile }: { profile: Profile }) {
  const c = profile.chart;
  return (
    <>
      {/* Header. */}
      <div className="flex flex-wrap items-center gap-5 border-b-2 border-ink pb-[18px]">
        <span className="grid h-16 w-16 flex-none place-items-center rounded-full border-2 border-ink font-display text-[23px] font-semibold text-ink">
          {profile.initials}
        </span>
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-display text-[31px] font-bold text-ink">{profile.name}</span>
            <span className="bg-ink px-[7px] py-[3px] font-mono text-[9px] font-semibold tracking-[0.1em] text-paper-tint">
              RANK #{profile.rank}
            </span>
          </div>
          <div className="mt-[5px] text-[12.5px] text-ink-muted">{profile.credential}</div>
          <div className="mt-[7px] font-display text-[14px] italic text-ink-mid">{profile.bio}</div>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <span className="cursor-pointer bg-ink px-[18px] py-[9px] font-ui text-[11px] font-bold tracking-[0.08em] text-paper-tint uppercase">
            Follow · {profile.followers}
          </span>
          <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">
            Get new-call alerts
          </span>
        </div>
      </div>

      {/* Stat strip. */}
      <div className="flex flex-wrap border-b border-hairline sm:flex-nowrap">
        {profile.stats.map((s, i) => (
          <div
            key={s.label}
            className={`flex-1 py-[13px] ${i === 0 ? "pr-[18px]" : "px-[18px]"} ${
              i < profile.stats.length - 1 ? "border-r border-hairline" : ""
            }`}
          >
            <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{s.label}</div>
            <div
              className={`mt-[3px] text-[19px] font-semibold ${
                s.dir === "up" ? "text-positive" : s.dir === "down" ? "text-negative" : "text-ink"
              }`}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-y-8 lg:grid-cols-[1fr_360px] lg:gap-x-[30px] lg:gap-y-0">
        {/* Left — chart + coverage. */}
        <div>
          <div className="flex flex-wrap items-baseline gap-3.5">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Cumulative call performance — 24 months
            </span>
            <div className="ml-auto flex items-center gap-3.5 font-mono text-[9px] text-ink-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-[2px] w-4 bg-ink" />
                {c.legendAnalyst}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed border-[#a8a396]" />
                {c.legendVenue}
              </span>
            </div>
          </div>

          <div className="relative mt-2.5 border border-hairline-soft bg-paper">
            <svg
              width="100%"
              height={c.height}
              viewBox={`0 0 ${c.width} ${c.height}`}
              preserveAspectRatio="none"
              className="block"
            >
              {c.gridY.map((y) => (
                <line key={y} x1="0" y1={y} x2={c.width} y2={y} stroke="#eceadf" strokeWidth="1" />
              ))}
              <polyline points={c.venuePoints} fill="none" stroke="#a8a396" strokeWidth="1.6" strokeDasharray="5 5" />
              <polyline points={c.analystPoints} fill="none" stroke="#14120e" strokeWidth="1.8" />
            </svg>
            {c.rightLabels.map((l) => (
              <span
                key={l.text}
                className="absolute right-[6px] font-mono text-[8.5px] text-[#a8a396]"
                style={{ top: l.top }}
              >
                {l.text}
              </span>
            ))}
          </div>
          <div className="flex justify-between px-0.5 pt-1.5 font-mono text-[8.5px] text-[#a8a396]">
            {c.months.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>

          <div className="mt-5 border-t-2 border-ink pt-3">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">Current coverage</span>
            <div className="mt-2 overflow-x-auto">
              <div className="min-w-[620px]">
                <div className={`grid ${COV_COLS} gap-3 border-b border-hairline px-2 pt-[9px] pb-[7px]`}>
                  <LbHeader label="Ticker" />
                  <LbHeader label="Company" />
                  <LbHeader label="Rating" />
                  <LbHeader label="Target" align="right" />
                  <LbHeader label="Since" align="right" />
                  <LbHeader label="Call return" align="right" />
                </div>
                {profile.coverage.map((r) => (
                  <CoverageRowLink key={r.ticker} r={r} />
                ))}
              </div>
            </div>
            <div className="mt-[9px] font-mono text-[9px] text-ink-faint">
              CALL RETURN MEASURED VS VENUE INDEX FROM PUBLICATION DATE · POSITIONS DISCLOSED: NONE
            </div>
          </div>
        </div>

        {/* Sidebar. */}
        <div>
          {/* Pinned call — dark card. */}
          <div className="bg-ink px-[18px] py-4 text-paper-tint">
            <div className="font-mono text-[9px] tracking-[0.16em] text-ink-faint">{profile.pinnedCall.date}</div>
            <div className="mt-[9px] font-display text-[17px] italic leading-[1.45]">
              {"“"}
              {profile.pinnedCall.quote}
              {"”"}
            </div>
            <div className="mt-3 flex gap-2">
              <span className="border border-ink-muted px-2 py-[3px] font-mono text-[9.5px] font-semibold">
                {profile.pinnedCall.ticker}
              </span>
              <span className="py-[3px] font-mono text-[9.5px] text-positive-dark">{profile.pinnedCall.returnSince}</span>
            </div>
          </div>

          {/* Published research. */}
          <div className="mt-[22px] flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Published research
            </span>
            <span className="font-mono text-[9px] text-ink-faint">{profile.publishedCount}</span>
          </div>
          {profile.publishedResearch.map((r) => (
            <Link
              key={r.slug}
              href={`/articles/${r.slug}`}
              className="block border-b border-hairline-faint py-3 hover:bg-paper-tint"
            >
              <TagChip tag={r.tag} />
              <div className="mt-[7px] font-display text-[15.5px] font-semibold leading-[1.32] text-ink">
                {r.headline}
              </div>
              <div className="mt-[5px] font-mono text-[9px] text-ink-faint uppercase">{r.meta}</div>
            </Link>
          ))}

          {/* Disclosure. */}
          <div className="mt-4 border border-hairline bg-paper-tint px-[15px] py-[13px]">
            <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">Disclosure</div>
            <div className="mt-1.5 text-[11px] leading-[1.55] text-ink-muted">{profile.disclosure}</div>
          </div>
        </div>
      </div>
    </>
  );
}

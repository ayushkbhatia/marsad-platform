import Link from "next/link";
import type { CoverageDeskData, LeaderboardAnalyst, RatingChange } from "@/lib/contracts/analysts";
import { TagChip } from "@/components/reader/research/TagChip";

/**
 * Coverage Desk (1i) — the analyst leaderboard master page: a ranked
 * leaderboard (each row → `/analysts/{slug}`, the 1j template), a "Latest
 * from the desk" research strip, and a sidebar (ratings changes, coverage by
 * sector, request-coverage vote).
 *
 * Sample-driven for the fidelity pass (DEF-ANALYSTS-LIVE-DATA); the sort
 * toggle + vote CTA are static design controls.
 */
const LB_COLS = "grid-cols-[26px_1fr_56px_66px_84px_78px_70px_24px]";

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function LbHeader({ label, align }: { label: string; align?: "right" | "center" }) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return <span className={`font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase ${a}`}>{label}</span>;
}

function LeaderboardRow({ a }: { a: LeaderboardAnalyst }) {
  return (
    <Link
      href={`/analysts/${a.slug}`}
      className={`grid ${LB_COLS} items-center gap-3 border-b border-hairline-faint px-2.5 py-[11px] hover:bg-paper-tint`}
    >
      <span className="font-display text-[17px] font-semibold text-[#a8a396]">{a.rank}</span>
      <div className="flex items-center gap-[11px] overflow-hidden">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-full border-[1.5px] border-ink font-display text-[12px] font-semibold text-ink">
          {a.initials}
        </span>
        <div className="overflow-hidden">
          <div className="truncate text-[13px] font-semibold text-ink">{a.name}</div>
          <div className="truncate text-[10.5px] text-ink-faint">{a.focus}</div>
        </div>
      </div>
      <span className="text-right text-[12px] tabular-nums text-ink">{a.names}</span>
      <span className="text-right text-[12px] font-semibold tabular-nums text-ink">{a.winRate}%</span>
      <span className="text-right text-[12.5px] font-semibold tabular-nums text-positive">{fmtPct(a.avgReturn)}</span>
      <div className="flex justify-center gap-[3px]">
        {a.last5.map((w, i) => (
          <span key={i} className={`h-[9px] w-[9px] ${w ? "bg-positive" : "bg-negative"}`} />
        ))}
      </div>
      <span className="text-right font-mono text-[10.5px] text-ink-muted">{a.followers}</span>
      <span className="text-ink-faint">→</span>
    </Link>
  );
}

function RatingRow({ rc }: { rc: RatingChange }) {
  const up = rc.direction === "up";
  return (
    <div className="flex flex-col gap-1 border-b border-hairline-faint py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`border px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.1em] ${
            up ? "border-positive text-positive" : "border-negative text-negative"
          }`}
        >
          {up ? "▲" : "▼"} {rc.type}
        </span>
        <span className="font-mono text-[11px] font-semibold text-ink">{rc.ticker}</span>
        <span className="ml-auto font-mono text-[8.5px] text-[#a8a396]">{rc.date}</span>
      </div>
      <span className="text-[12px] text-ink-mid">{rc.note}</span>
      <span className="font-mono text-[9px] text-ink-faint uppercase">{rc.analyst}</span>
    </div>
  );
}

export function CoverageDesk({ data }: { data: CoverageDeskData }) {
  return (
    <>
      {/* Header. */}
      <div className="flex flex-wrap items-baseline gap-4 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">The Coverage Desk</span>
        <span className="text-[12px] text-ink-muted">{data.subtitle}</span>
        <Link
          href="/analysts/apply"
          className="ml-auto cursor-pointer bg-ink px-4 py-[9px] font-ui text-[11px] font-bold tracking-[0.08em] text-paper-tint uppercase"
        >
          Apply to publish
        </Link>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-y-8 lg:grid-cols-[1fr_360px] lg:gap-x-[30px] lg:gap-y-0">
        {/* Left — leaderboard + latest. */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Leaderboard — trailing 24 months
            </span>
            <div className="flex gap-1">
              <span className="cursor-pointer bg-ink px-[9px] py-[3px] text-[9.5px] font-bold text-paper-tint">
                BY AVG RETURN
              </span>
              <span className="cursor-pointer border border-hairline-strong px-[9px] py-[3px] text-[9.5px] text-ink-muted">
                BY WIN RATE
              </span>
              <span className="cursor-pointer border border-hairline-strong px-[9px] py-[3px] text-[9.5px] text-ink-muted">
                BY FOLLOWERS
              </span>
            </div>
          </div>

          <div className="mt-2.5 overflow-x-auto">
            <div className="min-w-[620px]">
              <div className={`grid ${LB_COLS} gap-3 border-b-2 border-ink px-2.5 pt-2.5 pb-[7px]`}>
                <LbHeader label="#" />
                <LbHeader label="Analyst" />
                <LbHeader label="Names" align="right" />
                <LbHeader label="Win rate" align="right" />
                <LbHeader label="Avg call ret" align="right" />
                <LbHeader label="Last 5" align="center" />
                <LbHeader label="Followers" align="right" />
                <span />
              </div>
              {data.analysts.map((a) => (
                <LeaderboardRow key={a.slug} a={a} />
              ))}
            </div>
          </div>

          <div className="mt-[9px] font-mono text-[9px] text-ink-faint">
            WIN RATE = CALLS BEATING VENUE INDEX OVER HOLDING PERIOD · METHODOLOGY → · GREEN/RED SQUARES = LAST FIVE
            CLOSED CALLS
          </div>

          <div className="mt-5 border-t-2 border-ink pt-3">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Latest from the desk
            </span>
            <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              {data.latest.map((a) => (
                <Link
                  key={a.slug}
                  href={`/articles/${a.slug}`}
                  className="block border border-hairline px-4 py-3.5 hover:bg-paper-tint"
                >
                  <TagChip tag={a.tag} />
                  <div className="mt-2 font-display text-[16px] font-semibold leading-[1.3] text-ink">
                    {a.headline}
                  </div>
                  <div className="mt-2 font-mono text-[9px] text-ink-faint uppercase">{a.byline}</div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar. */}
        <div>
          <div className="border-b-2 border-ink pb-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Ratings changes — this week
            </span>
          </div>
          {data.ratingsChanges.map((rc) => (
            <RatingRow key={`${rc.ticker}-${rc.type}`} rc={rc} />
          ))}

          <div className="mt-[22px] flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Coverage by sector
            </span>
            <span className="font-mono text-[9px] text-ink-faint">{data.totalNames} NAMES</span>
          </div>
          <div className="flex flex-col gap-[9px] pt-3">
            {data.sectors.map((s) => (
              <div key={s.sector} className="flex items-center gap-2.5">
                <span className="w-[88px] flex-none text-[11.5px] text-ink-mid">{s.sector}</span>
                <span className="h-[9px] flex-none bg-ink" style={{ width: s.barWidth }} />
                <span className="font-mono text-[10px] text-ink-muted">{s.count}</span>
              </div>
            ))}
          </div>

          <div className="mt-[22px] border border-ink bg-paper-tint px-4 py-3.5">
            <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">
              Request coverage
            </div>
            <div className="mt-[7px] text-[12px] leading-[1.55] text-ink-mid">
              Premium members vote on the next initiation. Leading this month:{" "}
              <b className="font-semibold text-ink">{data.requestCoverage.leadName}</b> — {data.requestCoverage.votes}{" "}
              votes.
            </div>
            <span className="mt-2.5 inline-block cursor-pointer border border-ink px-[13px] py-[7px] font-ui text-[10.5px] font-bold tracking-[0.08em] uppercase">
              Cast a vote
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

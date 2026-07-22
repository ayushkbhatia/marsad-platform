import Link from "next/link";
import type { ScoreTier, VenueGroup, WatchRow } from "@/lib/data/sample/watchlist";

/**
 * Watchlist (1h) holdings table — a fixed 11-column grid grouped by venue.
 * Each group is a header row (venue + count + today's %) over its holdings:
 * ticker, company (+ Arabic name), price, 1D/1W change, the Marsad Score
 * (three badge tiers), PT upside, next event, an alert bell, and an overflow
 * handle. Rows link to the stock page.
 *
 * Sample-driven for the fidelity pass; the score tier is baked per row in the
 * view-model (design 1h) rather than derived, so the badge treatment matches
 * the source exactly. Real quotes/scores/events re-wire later
 * (DEF-WATCHLIST-LIVE-DATA).
 */
const COLS =
  "grid-cols-[86px_1fr_96px_104px_64px_64px_58px_72px_110px_40px_30px]";

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function ScoreBadge({ score, tier }: { score: number; tier: ScoreTier }) {
  const cls =
    tier === "solid"
      ? "bg-ink px-2 py-[2.5px] font-bold text-paper-tint"
      : tier === "outlined"
        ? "border border-ink px-[7px] py-[1.5px] font-semibold text-ink"
        : "border border-hairline-strong px-[7px] py-[1.5px] text-ink-muted";
  return <span className={`justify-self-center font-mono text-[10.5px] ${cls}`}>{score}</span>;
}

function AlertBell({ armed }: { armed: boolean }) {
  return armed ? (
    <span className="grid h-[18px] w-[18px] justify-self-center place-items-center bg-ink text-[9px] text-paper-tint">
      ●
    </span>
  ) : (
    <span className="grid h-[18px] w-[18px] justify-self-center place-items-center border border-hairline-strong text-[9px] text-[#a8a396]">
      ○
    </span>
  );
}

function Row({ r }: { r: WatchRow }) {
  return (
    <Link
      href={`/stocks/${r.venueCode}/${r.ticker}`}
      className={`grid ${COLS} items-center gap-2.5 border-b border-hairline-faint px-3 py-[8.5px] hover:bg-paper-tint`}
    >
      <span className="font-mono text-[11px] font-semibold text-ink">{r.ticker}</span>
      <span className="min-w-0 truncate text-[12.5px] text-ink">{r.name}</span>
      <span className="min-w-0 truncate font-arabic text-[12px] text-ink-faint">{r.nameAr}</span>
      <span className="text-right text-[12px] tabular-nums text-ink">{r.price}</span>
      <span
        className={`text-right text-[11.5px] font-semibold tabular-nums ${r.chg1d < 0 ? "text-negative" : "text-positive"}`}
      >
        {fmtPct(r.chg1d)}
      </span>
      <span
        className={`text-right text-[11.5px] tabular-nums ${r.chg1w < 0 ? "text-negative" : "text-positive"}`}
      >
        {fmtPct(r.chg1w)}
      </span>
      <ScoreBadge score={r.score} tier={r.scoreTier} />
      <span className="text-right text-[11.5px] font-semibold tabular-nums text-ink">
        {fmtPct(r.ptUpside)}
      </span>
      <span className="font-mono text-[9px] tracking-[0.04em] text-ink-muted">{r.nextEvent}</span>
      <AlertBell armed={r.alertArmed} />
      <span className="text-center text-ink-faint">⋮</span>
    </Link>
  );
}

function HeaderCell({ label, align }: { label: string; align?: "right" | "center" }) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return (
    <span className={`font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase ${a}`}>
      {label}
    </span>
  );
}

export function WatchlistTable({ groups }: { groups: VenueGroup[] }) {
  return (
    <div className="mt-[18px] overflow-x-auto">
      <div className="min-w-[900px]">
        {/* Column header. */}
        <div className={`grid ${COLS} gap-2.5 border-b-2 border-ink px-3 pt-2.5 pb-2`}>
          <HeaderCell label="Ticker" />
          <HeaderCell label="Company" />
          <span />
          <HeaderCell label="Price" align="right" />
          <HeaderCell label="1D" align="right" />
          <HeaderCell label="1W" align="right" />
          <HeaderCell label="Score" align="center" />
          <HeaderCell label="PT upside" align="right" />
          <HeaderCell label="Next event" />
          <HeaderCell label="Alert" align="center" />
          <span />
        </div>

        {/* Venue groups. */}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="flex items-baseline gap-3 border-b border-hairline bg-paper px-3 pt-[11px] pb-1.5">
              <span className="font-mono text-[9.5px] font-semibold tracking-[0.14em] text-ink">
                {g.label}
              </span>
              <span className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint">
                {g.summary}
              </span>
            </div>
            {g.rows.map((r) => (
              <Row key={r.ticker} r={r} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

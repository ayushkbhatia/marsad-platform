import type { AnalystLeaderboardRow } from "@/lib/data/editorial";
import { EmptyState } from "@/components/ui";

/**
 * Coverage Desk leaderboard (server component). `analystPrincipalId` is shown
 * in place of a name — `analysts` has no display-name column and
 * `iam.principals` isn't anon-readable (see `src/lib/data/editorial.ts`
 * header) — a real name will replace this the moment that gap closes. Renders
 * `EmptyState awaitingFeed` when there are no analysts yet (true today).
 */
export function AnalystLeaderboard({ rows }: { rows: AnalystLeaderboardRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        variant="awaitingFeed"
        title="The Coverage Desk hasn't published yet"
        body="No analysts are onboarded and no calls are tracked today. This leaderboard is wired to public.analysts + public.analyst_calls and will populate the moment the desk goes live."
      />
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[26px_1fr_64px_84px_78px_64px] gap-3 border-b-2 border-ink px-2 pt-2 pb-1.5">
        <span className="font-mono text-[9px] text-ink-faint">#</span>
        <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">Analyst</span>
        <span className="text-right font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">Names</span>
        <span className="text-right font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">Win rate</span>
        <span className="text-right font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">Avg return</span>
        <span className="text-center font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">Last 5</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.analystPrincipalId}
          className="grid grid-cols-[26px_1fr_64px_84px_78px_64px] items-center gap-3 border-b border-hairline-faint px-2 py-2.5"
        >
          <span className="font-display text-[16px] font-semibold text-ink-faint">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate font-ui text-[12.5px] font-semibold text-ink">
              {r.title ?? "Analyst"} · {r.analystPrincipalId.slice(0, 8)}
            </div>
          </div>
          <span className="text-right font-mono text-[11.5px] tabular-nums text-ink">{r.namesCovered}</span>
          <span className="text-right font-mono text-[11.5px] font-semibold tabular-nums text-ink">
            {r.winRatePct == null ? "—" : `${r.winRatePct.toFixed(0)}%`}
          </span>
          <span
            className={`text-right font-mono text-[11.5px] font-semibold tabular-nums ${
              r.avgCallReturnPct == null ? "text-ink-faint" : r.avgCallReturnPct >= 0 ? "text-positive" : "text-negative"
            }`}
          >
            {r.avgCallReturnPct == null ? "—" : `${r.avgCallReturnPct >= 0 ? "+" : ""}${r.avgCallReturnPct.toFixed(1)}%`}
          </span>
          <div className="flex justify-center gap-[3px]">
            {r.lastFive.length === 0 ? (
              <span className="font-mono text-[9px] text-ink-faint">—</span>
            ) : (
              r.lastFive.map((win, j) => (
                <span key={j} className={`h-[9px] w-[9px] ${win ? "bg-positive" : "bg-negative"}`} />
              ))
            )}
          </div>
        </div>
      ))}
      <p className="mt-2 font-mono text-[9px] text-ink-faint">
        Win rate = calls beating the venue index over the holding period · squares = last five closed calls
      </p>
    </div>
  );
}

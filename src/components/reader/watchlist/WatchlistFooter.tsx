import type { WatchAlert, WatchNote } from "@/lib/contracts/watchlist";

/**
 * Watchlist (1h) footer — two columns: Active alerts (ticker + condition +
 * delivery-channel chip + TRIGGERED/ARMED status chip) and My notes (ticker +
 * date + italic serif note card). Sample-driven for the fidelity pass; both
 * re-wire onto the real per-user alert/note collections later
 * (DEF-WATCHLIST-LIVE-DATA).
 */
function SectionHead({ label, action }: { label: string; action: string }) {
  return (
    <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
      <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">{label}</span>
      <span className="cursor-pointer font-ui text-[11px] font-semibold text-ink-muted underline underline-offset-[3px]">
        {action}
      </span>
    </div>
  );
}

export function WatchlistFooter({ alerts, notes }: { alerts: WatchAlert[]; notes: WatchNote[] }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-x-8">
      {/* Active alerts. */}
      <div>
        <SectionHead label="Active alerts" action="+ New alert" />
        {alerts.map((a) => (
          <div
            key={`${a.ticker}-${a.conditionStrong}`}
            className="flex items-center gap-2.5 border-b border-hairline-faint py-[11px]"
          >
            <span className="w-16 flex-none font-mono text-[10.5px] font-semibold text-ink">
              {a.ticker}
            </span>
            <span className="text-[12px] text-ink-mid">
              {a.conditionPre}
              <b className="font-semibold text-ink">{a.conditionStrong}</b>
              {a.conditionPost}
            </span>
            <span className="ml-auto flex-none border border-hairline px-1.5 py-0.5 font-mono text-[8.5px] text-ink-muted">
              {a.channel}
            </span>
            {a.triggeredAt ? (
              <span className="flex-none bg-ink px-1.5 py-[2.5px] font-mono text-[8.5px] text-paper-tint">
                {a.triggeredAt}
              </span>
            ) : (
              <span className="flex-none border border-hairline-strong px-1.5 py-0.5 font-mono text-[8.5px] text-ink-faint">
                ARMED
              </span>
            )}
          </div>
        ))}
      </div>

      {/* My notes. */}
      <div>
        <SectionHead label="My notes" action="All notes →" />
        {notes.map((n, i) => (
          <div
            key={`${n.ticker}-${n.date}`}
            className={`border border-hairline px-3.5 py-3 ${i === 0 ? "mt-3" : "mt-2.5"}`}
          >
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[10px] font-semibold text-ink">{n.ticker}</span>
              <span className="font-mono text-[9px] text-ink-faint">{n.date}</span>
            </div>
            <div className="mt-1.5 font-display text-[13.5px] italic leading-[1.5] text-ink-mid">
              {n.note}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

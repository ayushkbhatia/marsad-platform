import type { Ownership, TopHolder } from "@/lib/contracts/stock";

/**
 * Stock Ownership & People tab (design 3d) — a shareholding-pattern time
 * series (8 quarters, foreign-ownership-at-record banner) + shareholder
 * count, then Top holders (with QoQ change + a Float-watch callout) and Board
 * of directors + Key management side by side. Sample-driven (DEF-STOCK-LIVE-DATA).
 */
const SH_COLS = "grid-cols-[230px_repeat(8,1fr)]";

function withBold(html: string) {
  return html.split(/<b>(.*?)<\/b>/).map((part, i) =>
    i % 2 === 1 ? (
      <b key={i} className="font-semibold text-ink">
        {part}
      </b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function HolderChange({ h }: { h: TopHolder }) {
  if (h.changeDir === "up") return <span className="text-right text-[10.5px] font-semibold text-positive">{h.change}</span>;
  if (h.changeDir === "down") return <span className="text-right text-[10.5px] font-semibold text-negative">{h.change}</span>;
  return <span className="text-right text-[10.5px] text-ink-faint">{h.change}</span>;
}

export function StockOwnership({ ownership: o }: { ownership: Ownership }) {
  return (
    <div className="px-7 pt-4 pb-[30px]">
      {/* Shareholding pattern. */}
      <div className="flex flex-wrap items-center gap-3 border-b-2 border-ink pb-2">
        <span className="font-display text-[20px] font-semibold text-ink">Shareholding pattern</span>
        <span className="bg-positive px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.1em] text-paper">
          {o.foreignAtRecord}
        </span>
        <div className="ml-auto flex gap-1">
          <span className="cursor-pointer bg-ink px-[9px] py-[3px] text-[9.5px] font-bold text-paper-tint">QUARTERLY</span>
          <span className="cursor-pointer border border-hairline-strong px-[9px] py-[2.5px] text-[9.5px] text-ink-muted">YEARLY</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[840px]">
          <div className={`grid ${SH_COLS} border-b border-hairline`}>
            <span className="px-2.5 py-2" />
            {o.periods.map((p) => (
              <span key={p} className="px-1.5 py-2 text-right font-mono text-[9px] text-ink-muted">
                {p}
              </span>
            ))}
          </div>
          {o.rows.map((r) => (
            <div key={r.label} className={`grid ${SH_COLS} border-b border-hairline-faint`}>
              <span className="px-2.5 py-2 text-[12px] font-semibold text-ink-mid">{r.label}</span>
              {r.values.map((v, i) => (
                <span key={i} className="px-1.5 py-2 text-right text-[11px] tabular-nums text-ink-muted">
                  {v}
                </span>
              ))}
            </div>
          ))}
          <div className={`grid ${SH_COLS} border-b border-hairline bg-paper-tint`}>
            <span className="px-2.5 py-2 text-[12px] text-ink-muted">No. of shareholders</span>
            {o.shareholderCount.map((v, i) => (
              <span key={i} className="px-1.5 py-2 text-right text-[11px] tabular-nums text-ink-muted">
                {v}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Holders + people. */}
      <div className="mt-[22px] grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-x-[30px]">
        {/* Top holders. */}
        <div>
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">Top holders</span>
            <span className="font-mono text-[9px] text-ink-faint">{o.topHoldersAsOf}</span>
          </div>
          {o.topHolders.map((h) => (
            <div
              key={h.name}
              className="grid grid-cols-[1fr_130px_70px_78px] items-baseline gap-2.5 border-b border-hairline-faint px-0.5 py-[9.5px]"
            >
              <span className="text-[12.5px] font-semibold text-ink underline decoration-hairline underline-offset-[3px]">
                {h.name}
              </span>
              <span className="text-[10.5px] text-ink-faint">{h.type}</span>
              <span className="text-right text-[12px] font-semibold tabular-nums text-ink">{h.pct}</span>
              <HolderChange h={h} />
            </div>
          ))}
          <div className="mt-2 font-mono text-[8.5px] text-ink-faint">
            CLICK A HOLDER FOR ITS FULL GCC PORTFOLIO · INVESTOR PAGES COMING WITH THE PEOPLE DIRECTORY
          </div>
          <div className="mt-4 border border-hairline bg-paper-tint px-[15px] py-3.5">
            <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">Float watch</div>
            <div className="mt-1.5 text-[12px] leading-[1.6] text-ink-mid">{withBold(o.floatWatchHtml)}</div>
          </div>
        </div>

        {/* Board + management. */}
        <div>
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">Board of directors</span>
            <span className="font-mono text-[9px] text-ink-faint">{o.boardMeta}</span>
          </div>
          {o.board.map((b) => (
            <div
              key={b.name}
              className="grid grid-cols-[1fr_150px_62px] items-baseline gap-2.5 border-b border-hairline-faint px-0.5 py-[9px]"
            >
              <span className="text-[12.5px] font-semibold text-ink">{b.name}</span>
              <span className="text-[10.5px] text-ink-muted">{b.role}</span>
              <span className="text-right font-mono text-[9.5px] text-ink-faint">{b.since}</span>
            </div>
          ))}

          <div className="mt-5 border-b-2 border-ink pb-2 font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
            Key management
          </div>
          {o.management.map((m) => (
            <div key={m.name} className="border-b border-hairline-faint px-0.5 py-[11px]">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="text-[13px] font-bold text-ink">{m.name}</span>
                <span className="text-[10.5px] text-ink-faint">{m.role}</span>
              </div>
              <div className="mt-1 text-[11.5px] leading-[1.5] text-ink-muted">{m.bio}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

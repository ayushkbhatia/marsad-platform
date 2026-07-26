import type { LiveMarkets } from "@/lib/contracts/ledger";

/**
 * Ledger front page (1b) right-rail "Live markets" body — a single-index
 * focus block (code + name, big serif-ish tabular level, day change, a bare
 * sparkline, H/L/VOL footer) over a 2×2 macro-ticker grid (Brent / gold /
 * UST10Y / pegged USDSAR).
 *
 * Sits under the page's `SectionBar variant="rule"` header (which carries the
 * OPEN/CLOSED tag on its right), so this renders body-only. The design's one
 * piece to later swap for a real charting library is the sparkline; the
 * points here are pre-normalised in the sample view-model.
 */
function fmtLevel(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function LiveMarketsRail({ live }: { live: LiveMarkets }) {
  const up = live.changePct >= 0;

  return (
    <div>
      {/* Focus index. */}
      <div className="border-b border-hairline-soft pt-3.5 pb-3">
        <div className="flex items-baseline gap-[9px]">
          <span className="font-mono text-[10.5px] font-semibold text-ink">{live.code}</span>
          <span className="text-[11px] text-ink-faint">{live.name}</span>
        </div>

        <div className="mt-1.5 flex items-baseline gap-3">
          <span className="text-[27px] font-semibold tracking-[-0.01em] tabular-nums text-ink">
            {fmtLevel(live.level)}
          </span>
          <span
            className={`text-[13.5px] font-semibold tabular-nums ${up ? "text-positive" : "text-negative"}`}
          >
            {up ? "+" : ""}
            {live.changePct.toFixed(2)}%
          </span>
        </div>

        <svg
          width={live.spark.width}
          height={live.spark.height}
          viewBox={`0 0 ${live.spark.width} ${live.spark.height}`}
          className="mt-2 block max-w-full text-ink"
        >
          <polyline points={live.spark.points} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>

        <div className="mt-1.5 flex justify-between font-mono text-[9.5px] text-ink-faint">
          <span>H {live.dayHigh}</span>
          <span>L {live.dayLow}</span>
          <span>VOL {live.volume}</span>
        </div>
      </div>

      {/* Macro grid. */}
      <div className="grid grid-cols-2 gap-2 border-b border-hairline-soft py-3">
        {live.macro.map((m) => (
          <div
            key={m.label}
            className={`flex flex-col gap-[3px] border border-hairline-soft px-2.5 py-2 ${
              m.tinted ? "bg-paper-tint" : ""
            }`}
          >
            <span className="font-mono text-[9.5px] font-semibold text-ink-muted">{m.label}</span>
            <span className="text-[13px] font-semibold tabular-nums text-ink">{m.value}</span>
            <span
              className={`text-[10.5px] tabular-nums ${
                m.muted
                  ? "text-ink-faint"
                  : m.dir === "down"
                    ? "font-semibold text-negative"
                    : "font-semibold text-positive"
              }`}
            >
              {m.change}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

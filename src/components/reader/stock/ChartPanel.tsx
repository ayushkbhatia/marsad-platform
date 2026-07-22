import Link from "next/link";
import type { OhlcvSeries } from "@/lib/data/stocks";
import { PriceChart } from "@/components/reader/PriceChart";

/**
 * Overview "Chart" panel (screen 3a). PRICE stays a real server-rendered
 * inline SVG (`PriceChart`, fed by the already-cached `getOhlcvSeries`) — the
 * design's other chart types (P/E, Sales & margin, EV/EBITDA, P/B) need
 * ratio TIME SERIES this reader doesn't have (key_ratios is a point-in-time
 * snapshot, and its valuation columns are premium besides), so those tabs
 * render as inert locked labels rather than a chart with no data. The range
 * selector isn't duplicated here — it links out to the dedicated Chart tab's
 * real `?range=` selector instead of adding client state to this page.
 */

const LOCKED_TABS = ["P/E", "SALES & MARGIN", "EV/EBITDA", "P/B"];

export function ChartPanel({ series, currency, chartHref }: { series: OhlcvSeries; currency: string; chartHref: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 border-b-2 border-ink pb-[7px]">
        <span className="mr-auto font-mono text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
          Chart
        </span>
        <span className="bg-ink px-2 py-[3px] font-mono text-[9.5px] font-bold text-paper-tint">PRICE</span>
        {LOCKED_TABS.map((t) => (
          <span
            key={t}
            className="cursor-not-allowed border border-hairline-strong px-2 py-[2.5px] font-mono text-[9.5px] text-ink-faint opacity-70"
            title="Needs ratio history — Premium"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="relative border border-t-0 border-hairline-soft bg-paper">
        {series.points.length >= 2 ? (
          <PriceChart points={series.points} height={236} />
        ) : (
          <p className="py-14 text-center font-mono text-[11px] tracking-[0.08em] text-ink-faint uppercase">
            No price history for this range
          </p>
        )}
        <span className="absolute top-2 left-2.5 font-mono text-[8.5px] text-ink-faint">
          {series.range} · {currency || "—"}
        </span>
      </div>

      <div className="mt-2 flex justify-end">
        <Link
          href={chartHref}
          className="font-mono text-[10px] text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Full chart &amp; ranges →
        </Link>
      </div>
    </div>
  );
}

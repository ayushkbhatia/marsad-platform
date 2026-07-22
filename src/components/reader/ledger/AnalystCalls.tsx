import Link from "next/link";
import type { AnalystCall } from "@/lib/data/sample/ledger";

/**
 * Ledger front page (1b) "Analyst calls today" row — a 4-up card strip under
 * a 2px ink rule. Each card: an outlined action badge + symbol, company name,
 * price target + context note, and the analyst byline.
 *
 * Sample-seeded (see `src/lib/data/sample/ledger.ts`); the design's fourth
 * main-column module, previously parked as DEF-LEDGER-ANALYST-CALLS for want
 * of a dated-call data source. The eventual coverage-desk adapter maps real
 * rating actions onto `AnalystCall`.
 */
export function LedgerAnalystCalls({ calls }: { calls: AnalystCall[] }) {
  if (calls.length === 0) return null;

  return (
    <div className="mt-0.5 border-t-2 border-ink pt-3">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
          Analyst calls today
        </span>
        <Link
          href="/analysts"
          className="font-ui text-[11px] font-semibold text-ink-muted underline underline-offset-[3px] hover:text-ink"
        >
          Coverage desk →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {calls.map((c) => (
          <Link
            key={c.symbol}
            href={c.href}
            className="flex flex-col gap-[7px] border border-hairline px-3.5 py-3 hover:bg-paper-tint"
          >
            <div className="flex items-center gap-2">
              <span className="border border-ink px-[7px] py-[3px] text-[9px] font-bold tracking-[0.12em] text-ink uppercase">
                {c.action}
              </span>
              <span className="ml-auto font-mono text-[10.5px] font-semibold text-ink">{c.symbol}</span>
            </div>
            <div className="text-[13px] font-semibold text-ink">{c.name}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-semibold tabular-nums text-ink">{c.priceTarget}</span>
              <span className="text-[10.5px] text-ink-faint">{c.note}</span>
            </div>
            <div className="font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
              {c.analyst}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

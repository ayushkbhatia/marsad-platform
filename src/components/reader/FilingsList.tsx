import Link from "next/link";
import type { FilingItem } from "@/lib/data/filings";
import { fmtDate } from "@/lib/reader/format";

/**
 * Shared filings list (server component) for the overview teaser, the stock
 * Filings tab, and the global register. Pure presentation over already-fetched
 * `FilingItem[]` — no data access here.
 */

const TYPE_STYLE: Record<string, string> = {
  RESULTS: "border-ink text-ink",
  DIVIDEND: "border-positive text-positive",
  CONTRACT: "border-ink-muted text-ink-muted",
  CAPEX: "border-ink-muted text-ink-muted",
  GOVERNANCE: "border-ink-muted text-ink-muted",
  RATING: "border-ink-muted text-ink-muted",
  OPS: "border-ink-muted text-ink-muted",
  OTHER: "border-hairline-strong text-ink-faint",
};

function TypeChip({ type }: { type: string | null }) {
  if (!type) return null;
  const cls = TYPE_STYLE[type] ?? "border-hairline-strong text-ink-faint";
  return (
    <span className={`flex-none border px-1.5 py-px font-mono text-[8.5px] tracking-[0.08em] uppercase ${cls}`}>
      {type}
    </span>
  );
}

export interface FilingsListProps {
  items: FilingItem[];
  /** Show the security ticker/venue per row (global register). */
  showTicker?: boolean;
  /** Show the AI summary line under each title where present. */
  showSummary?: boolean;
  emptyLabel?: string;
}

export function FilingsList({
  items,
  showTicker = false,
  showSummary = false,
  emptyLabel = "No filings yet.",
}: FilingsListProps) {
  if (items.length === 0) {
    return (
      <div className="border border-dashed border-hairline px-4 py-10 text-center font-ui text-[13px] text-ink-faint">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-hairline-faint border-y border-hairline-faint">
      {items.map((f) => (
        <li key={f.id} className="flex items-start gap-3 py-3">
          <span className="mt-[2px] w-[70px] flex-none font-mono text-[10px] tracking-[0.02em] text-ink-faint">
            {fmtDate(f.filedAt)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {showTicker && f.ticker ? (
                <Link
                  href={`/stocks/${f.venueCode}/${f.ticker}`}
                  className="flex-none font-mono text-[10px] font-semibold text-ink hover:underline underline-offset-2"
                >
                  {f.ticker}
                  <span className="ml-1 text-ink-faint">{f.venueCode}</span>
                </Link>
              ) : null}
              {f.isMarketMoving ? (
                <span
                  className="flex-none bg-caution/15 px-1.5 py-px font-mono text-[8px] font-semibold tracking-[0.1em] text-caution-text uppercase"
                  title="Flagged market-moving"
                >
                  Market-moving
                </span>
              ) : null}
              <TypeChip type={f.filingType} />
            </div>

            <Link
              href={`/filings/${f.id}`}
              className="mt-1 block font-ui text-[13.5px] leading-[1.45] text-ink hover:underline underline-offset-2"
            >
              {f.title ?? "Untitled filing"}
            </Link>

            {showSummary && f.aiSummary ? (
              <p className="mt-1 line-clamp-2 font-ui text-[12px] leading-[1.5] text-ink-muted">
                {f.aiSummary}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

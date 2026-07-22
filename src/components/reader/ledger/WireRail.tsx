import Link from "next/link";
import type { FilingItem } from "@/lib/data/filings";
import { fmtClock } from "@/lib/reader/format";

/**
 * Ledger front page (1b) right-rail "The wire" section — a compact row per
 * filing: mono time gutter, a bordered ticker/type badge, the title as a
 * single serif-weight snippet line. This is a 1b-specific presentation over
 * the same `FilingItem[]` the main `FilingsList` renders elsewhere
 * (`/wire`, the stock Filings tab, `/filings`) — deliberately a separate,
 * narrower component rather than a new `FilingsList` variant, so this page
 * never risks changing those other surfaces (`FilingsList.tsx` is untouched).
 */
export function LedgerWireRail({ items, emptyLabel }: { items: FilingItem[]; emptyLabel: string }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul>
      {items.map((f) => (
        <li key={f.id} className="border-b border-hairline-faint last:border-b-0">
          <Link
            href={`/filings/${f.id}`}
            className="flex items-baseline gap-2.5 py-[9px] hover:bg-paper-tint"
          >
            <span className="flex-none font-mono text-[10px] text-ink-faint">{fmtClock(f.filedAt)}</span>
            <span className="flex-none border border-hairline px-[5px] py-px font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted">
              {f.ticker ?? f.filingType ?? f.venueCode ?? "—"}
            </span>
            <span className="min-w-0 flex-1 truncate font-ui text-[12px] leading-[1.45] text-ink-mid">
              {f.title ?? "Untitled filing"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

import Link from "next/link";
import type { WireItem } from "@/lib/contracts/ledger";

/**
 * Ledger front page (1b) right-rail "The wire" section — a compact row per
 * item: mono time gutter, a bordered source badge, and the headline snippet
 * (wraps to 1.45 line-height, never truncated). Sits under the page's
 * `SectionBar variant="rule"` "The wire" header.
 *
 * Design-shaped (`WireItem`); the eventual filings-wire adapter maps a
 * `FilingItem` onto it.
 */
export function LedgerWireRail({ items }: { items: WireItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase">
        No items on the wire yet.
      </p>
    );
  }

  return (
    <ul>
      {items.map((w) => (
        <li key={`${w.time}-${w.summary}`} className="border-b border-hairline-faint last:border-b-0">
          <Link href={w.href} className="flex items-baseline gap-2.5 py-[9px] hover:bg-paper-tint">
            <span className="flex-none font-mono text-[10px] text-ink-faint">{w.time}</span>
            <span className="flex-none border border-hairline px-[5px] py-[1.5px] font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted">
              {w.source}
            </span>
            <span className="text-[12px] leading-[1.45] text-ink-mid">{w.summary}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

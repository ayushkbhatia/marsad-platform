import Link from "next/link";
import type { NewsroomItemSummary } from "@/lib/data/newsroom";
import { newsroomItemHref } from "@/lib/data/newsroom";
import { fmtClock } from "@/lib/reader/format";

/**
 * Ledger front page (1b) secondary-story grid — the newsroom wires below the
 * lead (same `listNewsroomContent` read, items after index 0). Two-column,
 * kicker + time over a serif headline + dek, matching 1b's story-list rows.
 * Renders nothing when there's only a lead (today's common case — the
 * newsroom has published one live WIRE) rather than padding out placeholder
 * rows: graceful, not fabricated.
 */
export function LedgerSecondaryStories({ items }: { items: NewsroomItemSummary[] }) {
  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-x-11 md:grid-cols-2">
      {items.map((item) => (
        <Link
          key={item.id}
          href={newsroomItemHref(item)}
          className="flex flex-col gap-[7px] border-b border-hairline-soft py-4 hover:bg-paper-tint"
        >
          <div className="flex items-baseline gap-2.5">
            <span className="font-ui text-[9.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">
              {item.kicker ?? "Newsroom wire"}
            </span>
            <span className="font-mono text-[9px] text-ink-faint">{fmtClock(item.publishedAt)}</span>
          </div>
          <div className="font-display text-[19.5px] leading-[1.24] font-semibold text-ink">{item.headline}</div>
          {item.dek ? (
            <p className="line-clamp-2 font-ui text-[12.5px] leading-[1.5] text-ink-muted">{item.dek}</p>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

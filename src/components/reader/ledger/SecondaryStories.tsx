import Link from "next/link";
import type { LedgerStory } from "@/lib/data/sample/ledger";

/**
 * Ledger front page (1b) secondary-story grid — the six stories below the
 * lead in a 2×3 grid, split by a hairline centre rule (the design's
 * `background-size:1px …` divider, here an inset absolute rule so it drops
 * cleanly to one column below `md`). Kicker + time over a serif headline +
 * dek; opinion pieces take an italic headline.
 */
export function LedgerSecondaryStories({ items }: { items: LedgerStory[] }) {
  if (items.length === 0) return null;

  return (
    <div className="relative grid grid-cols-1 gap-x-11 md:grid-cols-2">
      {/* Centre rule — inset 8px top/bottom, desktop only. */}
      <div
        aria-hidden
        className="absolute top-2 bottom-2 left-1/2 hidden w-px bg-hairline-soft md:block"
      />

      {items.map((s) => (
        <Link
          key={s.headline}
          href={s.href}
          className="flex flex-col gap-[7px] border-b border-hairline-soft py-4 hover:bg-paper-tint"
        >
          <div className="flex items-baseline gap-2.5">
            <span className="font-ui text-[9.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">
              {s.kicker}
            </span>
            <span className="font-mono text-[9px] text-[#a8a396]">{s.time}</span>
          </div>
          <div
            className={`font-display text-[19.5px] leading-[1.24] font-semibold text-ink ${
              s.isOpinion ? "italic" : ""
            }`}
          >
            {s.headline}
          </div>
          <p className="font-ui text-[12.5px] leading-[1.5] text-ink-muted">{s.dek}</p>
        </Link>
      ))}
    </div>
  );
}

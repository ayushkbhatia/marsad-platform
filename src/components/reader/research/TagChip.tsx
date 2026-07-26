import type { ArticleTag } from "@/lib/contracts/research";

/**
 * FREE / PREMIUM tag chip shared across the research index cards and the
 * article header — PREMIUM is a solid-ink chip, FREE a 1px outline (design 1l/1k).
 */
export function TagChip({ tag }: { tag: ArticleTag }) {
  if (tag === "PREMIUM") {
    return (
      <span className="bg-ink px-[5px] py-0.5 font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
        Premium
      </span>
    );
  }
  return (
    <span className="border border-hairline-strong px-[5px] py-[1.5px] font-mono text-[8px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
      Free
    </span>
  );
}

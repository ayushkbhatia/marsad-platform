import type { BlockNodeOf } from "../types";

/*
 * BLK-MARGIN · Margin note — A · Inline
 *
 * "CONTEXT A READER MAY SKIP · NEVER LOAD-BEARING · AUTHORED, NOT BOUND"
 *
 * The one A-family block with no data binding, and the only one that may be
 * skipped without the argument falling over. 118px fixed rail, 1px hairline
 * left border — in the 1a chassis this rail aligns to the marker gutter beside
 * the paragraph it annotates.
 */
export function BlockMargin({ node }: { node: BlockNodeOf<"BLK-MARGIN"> }) {
  const { hostText, label = "NOTE", body } = node.payload;
  return (
    <div className="flex gap-3.5">
      <p className="flex-1 font-display text-[15px] leading-[1.66] text-ink-soft">{hostText}</p>
      <aside className="w-[118px] flex-none border-l border-hairline pl-[11px]">
        <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{label}</div>
        <p className="mt-1 text-[10.5px] leading-[1.5] text-ink-muted">{body}</p>
      </aside>
    </div>
  );
}

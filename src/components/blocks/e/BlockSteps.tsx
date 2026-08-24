import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-STEPS · Numbered mechanism — E · Mechanism
 *
 * "3–5 STEPS · A BOLD CLAIM PLUS ONE CLARIFYING LINE, NEVER A PARAGRAPH"
 *
 * The zero-padded numeral the card shows (`01`) is the array index formatted, not a payload field.
 * A payload that could disagree with its own ordering is a payload with a bug in it — so the
 * writer cannot number the steps, and therefore cannot number them wrongly.
 *
 * "Never a paragraph" is checkable: a clarifier carrying more than one sentence is the shape the
 * rule was written against.
 */
export function BlockSteps({ node }: { node: BlockNodeOf<"BLK-STEPS"> }) {
  const { steps } = node.payload;

  if (steps.length < 3 || steps.length > 5) {
    warnConstraint("BLK-STEPS", `${steps.length} steps — the block is three to five.`);
  }
  steps.forEach((s, i) => {
    if ((s.clarifier.match(/[.!?](\s|$)/g) ?? []).length > 1) {
      warnConstraint("BLK-STEPS", `step ${i + 1} clarifier is more than one sentence — never a paragraph.`);
    }
  });

  return (
    <div className="my-5">
      {steps.map((s, i) => (
        <div
          key={i}
          className="flex gap-3 border-b border-hairline-faint py-2.5 last:border-b-0 last:pb-0"
        >
          <span className="w-5 flex-none font-mono text-[9.5px] font-semibold text-ink-muted tabular-nums">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div>
            <div className="font-display text-[13.5px] leading-[1.4] font-bold text-ink">{s.claim}</div>
            <div className="mt-0.5 font-display text-[12.5px] leading-[1.5] text-ink-muted">
              {s.clarifier}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

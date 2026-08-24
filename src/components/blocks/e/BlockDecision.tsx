import type { BlockNodeOf } from "../types";

/**
 * BLK-DECISION · If / then — E · Mechanism
 *
 * "ONE QUESTION, TWO OUTCOMES · NEVER NEST — A SECOND LEVEL MEANS THE EXPLAINER IS WRONG"
 *
 * The nesting rule is enforced by the SHAPE rather than by a check: the payload has exactly one
 * question and exactly two outcome strings, so a second level cannot be expressed. That is the
 * stronger form of the constraint — there is nothing to warn about because there is nothing to
 * get wrong.
 */
export function BlockDecision({ node }: { node: BlockNodeOf<"BLK-DECISION"> }) {
  const { question, yes, no } = node.payload;

  return (
    <div className="my-5">
      <div className="border border-ink bg-paper-tint px-3.5 py-3">
        <div className="font-mono text-[8px] tracking-[0.12em] text-ink-faint uppercase">Start</div>
        <p className="mt-1 font-display text-[14px] leading-[1.4] font-bold text-ink">{question}</p>
      </div>

      <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
        {[
          { chip: "Yes", text: yes, bg: "var(--color-positive-fill)" },
          { chip: "No", text: no, bg: "var(--color-negative)" },
        ].map((o) => (
          <div key={o.chip} className="border border-hairline">
            <div
              className="px-2.5 py-[4px] font-mono text-[8.5px] font-semibold tracking-[0.12em] text-paper-tint uppercase"
              style={{ background: o.bg }}
            >
              {o.chip}
            </div>
            <p className="px-3 py-2.5 font-display text-[12.5px] leading-[1.5] text-ink">{o.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

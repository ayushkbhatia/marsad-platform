import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-BIGNUM · The number that matters — B · Statement
 *
 * "ONE PER PIECE · THE FIGURE THE HEADLINE RESTS ON · ONE LAKE FIELD, NOT AN
 * AGGREGATE." The single-binding payload shape enforces the last clause
 * structurally, so there is nothing here to check — an aggregate cannot be
 * expressed.
 *
 * `value` is BOUND and therefore renders through Val: if the binding produced
 * nothing the card shows an em-dash. A block whose entire purpose is one figure
 * showing a dash is loud, which is correct — the alternative is a plausible
 * number nobody sourced.
 */
export function BlockBigNum({ node }: { node: BlockNodeOf<"BLK-BIGNUM"> }) {
  const { caption, contextLine, value } = node.payload;

  return (
    <section className="border-y border-rule py-5 text-center">
      <p className="font-mono text-[clamp(38px,7vw,60px)] leading-[1] tracking-[-0.02em] text-ink tabular-nums">
        <Val v={value} />
      </p>
      <p className="mx-auto mt-3 max-w-[46ch] text-[12.5px] leading-[1.5] text-ink-mid">{caption}</p>
      {contextLine ? (
        <p className="mx-auto mt-1 max-w-[46ch] font-mono text-[10px] leading-[1.5] text-ink-faint">
          {contextLine}
        </p>
      ) : null}
    </section>
  );
}

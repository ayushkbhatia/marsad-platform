import { warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-VERDICT · Rating card — B · Statement
 *
 * "ONLY ON PIECES WITH A FORMAL CALL, NEVER ON WIRES · MUST NAME THE PRIOR
 * RATING." The prior is the one machine-checkable clause on this card and the
 * part editors most often drop, so a missing one warns rather than rendering a
 * call that looks like it came from nowhere.
 *
 * Deliberately NOT direction-coloured. Hard rule 1 reserves green and red for
 * direction, and a rating is a judgement, not a movement — colouring an
 * Overweight green would make the desk's opinion look like a measured fact.
 */
export function BlockVerdict({ node }: { node: BlockNodeOf<"BLK-VERDICT"> }) {
  const { ticker, companyName, rating, priorRating, targetPrice, upsidePct, changedInThisNote } =
    node.payload;

  if (!priorRating) {
    warnConstraint("BLK-VERDICT", "no prior rating — a call without a prior is not a call.");
  }

  return (
    <section className="border border-rule bg-paper-tint px-4 py-[13px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13px] text-ink">
          <span className="font-mono">{ticker}</span>
          <span className="text-ink-faint"> · </span>
          {companyName}
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
          {changedInThisNote ? "RATING CHANGED IN THIS NOTE" : "RATING REITERATED"}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <p className="text-[22px] leading-[1.1] text-ink">{rating}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
          from {priorRating || "—"}
        </p>
        <p className="ml-auto font-mono text-[12px] tabular-nums text-ink-mid">
          TARGET <Val v={targetPrice} />
          <span className="text-ink-faint"> · </span>
          <Val v={upsidePct} />
        </p>
      </div>
    </section>
  );
}

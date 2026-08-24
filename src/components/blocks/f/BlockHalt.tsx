import { warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/**
 * BLK-HALT · Trading halt — F · Wire
 *
 * "MUST DISTINGUISH FROZEN FROM STALE · STATES THE REASON AND THE EXPECTED LIFT"
 *
 * The distinction is the entire block. A price that has not moved because the instrument is HALTED
 * is a fact about the market; a price that has not moved because our feed died is a fact about us.
 * They look identical on a screen and mean opposite things, so the copy has to say which — and
 * `frozenStatement` is a required field rather than a derived one precisely so it cannot be
 * omitted by a writer who assumed it was obvious.
 *
 * This is also the counterpart to BLK-FRESH: that block says how old a live number is, this one
 * says the number is not live at all.
 */
export function BlockHalt({ node }: { node: BlockNodeOf<"BLK-HALT"> }) {
  const { ticker, haltedSince, expectedLift, reason, lastTraded, frozenStatement } = node.payload;

  if (!frozenStatement) {
    warnConstraint("BLK-HALT", "no frozen-not-stale statement — a halted price and a dead feed look identical.");
  }

  return (
    <div
      className="my-4 border border-hairline bg-paper-tint px-4 py-3"
      style={{ borderLeftWidth: "3px", borderLeftStyle: "solid", borderLeftColor: "var(--color-negative)" }}
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-negative px-[7px] py-[2px] font-mono text-[8.5px] font-semibold tracking-[0.12em] text-paper-tint uppercase">
          Halted
        </span>
        <span className="font-mono text-[11px] font-semibold text-ink">{ticker}</span>
      </div>

      <div className="mt-2.5 grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
        {[
          ["Halted since", haltedSince],
          ["Expected lift", expectedLift],
          ["Reason", reason],
        ].map(([k, v]) => (
          <div key={k}>
            <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">{k}</div>
            <div className="font-display text-[12.5px] text-ink">{v}</div>
          </div>
        ))}
        <div>
          <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">Last traded</div>
          <div className="font-mono text-[12.5px] text-ink tabular-nums">
            <Val v={lastTraded} />
          </div>
        </div>
      </div>

      {/* The sentence that stops a halted price reading as a broken feed. */}
      <p className="mt-2.5 border-t border-hairline pt-2 font-display text-[12px] leading-[1.5] text-ink">
        {frozenStatement}
      </p>
    </div>
  );
}

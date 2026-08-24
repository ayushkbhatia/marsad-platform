import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-COUNTDOWN · Deadline clock — F · Wire
 *
 * "ABSOLUTE DEADLINE UNDER THE RELATIVE ONE · MARSAD NEVER TAKES THE ORDER"
 *
 * Both halves are load-bearing.
 *
 * The absolute deadline is mandatory because a relative clock alone is unactionable and quietly
 * wrong: "2d 09h" was computed at render time, and a cached page, a different timezone or a
 * reader returning tomorrow all make it a lie. The absolute time with its zone is the fact; the
 * relative is the convenience.
 *
 * "Marsad never takes the order" is a product boundary, not a design one — the CTA routes the
 * reader to their broker. A block that could accept an instruction here would make this a
 * regulated venue.
 */
export function BlockCountdown({ node }: { node: BlockNodeOf<"BLK-COUNTDOWN"> }) {
  const { kicker, relative, absolute, context, ctaLabel } = node.payload;

  if (!absolute) {
    warnConstraint("BLK-COUNTDOWN", "no absolute deadline — a relative clock alone is unactionable and goes stale silently.");
  }

  return (
    <div className="my-4 bg-ink px-4 py-[15px] text-paper-tint">
      <div className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-dark-text-faint uppercase">
        {kicker}
      </div>
      <div className="mt-1.5 font-display text-[36px] leading-none font-bold text-paper-tint tabular-nums">
        {relative}
      </div>
      <div className="mt-1.5 font-mono text-[9.5px] tracking-[0.1em] text-dark-text-mid uppercase">
        {absolute}
      </div>
      <p className="mt-2 font-display text-[12px] leading-[1.5] text-dark-text-mid">{context}</p>
      <button
        type="button"
        className="mt-3 inline-flex bg-paper-tint px-3.5 py-[8px] font-mono text-[9px] font-semibold tracking-[0.1em] text-ink uppercase"
      >
        {ctaLabel}
      </button>
    </div>
  );
}

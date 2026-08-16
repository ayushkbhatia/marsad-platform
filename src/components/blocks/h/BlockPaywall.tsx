import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-PAYWALL · In-article paywall band — H · Gates
 *
 * "NAMES THE METER STATE AND STATES SPECIFICALLY WHAT IS BEHIND THE WALL —
 * never a generic 'subscribe to read more'."
 *
 * The specificity is the product claim: a reader who is told exactly which
 * table, model or target sits behind the wall can decide; one told "read more"
 * is being nudged. The schema enforces a 24-character floor on
 * `behind_the_wall`; this warns on the generic phrasings that clear that floor
 * while still saying nothing.
 *
 * The meter itself is per-request reader state and is resolved at render, which
 * is why it is not a payload field.
 */
const GENERIC = /^(subscribe|continue reading|read more|unlock (more|the rest)\b)/i;

export function BlockPaywall({ node }: { node: BlockNodeOf<"BLK-PAYWALL"> }) {
  const { kicker, behindTheWall, ctaLabel, reassurance } = node.payload;

  if (GENERIC.test(behindTheWall.trim())) {
    warnConstraint(
      "BLK-PAYWALL",
      `generic wall copy ("${behindTheWall.slice(0, 40)}…") — name the table, model or target instead.`,
    );
  }

  return (
    <section className="border border-ink px-4 py-[15px] text-center">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
        {kicker || "CONTINUE WITH PREMIUM"}
      </p>
      <p className="mx-auto mt-2 max-w-[52ch] text-[13.5px] leading-[1.5] text-ink">{behindTheWall}</p>
      <p className="mt-3 inline-block border border-ink px-3 py-[6px] font-mono text-[10px] uppercase tracking-[0.1em] text-ink">
        {ctaLabel}
      </p>
      {reassurance ? (
        <p className="mt-2 font-mono text-[9px] text-ink-faint">{reassurance}</p>
      ) : null}
    </section>
  );
}

import { warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/**
 * BLK-BREADTH · Session breadth — F · Wire
 *
 * "MEDIAN MOVE MATTERS MORE THAN THE INDEX — IT SAYS WHETHER THE DAY WAS BROAD"
 *
 * A cap-weighted index can be carried by two names while the other three hundred fall, and on a
 * market where a handful of issuers dominate the cap that is not a rare case. The median move is
 * what distinguishes "the market rose" from "Aramco rose". So the median gets the prominent
 * position and the index does not appear in this block at all.
 *
 * The bar widths are proportional to the counts and the counts are printed INSIDE the segments —
 * a legend would let a reader mis-map colour to meaning at a glance, which on a breadth bar is the
 * one thing that must not happen.
 */
export function BlockBreadth({ node }: { node: BlockNodeOf<"BLK-BREADTH"> }) {
  const { advancers = 0, decliners = 0, unchanged = 0, medianMovePct, best, valueTraded } = node.payload;

  const total = advancers + decliners + unchanged;
  if (total <= 0) {
    warnConstraint("BLK-BREADTH", "no issuers counted — the breadth bar has nothing to divide.");
    return null;
  }
  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="my-4 border border-hairline px-3.5 py-3">
      <div className="flex h-5 w-full overflow-hidden" role="img" aria-label={`${advancers} advancers, ${decliners} decliners, ${unchanged} unchanged`}>
        {[
          { n: advancers, cls: "bg-positive", txt: "text-paper-tint" },
          { n: decliners, cls: "bg-negative", txt: "text-paper-tint" },
          { n: unchanged, cls: "bg-hairline", txt: "text-ink-muted" },
        ].map((seg, i) =>
          seg.n > 0 ? (
            <div
              key={i}
              className={`flex items-center justify-center ${seg.cls}`}
              style={{ width: pct(seg.n) }}
            >
              <span className={`font-mono text-[9px] font-semibold tabular-nums ${seg.txt}`}>{seg.n}</span>
            </div>
          ) : null,
        )}
      </div>

      <div className="mt-3 grid gap-x-5 gap-y-1.5 sm:grid-cols-3">
        <div>
          {/* The headline figure of the block, deliberately not the index. */}
          <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">Median move</div>
          <div className="font-display text-[18px] font-bold text-ink tabular-nums">
            <Val v={medianMovePct} />
          </div>
        </div>
        <div>
          <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">Best</div>
          <div className="font-mono text-[12.5px] text-ink tabular-nums">
            {best?.ticker ?? "—"} <Val v={best?.pct ?? null} />
          </div>
        </div>
        <div>
          <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">Value traded</div>
          <div className="font-mono text-[12.5px] text-ink tabular-nums">
            <Val v={valueTraded} />
          </div>
        </div>
      </div>
    </div>
  );
}

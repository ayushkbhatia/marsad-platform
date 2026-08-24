import { extent, scale } from "@/lib/blocks/chart-svg";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-RANGE · Valuation range — "WHERE'S FAIR?"
 *
 * "MUST STATE THE METHOD AND BASIS · A RANGE WITHOUT A DECK IS A GUESS"
 *
 * That rule is enforced rather than trusted: a range with no method is warned, because a bear-base-
 * bull band drawn without saying how it was derived reads as a measurement when it is a model
 * output. The method and basis are printed ON the exhibit for the same reason the scatter prints
 * its radius meaning — a caption is skippable.
 *
 * The diamond is the LIVE price, and it is deliberately the only marker: the point of the block is
 * where today's price sits inside the band, not the band itself.
 */
const W = 640;
const H = 92;
const PAD = { l: 12, r: 12, t: 30 };

export function BlockRange({ node }: { node: BlockNodeOf<"BLK-RANGE"> }) {
  const { caption, bear, base, bull, live, method, basis, objectIds = [], unit } = node.payload;

  if (!method || !basis) {
    warnConstraint("BLK-RANGE", "no method or basis stated — a range without a deck is a guess.");
  }

  const dom = extent([bear, bull, live]);
  const gaps = [bear, base, bull, live].some((v) => typeof v !== "number" || !Number.isFinite(v));
  const innerW = W - PAD.l - PAD.r;
  const x = (v: number | null) => PAD.l + (dom && typeof v === "number" ? scale(v, dom, innerW) : 0);

  return (
    <ChartFrame
      question="WHERE'S FAIR?"
      caption={caption}
      unit={unit}
      series={[{ label: "range", points: objectIds.map((id, i) => ({ label: String(i), date: null, value: 1, objectId: id, state: "PENDING" })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {/* the track */}
        <rect x={PAD.l} y={PAD.t} width={innerW} height={5} className="fill-hairline" />
        {/* the bear-to-bull span */}
        {dom && typeof bear === "number" && typeof bull === "number" ? (
          <rect x={x(bear)} y={PAD.t} width={Math.max(2, x(bull) - x(bear))} height={5} className="fill-ink" />
        ) : null}
        {/* base marker — a tick, not a diamond; the diamond is reserved for the live price */}
        {typeof base === "number" ? (
          <line x1={x(base)} y1={PAD.t - 5} x2={x(base)} y2={PAD.t + 10}
                stroke="var(--color-ink)" strokeWidth={1} />
        ) : null}
        {/* the live price */}
        {typeof live === "number" ? (
          <rect x={x(live) - 5.5} y={PAD.t - 3} width={11} height={11}
                transform={`rotate(45 ${x(live)} ${PAD.t + 2.5})`}
                className="fill-paper" stroke="var(--color-ink)" strokeWidth={2} />
        ) : null}

        {[["bear", bear], ["base", base], ["bull", bull]].map(([k, v]) =>
          typeof v === "number" ? (
            <text key={k as string} x={x(v)} y={PAD.t + 26} textAnchor="middle"
                  className="fill-ink-faint font-mono text-[8px] uppercase">
              {k as string}
            </text>
          ) : null,
        )}
      </svg>
      <p className="mt-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
        {method || "METHOD NOT STATED"} · {basis || "BASIS NOT STATED"} · diamond = live price
      </p>
    </ChartFrame>
  );
}

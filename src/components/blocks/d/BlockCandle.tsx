import { extent, scale } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-CANDLE · Session candles
 *
 * "WICK TAKES THE BODY COLOUR · ON A DEBUT THE REFERENCE LINE IS THE OFFER PRICE, NOT A PRIOR CLOSE"
 *
 * The reference rule is the one that carries real meaning. On a debut there IS no prior close, and
 * a chart that silently uses the first session's open as the baseline invents a reference the
 * market never had — the offer price is what everyone actually paid, so it is what the day should
 * be measured against. `referenceLabel` is printed so a reader knows which of the two they are
 * looking at rather than assuming.
 *
 * "No neutral wicks" matters more than it sounds: a wick drawn grey while its body is green splits
 * one session into two colours and reads as two facts.
 */
const W = 640;
const H = 240;
const PAD = { l: 8, r: 8, t: 12, b: 26 };

export function BlockCandle({ node }: { node: BlockNodeOf<"BLK-CANDLE"> }) {
  const { caption, candles = [], reference, referenceLabel, unit } = node.payload;

  const usable = candles.filter(
    (c) => [c.open, c.high, c.low, c.close].every((v) => typeof v === "number" && Number.isFinite(v)),
  );
  const gaps = usable.length !== candles.length;
  const dom = extent([
    ...candles.flatMap((c) => [c.high, c.low]),
    ...(typeof reference === "number" ? [reference] : []),
  ]);

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const colW = innerW / Math.max(candles.length, 1);
  const bodyW = Math.min(14, colW * 0.6);
  const y = (v: number) => PAD.t + innerH - (dom ? scale(v, dom, innerH) : 0);

  return (
    <ChartFrame
      question="HOW DID IT TRADE?"
      caption={caption}
      unit={unit}
      series={[{ label: "sessions", points: candles.map((c) => ({ label: c.label, date: null, value: c.close, objectId: c.objectId, state: c.state })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {typeof reference === "number" && dom ? (
          <>
            <line x1={PAD.l} y1={y(reference)} x2={W - PAD.r} y2={y(reference)}
                  stroke="var(--color-dark-text-faint)" strokeWidth={1} strokeDasharray="5 5" />
            <text x={PAD.l} y={y(reference) - 4} className="fill-ink-faint font-mono text-[8px] uppercase">
              {referenceLabel ?? "reference"}
            </text>
          </>
        ) : null}

        {candles.map((c, i) => {
          if (![c.open, c.high, c.low, c.close].every((v) => typeof v === "number")) return null;
          const cx = PAD.l + colW * i + colW / 2;
          const up = (c.close ?? 0) >= (c.open ?? 0);
          // One session, one colour — wick included.
          const cls = up ? "stroke-positive fill-positive" : "stroke-negative fill-negative";
          const top = y(Math.max(c.open!, c.close!));
          const bot = y(Math.min(c.open!, c.close!));
          return (
            <g key={`${c.label}-${i}`} className={cls}>
              <line x1={cx} y1={y(c.high!)} x2={cx} y2={y(c.low!)} strokeWidth={1.2} />
              <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bot - top)} stroke="none" />
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-COVER · Subscription cover meter
 *
 * "THE 1.0× LINE IS ALWAYS DRAWN IN RED — BELOW IT AN OFFER IS UNDERSUBSCRIBED, WHICH IS THE STORY"
 *
 * Always drawn, even when the offer is covered many times over and the line sits far to the left
 * looking irrelevant. That is the point: the reader learns where the threshold is on every cover
 * meter they see, so on the one occasion the fill stops short of it, they already know what they
 * are looking at. A line that only appears when it is breached teaches nothing.
 *
 * It is also the one place red is used for a THRESHOLD rather than for direction — it marks the
 * line below which the offer failed, not a fall.
 */
const W = 640;
const TRACK_H = 24;
const OVERHANG = 4;

export function BlockCover({ node }: { node: BlockNodeOf<"BLK-COVER"> }) {
  const { caption, covered, scaleMax, objectId, state } = node.payload;

  const max = Math.max(scaleMax, 1.2);
  const ok = typeof covered === "number" && Number.isFinite(covered);
  const pct = ok ? Math.min(1, Math.max(0, covered / max)) : 0;
  const onePct = Math.min(1, 1 / max);
  const H = TRACK_H + OVERHANG * 2 + 22;

  return (
    <ChartFrame
      question="HOW COVERED?"
      caption={caption}
      unit="×"
      series={[{ label: "cover", points: [{ label: "covered", date: null, value: covered, objectId, state }] }]}
      gaps={!ok}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        <rect x={0} y={OVERHANG} width={W} height={TRACK_H}
              className="fill-paper-tint" stroke="var(--color-hairline)" strokeWidth={1} />
        {ok ? <rect x={0} y={OVERHANG} width={W * pct} height={TRACK_H} className="fill-ink" /> : null}

        {/* Always drawn. Overhangs the track top and bottom so it reads as a threshold, not a fill. */}
        <line x1={W * onePct} y1={0} x2={W * onePct} y2={TRACK_H + OVERHANG * 2}
              stroke="var(--color-negative)" strokeWidth={2} />
        <text x={W * onePct + 4} y={TRACK_H + OVERHANG * 2 + 14}
              className="fill-negative font-mono text-[8.5px]">1.0×</text>

        <text x={0} y={TRACK_H + OVERHANG * 2 + 14} className="fill-ink-faint font-mono text-[8px]">0×</text>
        <text x={W} y={TRACK_H + OVERHANG * 2 + 14} textAnchor="end"
              className="fill-ink-faint font-mono text-[8px]">{max}×</text>
      </svg>
      <p className="mt-1.5 font-mono text-[9px] tracking-[0.08em] uppercase">
        {ok ? (
          <span className={covered! < 1 ? "text-negative" : "text-ink"}>
            {covered!.toFixed(2)}× covered{covered! < 1 ? " — undersubscribed" : ""}
          </span>
        ) : (
          <span className="text-ink-faint">cover not resolved</span>
        )}
      </p>
    </ChartFrame>
  );
}

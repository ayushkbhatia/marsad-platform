import { interpolate, Val } from "../primitives";
import type { BlockNodeOf, DeltaUnit } from "../types";

/*
 * BLK-DELTA · Sentence delta — A · Inline
 *
 * "ANY CHANGE THE READER SHOULD FEEL · MONO LIFTS IT OUT OF THE SERIF"
 * "ARROW IS SEMANTIC, NOT LITERAL — A FALLING COST OF FUNDS IS GREEN"
 *
 * Two independent signals, and the whole point of the block is that they can
 * disagree: `arrow` is which way the number moved, `polarity` is whether that
 * was good news. A cost of funds falling 7 bp draws ▼ in green.
 *
 * Note the magnitude itself is INK, never coloured — hard rule 1. Only the
 * arrow spends the accent.
 */
const POLARITY: Record<DeltaUnit["polarity"], string> = {
  good: "text-positive",
  bad: "text-negative",
  neutral: "text-ink",
};

function Delta({ unit }: { unit: DeltaUnit }) {
  return (
    <>
      <b className="font-mono text-[14px] font-bold text-ink tabular-nums">
        <Val v={unit.magnitude} />
      </b>{" "}
      <span className={`text-[12px] font-semibold ${POLARITY[unit.polarity] ?? POLARITY.neutral}`}>
        {unit.arrow === "up" ? "▲" : "▼"}
      </span>
    </>
  );
}

export function BlockDelta({ node }: { node: BlockNodeOf<"BLK-DELTA"> }) {
  const { hostText, deltas } = node.payload;
  return (
    <p className="font-display text-[16px] leading-[1.75] text-ink-soft">
      {interpolate("BLK-DELTA", hostText, deltas.length, (i) => (
        <Delta unit={deltas[i]} />
      ))}
    </p>
  );
}

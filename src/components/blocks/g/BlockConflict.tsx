import { warnConstraint } from "../constraints";
import { Diamond, Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-CONFLICT · Held from writers — G · Provenance & trust
 *
 * "PUBLISHING A GAP BEATS PUBLISHING A GUESS · SHOWS BOTH, PICKS NEITHER"
 *
 * When two sources disagree the figure is WITHHELD. This block is the visible
 * shape of that refusal: it prints both candidate values, bolds the primary
 * one, and states that neither is quoted in the piece until the desk resolves
 * it. Red here is direction-of-trust, not decoration — the one accent rule
 * still holds because nothing else on the block is coloured.
 */
export function BlockConflict({ node }: { node: BlockNodeOf<"BLK-CONFLICT"> }) {
  const { figure, period, sources, resolution } = node.payload;

  if (sources.length !== 2) {
    warnConstraint(
      "BLK-CONFLICT",
      `${sources.length} sources — the block shows exactly two: the vendor feed and the primary filing.`,
    );
  }
  const primaries = sources.filter((s) => s.isPrimary);
  if (primaries.length !== 1) {
    warnConstraint(
      "BLK-CONFLICT",
      `${primaries.length} sources marked primary — exactly one must be, since primary wins unless overridden.`,
    );
  }

  const subject = period ? `${figure} (${period})` : figure;

  return (
    <div className="border border-negative bg-paper-tint px-3.5 py-3">
      <div className="flex items-center gap-[7px]">
        <Diamond className="bg-negative" size={7} />
        <span className="font-mono text-[8px] font-semibold tracking-[0.12em] text-negative">
          SOURCES DISAGREE — FIGURE WITHHELD
        </span>
      </div>
      {sources.map((s, i) => (
        <div
          key={`${s.label}-${i}`}
          className={`flex justify-between py-1.5 ${
            i === 0 ? "mt-[7px] border-b border-hairline-soft" : ""
          }`}
        >
          <span className="text-[11px] text-ink-muted">{s.label}</span>
          <span
            className={`font-mono text-[10.5px] tabular-nums ${s.isPrimary ? "font-bold text-ink" : "text-ink"}`}
          >
            <Val v={s.value} />
          </span>
        </div>
      ))}
      <p className="mt-[7px] text-[11px] leading-[1.55] text-ink-mid">
        {/* The withheld figure is named, never printed. */}
        {subject} is not quoted in this piece until the desk resolves it. {resolution}
      </p>
    </div>
  );
}

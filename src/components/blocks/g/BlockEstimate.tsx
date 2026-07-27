import { estimateLabel } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-ESTIMATE · Desk-estimate marker — G · Provenance & trust
 *
 * "THREE SIGNALS AT ONCE: 'E' SUFFIX, INK HEADER, BOLD VALUE · NEVER COLOUR ALONE"
 *
 * Hard rule 3. The renderer owns all three signals; the agent supplies only the
 * bare period label and the value, so an estimate cannot be dressed as an
 * actual by anything the writer emits — or fail to be dressed as an estimate.
 */
export function BlockEstimate({ node }: { node: BlockNodeOf<"BLK-ESTIMATE"> }) {
  const { actual, estimate, attribution = "MARSAD DESK", note } = node.payload;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2.5">
        {/* The filed figure: faint header, muted value. */}
        <span className="font-mono text-[8px] tracking-[0.1em] text-ink-faint">{actual.label}</span>
        <span className="font-mono text-[13px] text-ink-muted tabular-nums">
          <Val v={actual.value} />
        </span>

        {/* Signal 1 — the E suffix. Signal 2 — the ink header. */}
        <span className="ml-2 font-mono text-[8px] font-semibold tracking-[0.1em] text-ink">
          {estimateLabel(estimate.label, true)}
        </span>
        {/* Signal 3 — the bold value. */}
        <span className="font-mono text-[13px] font-bold text-ink tabular-nums">
          <Val v={estimate.value} />
        </span>

        <span className="border border-ink px-1.5 py-[2px] font-mono text-[8px] font-semibold tracking-[0.1em] text-ink">
          {attribution}
        </span>
      </div>
      <p className="mt-3 border-l-[3px] border-ink bg-paper-tint px-3 py-2.5 text-[11px] leading-[1.55] text-ink-mid">
        {note}
      </p>
    </div>
  );
}

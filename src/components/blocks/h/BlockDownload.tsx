import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-DOWNLOAD · Take the data — H · Gates
 *
 * "SHIPPING THE OBJECT IDS IS THE DIFFERENTIATOR — IT MAKES THE RESEARCH AUDITABLE"
 *
 * The object ids ARE the product here. Anyone can ship a spreadsheet; shipping
 * one where every figure carries the lake object it came from is what lets a
 * reader trace a number back to the filing that stated it. So a download whose
 * id count does not match its series count is warned — a partially-traceable
 * file is the failure this block exists to prevent, and it would look complete.
 *
 * Outlined, not filled: the card is explicit that this is not the primary CTA.
 */
export function BlockDownload({ node }: { node: BlockNodeOf<"BLK-DOWNLOAD"> }) {
  const { kicker = "Every series is downloadable", explainer, seriesCount = 0, format, objectIds = [] } = node.payload;

  if (objectIds.length !== seriesCount) {
    warnConstraint(
      "BLK-DOWNLOAD",
      `${objectIds.length} object ids for ${seriesCount} series — every series must trace back to its filing.`,
    );
  }

  return (
    <div className="mt-6 border-t-2 border-ink pt-3.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{kicker}</p>
      <p className="mt-1.5 font-display text-[12.5px] leading-[1.5] text-ink-muted">{explainer}</p>
      <button
        type="button"
        className="mt-2.5 inline-flex items-center gap-2 border border-ink px-3.5 py-[8px] font-mono text-[9px] font-semibold tracking-[0.1em] text-ink uppercase"
      >
        Download {seriesCount} series
        <span className="text-ink-faint">{format}</span>
      </button>
    </div>
  );
}

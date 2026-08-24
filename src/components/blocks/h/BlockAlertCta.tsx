import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-ALERTCTA · Turn this into an alert — H · Gates
 *
 * "PRE-FILLS THE ALERT FROM THE PIECE'S OWN SUBJECT · THE BEST CTA IN THE PRODUCT"
 *
 * The pre-fill is the entire idea. A reader who has just read why NIM matters
 * for this bank should not then have to describe "this bank" and "NIM" to a
 * form — the piece already knows both. An empty subject field means the block
 * has become a generic "create an alert" button, which is the thing the card
 * says it must never be, so it is warned.
 *
 * It binds an ObjectRef (the subject), not a field: nothing here reads a value,
 * so there is no resolver and no unresolved path.
 */
export function BlockAlertCta({ node }: { node: BlockNodeOf<"BLK-ALERTCTA"> }) {
  const { kicker = "Keep watching this", headline, expected, subject = { entity: "", series: "", condition: "" }, ctaLabel } = node.payload;

  if (!subject.entity || !subject.series || !subject.condition) {
    warnConstraint(
      "BLK-ALERTCTA",
      "the alert subject is incomplete — the reader must not have to re-specify what the piece already knows.",
    );
  }

  return (
    <div className="my-5 border border-ink bg-paper-tint px-4 py-[14px]">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{kicker}</p>
      <div className="mt-2 font-display text-[15px] leading-[1.4] font-bold text-ink">{headline}</div>
      <div className="mt-1 font-mono text-[9px] tracking-[0.1em] text-ink-muted uppercase">
        {expected}
      </div>

      {/* The pre-fill, shown rather than implied — the reader can see it is already specified. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {[subject.entity, subject.series, subject.condition].filter(Boolean).map((part, i) => (
          <span
            key={i}
            className="border border-hairline px-[7px] py-[3px] font-mono text-[8.5px] tracking-[0.08em] text-ink-muted uppercase"
          >
            {part}
          </span>
        ))}
      </div>

      <button
        type="button"
        className="mt-3 inline-flex bg-ink px-3.5 py-[8px] font-mono text-[9px] font-semibold tracking-[0.1em] text-paper-tint uppercase"
      >
        {ctaLabel}
      </button>
    </div>
  );
}

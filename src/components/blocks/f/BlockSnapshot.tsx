import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-SNAPSHOT · Mini chart card — F · Wire
 *
 * "ONE SERIES, NO AXES, THREE LABELS MAX · THE WIRE'S ONLY PERMITTED CHART"
 *
 * It lives in F rather than D despite drawing a series, and that placement is the rule: no
 * D-family block may appear on the wire, so the wire gets exactly one chart and this is it. No
 * axes — at 84px with three labels an axis would imply a precision the card does not have.
 *
 * Bars are plain; the peak is ink; the latest takes its direction colour. An empty or all-null
 * series renders nothing rather than a flat baseline, because a flat line is a claim the data did
 * not make.
 */
const PLOT_H = 84;

export function BlockSnapshot({ node }: { node: BlockNodeOf<"BLK-SNAPSHOT"> }) {
  const { title, bars = [], peakIndex, latestIndex, latestDirection } = node.payload;

  const labelled = bars.filter((b) => b.label).length;
  if (labelled > 3) warnConstraint("BLK-SNAPSHOT", `${labelled} labels — the card shows at most three.`);

  const values = bars.map((b) => b.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) {
    return (
      <div className="my-3 border border-hairline px-3 py-2.5">
        <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{title}</div>
        <div className="mt-2 font-mono text-[8.5px] text-ink-faint uppercase">No series to draw</div>
      </div>
    );
  }
  const max = Math.max(...values, 0);

  return (
    <figure className="my-3 border border-hairline px-3 py-2.5">
      <figcaption className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
        {title}
      </figcaption>
      <div className="mt-2 flex items-end gap-[3px]" style={{ height: `${PLOT_H}px` }}>
        {bars.map((b, i) => {
          const v = b.value ?? 0;
          const h = max > 0 ? Math.max(1, Math.round((v / max) * PLOT_H)) : 1;
          const tone =
            i === latestIndex
              ? latestDirection === "down"
                ? "bg-negative"
                : "bg-positive"
              : i === peakIndex
                ? "bg-ink"
                : "bg-dark-text-faint";
          return <span key={i} className={`flex-1 ${tone}`} style={{ height: `${h}px` }} aria-hidden />;
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[7.5px] tracking-[0.08em] text-ink-faint uppercase">
        {bars.map((b, i) => (b.label ? <span key={i}>{b.label}</span> : null))}
      </div>
    </figure>
  );
}

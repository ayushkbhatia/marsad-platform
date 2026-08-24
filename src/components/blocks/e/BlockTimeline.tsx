import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-TIMELINE · Dates in order — E · Mechanism
 *
 * "EXACTLY ONE STAGE IN RED — THE ONE THAT COSTS MONEY IF MISSED"
 *
 * The single critical stage is the block's whole editorial claim. A timeline where everything is
 * urgent tells a reader nothing about what to do, and one where nothing is says the deadline does
 * not matter. So the count is warned in both directions rather than corrected — picking a critical
 * stage on the writer's behalf would be the renderer inventing the argument.
 *
 * Stages are equal-width columns in date order. The index is positional, never a payload field.
 */
export function BlockTimeline({ node }: { node: BlockNodeOf<"BLK-TIMELINE"> }) {
  const { stages } = node.payload;

  const critical = stages.filter((s) => s.isCritical).length;
  if (critical !== 1) {
    warnConstraint("BLK-TIMELINE", `${critical} critical stages — exactly one is the deadline that costs money.`);
  }
  const ordered = [...stages].every((s, i, a) => i === 0 || (a[i - 1]!.date <= s.date));
  if (!ordered) warnConstraint("BLK-TIMELINE", "stages are not in date order — the block reads left to right in time.");

  return (
    <div className="my-5 flex gap-3">
      {stages.map((s, i) => (
        <div
          key={`${s.name}-${i}`}
          className={`flex-1 pt-2.5 ${s.isCritical ? "bg-paper-tint" : ""}`}
          style={{
            borderTopWidth: "3px",
            borderTopStyle: "solid",
            borderTopColor: s.isCritical ? "var(--color-negative)" : "var(--color-ink)",
          }}
        >
          <div className="flex items-center gap-1.5 px-2">
            {s.isCritical ? (
              <span className="size-[5px] flex-none rotate-45 bg-negative" aria-hidden />
            ) : null}
            <span
              className={`font-mono text-[8px] tracking-[0.12em] uppercase ${
                s.isCritical ? "text-negative" : "text-ink-faint"
              }`}
            >
              {s.name}
            </span>
          </div>
          <div
            className={`mt-1 px-2 font-mono text-[11px] tabular-nums ${
              s.isCritical ? "font-bold text-negative" : "text-ink"
            }`}
          >
            {s.date}
          </div>
          <p className="mt-1 px-2 pb-2.5 font-display text-[11.5px] leading-[1.45] text-ink-muted">
            {s.description}
          </p>
        </div>
      ))}
    </div>
  );
}

import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-FLOW · Money flow — E · Mechanism
 *
 * "MAX 4 NODES, LEFT TO RIGHT · NEVER BRANCHES — USE BLK-DECISION"
 *
 * ── ARROW WEIGHT SHOWS SENIORITY, NOT SIZE ───────────────────────────────────
 * That inversion is the block's one real idea and it is worth stating twice: a subordinated claim
 * on a large sum is still subordinated, and drawing it thick because the number is big would say
 * precisely the opposite of what the diagram exists to say. So `seniority` drives the stroke and
 * `value` is only ever a label.
 *
 * Equity is always the pale box at the end; the operating node is the inverted ink box. Both are
 * declared rather than inferred, because "the last node" and "the equity node" are not the same
 * claim and a diagram that guessed would sometimes be wrong silently.
 */
export function BlockFlow({ node }: { node: BlockNodeOf<"BLK-FLOW"> }) {
  const { nodes = [], connectors = [] } = node.payload;

  if (nodes.length > 4) warnConstraint("BLK-FLOW", `${nodes.length} nodes — the block is at most four.`);
  if (connectors.length !== Math.max(0, nodes.length - 1)) {
    warnConstraint("BLK-FLOW", `${connectors.length} connectors for ${nodes.length} nodes — the flow never branches.`);
  }

  return (
    <div className="my-5 flex items-stretch gap-0 overflow-x-auto">
      {nodes.map((n, i) => (
        <div key={`${n.name}-${i}`} className="flex items-stretch">
          <div
            className={`min-w-[128px] px-3 py-2.5 ${
              n.isOperating
                ? "bg-ink text-paper-tint"
                : n.isTerminalEquity
                  ? "border border-hairline bg-paper-tint"
                  : "border border-hairline"
            }`}
          >
            <div
              className={`font-mono text-[8px] tracking-[0.12em] uppercase ${
                n.isOperating ? "text-dark-text-faint" : "text-ink-faint"
              }`}
            >
              {n.role}
            </div>
            <div
              className={`mt-1 font-display text-[13px] font-bold ${
                n.isOperating ? "text-paper-tint" : "text-ink"
              }`}
            >
              {n.name}
            </div>
            <div
              className={`mt-0.5 font-display text-[11px] leading-[1.4] ${
                n.isOperating ? "text-dark-text-mid" : "text-ink-muted"
              }`}
            >
              {n.qualifier}
            </div>
          </div>

          {i < connectors.length ? (
            <div className="flex w-16 flex-col items-center justify-center px-1">
              <span className="font-mono text-[7.5px] tracking-[0.08em] text-ink-faint uppercase">
                {connectors[i]!.label}
              </span>
              <span
                className="my-1 w-full"
                aria-hidden
                style={{
                  borderTopWidth: "2px",
                  borderTopStyle: "solid",
                  // seniority, never magnitude
                  borderTopColor:
                    connectors[i]!.seniority === "senior"
                      ? "var(--color-ink)"
                      : "var(--color-dark-text-faint)",
                }}
              />
              {connectors[i]!.value ? (
                <span className="font-mono text-[8px] text-ink-muted tabular-nums">
                  {connectors[i]!.value}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

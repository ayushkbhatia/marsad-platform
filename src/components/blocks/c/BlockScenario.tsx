import { directionTextClass, warnConstraint } from "../constraints";
import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-SCENARIO · Three paths — C · Tabular
 *
 * "EXACTLY THREE · BASE ROW TINTED · EVERY PATH NEEDS AN OBSERVABLE TRIGGER"
 *
 * Three, not two and not five: a bull, a base and a bear is a view; anything
 * else is either a false binary or a hedge. The trigger column is what stops
 * the block being a wish list — each path names the thing a reader could watch
 * for that would tell them which one is happening.
 */
const GRID = { gridTemplateColumns: "1.3fr 62px 68px 1fr" };

export function BlockScenario({ node }: { node: BlockNodeOf<"BLK-SCENARIO"> }) {
  const { title, rows } = node.payload;

  if (rows.length !== 3) {
    warnConstraint("BLK-SCENARIO", `${rows.length} scenarios — the block is exactly three paths.`);
  }
  const bases = rows.filter((r) => r.isBase);
  if (bases.length !== 1) {
    warnConstraint("BLK-SCENARIO", `${bases.length} rows marked base — exactly one is the desk's case.`);
  }
  rows.forEach((r) => {
    if (!r.trigger) warnConstraint("BLK-SCENARIO", `path "${r.name}" has no observable trigger.`);
  });

  return (
    <div>
      <div className="flex items-baseline gap-2.5 bg-ink px-3 py-[7px]">
        <span className="font-mono text-[9px] font-semibold tracking-[0.14em] text-paper-tint uppercase">
          {title}
        </span>
      </div>
      <div className="grid gap-2.5 border-b border-hairline px-3 pt-[7px] pb-[5px]" style={GRID}>
        <span className="font-mono text-[8px] text-ink-faint">SCENARIO</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">EPS</span>
        <span className="text-right font-mono text-[8px] text-ink-faint">RETURN</span>
        <span className="font-mono text-[8px] text-ink-faint">TRIGGER</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${i}`}
          className={`grid items-baseline gap-2.5 border-b border-hairline-faint px-3 py-[9px] ${
            r.isBase ? "bg-paper-tint" : ""
          }`}
          style={GRID}
        >
          <span className={`text-[12px] ${r.isBase ? "font-bold" : "font-semibold"} text-ink`}>
            {r.name}
          </span>
          <span className="text-right font-mono text-[11px] text-ink tabular-nums">
            <Val v={r.eps} />
          </span>
          <span
            className={`text-right font-mono text-[11px] font-bold tabular-nums ${directionTextClass(r.returnDirection)}`}
          >
            <Val v={r.returnPct} />
          </span>
          <span className="text-[11px] leading-[1.4] text-ink-muted">{r.trigger}</span>
        </div>
      ))}
    </div>
  );
}

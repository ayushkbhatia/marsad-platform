import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-FALSIFY · What would change this view — B · Statement
 *
 * "REQUIRED ON ANY PIECE WITH A VIEW · EACH ITEM MUST BE AN OBSERVABLE EVENT OR
 * A THRESHOLD — falsifiability is the feature, not a disclaimer."
 *
 * Note the deliberate asymmetry with BLK-THESIS: that card states "EXACTLY
 * THREE" as a rule, this one shows three as an example. So thesis warns off
 * three and this warns only at zero — reading an example as a rule would make
 * the newsroom refuse legitimate copy.
 */
export function BlockFalsify({ node }: { node: BlockNodeOf<"BLK-FALSIFY"> }) {
  const { kicker, falsifiers } = node.payload;

  if (falsifiers.length === 0) {
    warnConstraint("BLK-FALSIFY", "no falsifiers — a view with nothing that would change it is a disclaimer.");
  }

  return (
    <section className="border-t border-rule pt-4">
      <h2 className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
        {kicker || "WHAT WOULD CHANGE THIS VIEW"}
      </h2>
      <ul className="flex flex-col gap-[6px]">
        {falsifiers.map((f, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-[1.55] text-ink-mid">
            <span className="mt-[7px] h-[3px] w-[3px] flex-none bg-ink-faint" aria-hidden />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

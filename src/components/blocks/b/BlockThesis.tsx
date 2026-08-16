import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-THESIS · Argument in three lines — B · Statement
 *
 * "EXACTLY THREE LINES — not two, not four."
 *
 * The Zod schema carries `.length(3)` into the emitted JSON Schema so a model
 * cannot generate a fourth. This still counts, because a payload can reach the
 * page from a seed or a migration without ever passing through a model — and a
 * thesis card silently showing four claims is the card failing at its one job.
 */
export function BlockThesis({ node }: { node: BlockNodeOf<"BLK-THESIS"> }) {
  const { kicker, claims } = node.payload;

  if (claims.length !== 3) {
    warnConstraint("BLK-THESIS", `exactly three claims required, received ${claims.length}.`);
  }

  return (
    <section className="border-y border-rule py-4">
      <h2 className="mb-3 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
        {kicker || "THE ARGUMENT IN THREE LINES"}
      </h2>
      <ol className="flex flex-col gap-2">
        {claims.map((claim, i) => (
          <li key={i} className="flex gap-3 text-[13.5px] leading-[1.55] text-ink">
            <span className="mt-[3px] flex-none font-mono text-[10px] text-ink-faint" aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{claim}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

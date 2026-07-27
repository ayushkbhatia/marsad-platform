import { warnConstraint } from "../constraints";
import { interpolate } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-CITE · Citation chip — A · Inline
 *
 * "MANDATORY ON EVERY AI FACTUAL CLAIM (R-03) · BINDS LAKE.OBJECT.ID"
 *
 * The marker index is the renderer's, derived from position — a writer that
 * numbered its own chips could renumber a claim onto the wrong source. Each
 * chip resolves back to the lake object it cites.
 */
export function BlockCite({ node }: { node: BlockNodeOf<"BLK-CITE"> }) {
  const { hostText, citations } = node.payload;

  citations.forEach((c, i) => {
    if (!c.objectId) {
      warnConstraint("BLK-CITE", `citation ${i + 1} has no lake object id — R-03 requires one per claim.`);
    }
  });

  return (
    <div>
      <p className="font-display text-[15.5px] leading-[1.8] text-ink-soft">
        {interpolate("BLK-CITE", hostText, citations.length, (i) => (
          <span className="border border-hairline-strong px-1 font-mono text-[9px] text-ink-muted">
            {i + 1}
          </span>
        ))}
      </p>
      <div className="mt-[11px] border-t border-hairline-faint pt-2">
        {citations.map((c, i) => {
          const label = (
            <>
              [{i + 1}] {c.label}
            </>
          );
          return (
            <div key={c.objectId || i} className="py-0.5 text-[10.5px] text-ink">
              {c.href ? (
                <a href={c.href} className="underline decoration-hairline-strong">
                  {label}
                </a>
              ) : (
                label
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

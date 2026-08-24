import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-CORRECTION · Correction note — F · Wire
 *
 * "AMBER, NOT RED — A CORRECTION IS INTEGRITY · SAYS WHETHER THE ARGUMENT SURVIVED"
 *
 * The colour is an editorial position. Red is the palette's failure state; amber is its caution
 * state. A publication that renders its own corrections in red is telling readers that admitting
 * an error is a failure, and it will make fewer of them for the wrong reason. Amber says: this is
 * the system working.
 *
 * "SAYS WHETHER THE ARGUMENT SURVIVED" is the field that makes the note useful rather than
 * ceremonial. A reader who learns a number changed still cannot act unless they know whether the
 * conclusion it supported still stands — so `argumentSurvived` is a required boolean, and the
 * block prints it either way.
 */
export function BlockCorrection({ node }: { node: BlockNodeOf<"BLK-CORRECTION"> }) {
  const { originalAt, correctedAt, correctedValue, wrongValue, why, remediation, argumentSurvived, ruleId } =
    node.payload;

  if (correctedValue === wrongValue) {
    warnConstraint("BLK-CORRECTION", "the corrected value equals the wrong one — there is nothing to correct.");
  }

  return (
    <div
      className="my-4 bg-paper-tint px-4 py-3"
      style={{ borderLeftWidth: "3px", borderLeftStyle: "solid", borderLeftColor: "var(--color-caution)" }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className="px-[7px] py-[2px] font-mono text-[8.5px] font-semibold tracking-[0.12em] text-ink uppercase"
          style={{ background: "var(--color-caution)" }}
        >
          Revised
        </span>
        <span className="font-mono text-[8.5px] text-ink-faint">
          {originalAt} → {correctedAt}
        </span>
        {ruleId ? <span className="font-mono text-[8px] text-ink-faint uppercase">{ruleId}</span> : null}
      </div>

      <p className="mt-2.5 font-display text-[13px] leading-[1.5] text-ink">
        <span className="line-through decoration-ink-faint">{wrongValue}</span>{" "}
        <span className="font-bold">{correctedValue}</span>
      </p>

      <dl className="mt-2">
        {[
          ["Why it was wrong", why],
          ["What was done", remediation],
        ].map(([k, v]) => (
          <div key={k} className="mt-1.5">
            <dt className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">{k}</dt>
            <dd className="font-display text-[12px] leading-[1.5] text-ink-muted">{v}</dd>
          </div>
        ))}
      </dl>

      {/* Printed either way — the reader cannot act on a changed number without this. */}
      <p className="mt-2.5 border-t border-hairline pt-2 font-mono text-[9px] font-semibold tracking-[0.1em] uppercase">
        {argumentSurvived ? (
          <span className="text-ink">The conclusion still stands</span>
        ) : (
          <span className="text-negative">The conclusion does not survive this correction</span>
        )}
      </p>
    </div>
  );
}

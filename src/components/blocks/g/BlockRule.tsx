import { warnConstraint } from "../constraints";
import { isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-RULE · Rule applied — G · Provenance & trust
 *
 * "WHEN A RULE VISIBLY SHAPED THE COPY · CITES THE ID FROM THE PUBLISHING RULESET"
 * "NAMING THE RULE IS THE POINT — THE READER LEARNS THE HOUSE STANDARD BY
 *  SEEING IT ENFORCED"
 *
 * Which is why an unnamed rule is a warning, not a silent omission: a block
 * that says "a rule was applied" without saying which one teaches nothing.
 */
export function BlockRule({ node }: { node: BlockNodeOf<"BLK-RULE"> }) {
  const { ruleId, requirement, shapedThisPiece, automatedCheck } = node.payload;

  if (!ruleId) {
    warnConstraint("BLK-RULE", "no rule id — the block must cite the publishing-ruleset id.");
  }

  return (
    <div className="border-l-[3px] border-negative bg-paper-tint px-3 py-[11px]">
      <p className="text-[11.5px] leading-[1.6] text-ink-mid">
        <b className="font-semibold text-ink">Rule {ruleId || "—"} applied:</b> {requirement}
        {isBound(shapedThisPiece) ? ` ${shapedThisPiece}` : ""}
        {isBound(automatedCheck) ? ` ${automatedCheck}` : ""}
      </p>
    </div>
  );
}

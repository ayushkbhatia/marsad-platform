import { warnConstraint } from "../constraints";
import { Diamond, isBound } from "../primitives";
import type { BlockNodeOf, ProvStatus } from "../types";

/*
 * BLK-PROV · Lake object stamp — G · Provenance & trust
 *
 * "MANDATORY UNDER EVERY CHART AND TABLE · NAMES OBJECT, AGENT AND SOURCE CLASS"
 *
 * Hard rule 2 of the system, half of it: every number carries a provenance
 * stamp (the other half is BLK-FRESH). This is why family G is built first —
 * it is the footer every other family needs.
 */

/** GREEN DIAMOND = VERIFIED · INK = DESK COMPUTATION · AMBER = PENDING. */
const MARK: Record<ProvStatus, { dot: string; verb: string }> = {
  verified: { dot: "bg-positive", verb: "VERIFIED BY" },
  desk: { dot: "bg-ink", verb: "DESK COMPUTATION BY" },
  pending: { dot: "bg-caution", verb: "PENDING VERIFICATION BY" },
};

export function BlockProv({ node }: { node: BlockNodeOf<"BLK-PROV"> }) {
  const p = node.payload;
  const mark = MARK[p.status] ?? MARK.pending;

  // "Must name object, agent AND source class — all three." A stamp missing one
  // of them is not a weaker stamp, it is not a stamp.
  if (!p.objectType) warnConstraint("BLK-PROV", "no lake object type — the stamp names nothing.");
  if (!p.agent) warnConstraint("BLK-PROV", "no verifying agent named.");
  if (!p.sourceClass) warnConstraint("BLK-PROV", "no source class named.");

  const object = isBound(p.entity) ? `${p.objectType} · ${p.entity}` : p.objectType;
  const segments: string[] = [];
  if (isBound(p.coverage)) segments.push(p.coverage);
  segments.push(
    isBound(p.verifiedAt) ? `${mark.verb} ${p.agent || "—"} ${p.verifiedAt}` : `${mark.verb} ${p.agent || "—"}`,
  );
  segments.push(p.sourceClass || "—");

  return (
    <div className="flex items-center gap-2.5 border border-hairline bg-paper-tint px-3 py-2">
      <Diamond className={mark.dot} />
      <span className="font-mono text-[8px] leading-[1.7] tracking-[0.08em] text-ink-muted">
        LAKE OBJECT <b className="font-semibold">{object || "—"}</b>
        {segments.map((s) => ` · ${s}`).join("")}
      </span>
    </div>
  );
}

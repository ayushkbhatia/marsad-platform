import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-ANATOMY · Annotated document — E · Mechanism
 *
 * "ABSTRACTED WIREFRAME, NEVER A SCREENSHOT · TEACHES WHERE TO LOOK"
 *
 * The wireframe is abstract on purpose and it is not a licensing dodge: a screenshot teaches a
 * reader to recognise ONE filing's layout, which changes between venues and between years. An
 * abstracted rail teaches where to look in any of them.
 *
 * The three highlight classes carry the whole lesson — red is the figure that changes your cash,
 * ink is the date block, grey is boilerplate to skip — so a region with no class would be an
 * annotation that teaches nothing.
 */
const REGION_CLASS: Record<string, string> = {
  critical: "border-negative",
  secondary: "border-ink",
  boilerplate: "border-hairline",
};
const REGION_FILL: Record<string, string> = {
  critical: "rgba(192,52,43,.08)",
  secondary: "rgba(20,18,14,.06)",
  boilerplate: "transparent",
};
const SWATCH_CLASS: Record<string, string> = {
  critical: "bg-negative",
  secondary: "bg-ink",
  boilerplate: "bg-hairline-strong",
};

export function BlockAnatomy({ node }: { node: BlockNodeOf<"BLK-ANATOMY"> }) {
  const { documentType, regions, annotations } = node.payload;

  if (!regions.some((r) => r.highlight === "critical")) {
    warnConstraint("BLK-ANATOMY", "no critical region — the block exists to point at the figure that changes your cash.");
  }

  return (
    <div className="my-5 flex gap-4">
      {/* 172px fixed wireframe rail beside the annotation list, per the card. */}
      <div className="w-[172px] flex-none border border-hairline bg-paper p-2">
        <div className="font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">
          {documentType}
        </div>
        <div className="mt-2 flex flex-col gap-1.5" aria-hidden>
          {regions.map((r, i) => (
            <div
              key={i}
              className={`h-3 border ${REGION_CLASS[r.highlight] ?? "border-hairline"}`}
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, r.width)) * 100)}%`,
                background: REGION_FILL[r.highlight] ?? "transparent",
              }}
            />
          ))}
        </div>
      </div>

      <ul className="flex-1">
        {annotations.map((a, i) => (
          <li key={i} className="flex gap-2.5 border-b border-hairline-faint py-2 last:border-b-0">
            <span
              className={`mt-[5px] size-[7px] flex-none ${SWATCH_CLASS[a.swatch] ?? "bg-hairline-strong"}`}
              aria-hidden
            />
            <div>
              <div className="font-display text-[12.5px] font-bold text-ink">{a.title}</div>
              <div className="mt-0.5 font-display text-[12px] leading-[1.5] text-ink-muted">{a.why}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

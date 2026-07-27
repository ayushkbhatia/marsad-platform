import type { ReactNode } from "react";
import { warnConstraint } from "./constraints";
import type { BlockCode, BoundValue } from "./types";

/*
 * Shared marks used by more than one block. Everything here is a server
 * component: no state, no effects, no client boundary.
 */

/**
 * A bound value, or the honest em-dash.
 *
 * The standing law of the codebase: where a value is missing we render the gap.
 * Never a plausible number, never a zero, never a "n/a" that reads like data.
 */
export function Val({ v }: { v: BoundValue }) {
  if (v === null || v === undefined || v === "") {
    return <span className="text-ink-faint">—</span>;
  }
  return <>{v}</>;
}

/** True when a bound value actually resolved to something printable. */
export function isBound(v: BoundValue | undefined): v is string {
  return typeof v === "string" && v !== "";
}

/**
 * The mono note that sits under a table or grid — the block's own footnote,
 * e.g. BLK-FINTABLE's explanation of the estimate marking.
 *
 * `text-dark-text-faint` is #a8a396. The token file names that hex only under
 * `color.dark.text.faint`, but the artifact library uses it on PAPER for exactly
 * this de-emphasised note (docs/design/README.md confirms both palettes agree on
 * #a8a396). It is the right value under an awkward name — do not read this as a
 * dark-surface element.
 */
export function BlockFootnote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 font-mono text-[8px] leading-[1.7] text-dark-text-faint">{children}</div>
  );
}

/** The rotated 6px square used as a provenance / conflict marker. */
export function Diamond({ className, size = 6 }: { className: string; size?: number }) {
  return (
    <span
      className={`flex-none rotate-45 ${className}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden
    />
  );
}

/**
 * Substitute numbered slots — `{0}`, `{1}` — in an inline block's host sentence
 * with its bound units.
 *
 * Family A lives inside running prose, so the writer emits the sentence and
 * marks where each unit sits. A slot with no unit behind it is a binding
 * failure: it is logged and the raw placeholder is left visible rather than
 * silently swallowed, because a sentence that quietly loses its number reads as
 * complete when it is not.
 */
export function interpolate(
  code: BlockCode,
  hostText: string,
  unitCount: number,
  renderUnit: (index: number) => ReactNode,
): ReactNode[] {
  const parts = hostText.split(/(\{\d+\})/g);
  const seen = new Set<number>();
  const out: ReactNode[] = [];

  parts.forEach((part, i) => {
    const m = /^\{(\d+)\}$/.exec(part);
    if (!m) {
      if (part !== "") out.push(<span key={`t${i}`}>{part}</span>);
      return;
    }
    const index = Number(m[1]);
    if (index >= unitCount) {
      warnConstraint(code, `host text references slot {${index}} but only ${unitCount} unit(s) were bound.`);
      out.push(
        <span key={`m${i}`} className="font-mono text-[10px] text-caution">
          {part}
        </span>,
      );
      return;
    }
    seen.add(index);
    out.push(<span key={`u${i}`}>{renderUnit(index)}</span>);
  });

  for (let i = 0; i < unitCount; i++) {
    if (!seen.has(i)) {
      warnConstraint(code, `unit ${i} was bound but the host text has no {${i}} slot for it.`);
    }
  }
  return out;
}

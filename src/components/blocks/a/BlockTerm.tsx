import { interpolate, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-TERM · Defined term — A · Inline
 *
 * "FIRST USE ONLY · DOTTED RULE, NEVER LINK BLUE · BINDS GLOSSARY.TERM"
 *
 * The dotted ink underline is load-bearing: it is how a defined term reads as
 * defined without reaching for a second accent. Never link blue.
 *
 * The definition card renders in normal flow beneath the prose, exactly as the
 * specimen draws it — which is also what survives print and email, where a
 * hover tooltip does not exist. A term with no `definition` gets the dotted
 * rule and no card (the specimen's second term, "record date", is that case).
 * Feeds BLK-GLOSSARY, which is family E and not built this pass.
 */
export function BlockTerm({ node }: { node: BlockNodeOf<"BLK-TERM"> }) {
  const { hostText, terms } = node.payload;
  const defined = terms.filter((t) => isBound(t.definition));

  return (
    <div>
      <p className="font-display text-[16px] leading-[1.7] text-ink-soft">
        {interpolate("BLK-TERM", hostText, terms.length, (i) => (
          <span
            className="cursor-help border-b border-dotted border-ink font-semibold"
            title={isBound(terms[i].definition) ? terms[i].definition : undefined}
          >
            {terms[i].term}
          </span>
        ))}
      </p>
      {defined.map((t) => (
        <div
          key={t.glossaryKey}
          className="mt-[11px] max-w-[290px] border border-ink bg-paper-tint px-3 py-2.5"
        >
          <div className="font-mono text-[8px] tracking-[0.12em] text-ink-faint uppercase">
            {isBound(t.label) ? t.label : t.term}
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.55] text-ink-mid">{t.definition}</p>
        </div>
      ))}
    </div>
  );
}

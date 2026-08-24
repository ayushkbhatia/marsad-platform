import type { BlockNodeOf } from "../types";

/**
 * BLK-GLOSSARY · Terms on this page — E · Mechanism (rail)
 *
 * "AUTO-ASSEMBLED FROM EVERY BLK-TERM ON THE PAGE · SHARED STORE WITH LEARN"
 *
 * A writer agent does not author this block. It emits `BLK-TERM` where a term first appears and
 * this follows, assembled by the projector from those instances against the shared store. That is
 * why there is no constraint check here: there is no author to warn, and an empty glossary means
 * the page used no terms rather than that someone forgot to fill one in.
 *
 * Single-sourcing with Learn is the point — a definition that differs between the rail and the
 * Learn hub is worse than one that appears only once.
 */
export function BlockGlossary({ node }: { node: BlockNodeOf<"BLK-GLOSSARY"> }) {
  const { terms } = node.payload;
  if (terms.length === 0) return null;

  return (
    <aside className="my-5 border-t-2 border-ink pt-2.5">
      <div className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink uppercase">
        Terms on this page
      </div>
      <dl className="mt-2">
        {terms.map((t, i) => (
          <div key={i} className="border-b border-hairline-faint py-2 last:border-b-0 last:pb-0">
            <dt className="font-mono text-[10px] font-semibold tracking-[0.06em] text-ink uppercase">
              {t.term}
            </dt>
            <dd className="mt-0.5 font-display text-[12px] leading-[1.5] text-ink-muted">
              {t.definition}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

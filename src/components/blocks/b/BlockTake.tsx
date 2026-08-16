import type { BlockNodeOf } from "../types";

/*
 * BLK-TAKE · Marsad Take · gated — B · Statement
 *
 * The headline stays readable; the judgement does not.
 *
 * ⚠️ The blur here is PRESENTATION, not the gate. RLS on public.content_blocks
 * withholds gated rows entirely, so an unentitled reader never receives this
 * payload — the body is not in the HTML to be un-blurred. That ordering matters:
 * a CSS mask over premium prose that was still shipped to the client is the bug
 * this codebase already fixed once, and it must not come back through a block.
 */
export function BlockTake({ node }: { node: BlockNodeOf<"BLK-TAKE"> }) {
  const { headline, body, badge, unlockCtaLabel, entitlement } = node.payload;
  const locked = entitlement === "locked";

  return (
    <section className="border border-rule px-4 py-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="border border-ink px-[5px] py-[1px] font-mono text-[8px] uppercase tracking-[0.12em] text-ink">
          {badge || "PREMIUM"}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
          MARSAD TAKE
        </span>
      </div>
      <p className="text-[15px] leading-[1.45] text-ink">{headline}</p>
      {locked ? (
        <>
          <p aria-hidden className="mt-2 select-none text-[13px] leading-[1.55] text-ink-mid blur-[5px]">
            {body}
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-ink">
            {unlockCtaLabel || "Unlock the take →"}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] leading-[1.55] text-ink-mid">{body}</p>
      )}
    </section>
  );
}

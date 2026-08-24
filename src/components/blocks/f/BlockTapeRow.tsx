import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/**
 * BLK-TAPEROW · Tape entry — F · Wire
 *
 * "TIME IN THE GUTTER, VENUE UNDER IT · MAX 40 WORDS FOR AGENT AUTO-PUBLISH"
 *
 * The 40 words are not a style preference. It is the same number the rules engine enforces
 * (`AUTO_WORD_CAP_DEFAULT`) and that `fn_enforce_agent_publish_gate` checks in the database: the
 * wire is the one lane where an agent may publish without a human, and the cap is what makes that
 * defensible. Warned here so the overrun is visible while writing, then refused upstream.
 */
export function BlockTapeRow({ node }: { node: BlockNodeOf<"BLK-TAPEROW"> }) {
  const { time, venue, category, reference, headline, body } = node.payload;

  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words > 40) {
    warnConstraint("BLK-TAPEROW", `${words} words — the wire's auto-publish cap is 40.`);
  }

  return (
    <article className="flex gap-3 border-b border-hairline py-3">
      {/* 66px fixed gutter: time above, venue under it. */}
      <div className="w-[66px] flex-none">
        <div className="font-mono text-[11px] font-semibold text-ink tabular-nums">{time}</div>
        <div className="mt-0.5 font-mono text-[7.5px] tracking-[0.1em] text-ink-faint uppercase">
          {venue}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="border border-hairline px-[6px] py-[2px] font-mono text-[8px] tracking-[0.1em] text-ink-muted uppercase">
            {category}
          </span>
          <span className="font-mono text-[8.5px] text-ink-faint">{reference}</span>
        </div>
        <h3 className="mt-1.5 font-display text-[17px] leading-[1.3] text-ink">{headline}</h3>
        <p className="mt-1 font-display text-[12.5px] leading-[1.55] text-ink-muted">{body}</p>
      </div>
    </article>
  );
}

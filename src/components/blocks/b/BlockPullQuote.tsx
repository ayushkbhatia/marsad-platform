import type { BlockNodeOf } from "../types";

/*
 * BLK-PULLQUOTE · Pull quote — B · Statement
 *
 * "MUST BE A HUMAN VOICE — NEVER A RESTATED STATISTIC." That is a judgement
 * about what the sentence IS, so it cannot live in a schema; it is a fit-stage
 * lint. The renderer's job is narrower: supply the quotation marks (the payload
 * deliberately does not carry them) and set the voice apart from the measure.
 */
export function BlockPullQuote({ node }: { node: BlockNodeOf<"BLK-PULLQUOTE"> }) {
  const { quote, attribution } = node.payload;

  return (
    <figure className="border-l-2 border-ink py-1 pl-4">
      <blockquote className="text-[19px] leading-[1.4] text-ink">
        {"“"}
        {quote}
        {"”"}
      </blockquote>
      <figcaption className="mt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
        {"— "}
        {attribution}
      </figcaption>
    </figure>
  );
}

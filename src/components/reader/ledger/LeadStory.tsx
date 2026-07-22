import Link from "next/link";
import type { NewsroomItemDetail } from "@/lib/data/newsroom";
import { newsroomItemHref } from "@/lib/data/newsroom";
import { fmtDateTime } from "@/lib/reader/format";

/**
 * Ledger front page (1b) lead-story slot — the autonomous newsroom's most
 * recent published WIRE, given the design's full-width hero treatment
 * (`text-article-title`, the 41px Newsreader lead headline token). This is
 * the SAME `listNewsroomContent({ contentTypes: ["WIRE"] })` read the page
 * already made pre-1b (`WireCard`'s "From the newsroom" section) — only the
 * shape changed, from a bordered card to the design's bare hero: kicker,
 * headline, dek, byline row. The full cited body still lives one click away
 * at `/wire/[slug]` (`WireCitedBody`) — 1b's hero is a teaser, not the whole
 * piece, matching how the design's other front-page leads work.
 *
 * No photo: the design shows a placeholder plate for a lead photo, but
 * nothing in the newsroom content model carries an image today — rendering
 * a decorative stand-in for an asset that will never load would be exactly
 * the "fabricate what's missing" failure mode the reader's empty-state law
 * forbids (README empty-state law; `EmptyState`'s "AWAITING FEED" posture).
 * The hero degrades to a text-only lead instead.
 */
export function LedgerLeadStory({ item }: { item: NewsroomItemDetail }) {
  const href = newsroomItemHref(item);
  const retracted = item.status === "retracted";
  const kicker = item.kicker ?? (item.contentType === "WIRE" ? "Newsroom wire" : item.contentType);

  return (
    <div className="flex flex-col gap-3 border-b border-ink pb-6">
      <div className="flex items-center gap-2">
        <span className="font-ui text-[11px] font-bold tracking-[0.2em] text-ink uppercase">{kicker}</span>
        {retracted ? (
          <span className="border border-negative px-1.5 py-px font-mono text-[8.5px] font-semibold tracking-[0.1em] text-negative uppercase">
            Retracted
          </span>
        ) : null}
      </div>

      <Link
        href={href}
        className="text-balance font-display text-article-title font-bold leading-[1.1] tracking-[-0.015em] text-ink hover:underline underline-offset-4"
      >
        {item.headline}
      </Link>

      {item.dek ? (
        <p className="max-w-[760px] font-display text-[17px] leading-[1.5] text-ink-mid">{item.dek}</p>
      ) : null}

      {retracted && item.retractionNotice ? (
        <p className="max-w-[760px] border-l-2 border-negative bg-paper-tint px-3.5 py-2.5 font-display text-[14.5px] italic leading-[1.55] text-ink-muted">
          {item.retractionNotice}
        </p>
      ) : null}

      <div className="flex items-baseline gap-2.5 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
        <span className="font-semibold text-ink">{item.bylineLabel}</span>
        <span>· {fmtDateTime(item.publishedAt)}</span>
        <Link
          href={href}
          className="ml-auto text-ink underline decoration-1 underline-offset-[3px] tracking-[0.04em] hover:text-ink-muted"
        >
          Read the full wire →
        </Link>
      </div>
    </div>
  );
}

import Link from "next/link";
import type { SearchHit, SearchSecurityDetail } from "@/lib/data/search";
import { toRating, sectorLabel, venueName, fmtPrice, fmtSignedPct } from "@/lib/reader/format";

/**
 * 16a "Top match" card — the strongest identity hit (a security), with a live-ish
 * quote + headline Score, matching the design's Aramco example. Server component,
 * slice-private (search's own composition — the compact score+rating pill here
 * doesn't match any existing `src/components/ui/*` primitive, so it's built inline
 * rather than force-fitting `ScoreModule`/`RatingBadge`, which are shaped for
 * bigger card/standalone-badge contexts).
 */
export function SearchTopMatch({ hit }: { hit: SearchHit & { detail: SearchSecurityDetail } }) {
  const rating = toRating(hit.detail.rating);
  const chg = hit.detail.changePct;
  const dirClass = chg == null || chg === 0 ? "text-ink-muted" : chg > 0 ? "text-positive" : "text-negative";

  return (
    <div>
      <div className="mb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
        Top match
      </div>
      <Link
        href={hit.url}
        className="flex flex-wrap items-center gap-4 border border-ink bg-paper px-4 py-4 text-ink no-underline transition-colors hover:bg-paper-tint sm:flex-nowrap"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-[13px] font-semibold text-ink">{hit.ticker}</span>
            <span className="font-display text-[20px] font-bold leading-tight text-ink">{hit.title}</span>
          </div>
          <div className="mt-1 font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
            {venueName(hit.detail.venueCode)} · {sectorLabel(hit.detail.sector)}
          </div>
        </div>

        <div className="flex-none text-right">
          <div className="font-display text-[20px] font-semibold tabular-nums text-ink">
            {fmtPrice(hit.detail.last)}
          </div>
          <div className={`font-ui text-[11px] font-semibold tabular-nums ${dirClass}`}>
            {fmtSignedPct(hit.detail.changePct)}
          </div>
        </div>

        {hit.detail.score != null && rating ? (
          <span className="flex-none bg-ink px-2 py-[3px] font-mono text-[9px] font-bold tracking-[0.04em] text-paper-tint">
            {hit.detail.score} · {rating.toUpperCase()}
          </span>
        ) : null}
      </Link>
    </div>
  );
}

import Link from "next/link";
import { LiveStatus } from "./LiveStatus";

/**
 * Center-column header (1d): the "The Wire" Newsreader H1, the WIRE |
 * FILINGS REGISTER segmented toggle (WIRE is always the active face here —
 * REGISTER routes to the formal `/filings` register), and the live status.
 */
export function WireHeader({ todayCount, venue }: { todayCount: number; venue?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b-2 border-ink pb-2">
      <h1 className="font-display text-[23px] font-bold text-ink">The Wire</h1>

      <span className="flex border border-hairline-strong">
        <span className="bg-ink px-3 py-[5px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">
          Wire
        </span>
        <Link
          href="/filings"
          className="px-3 py-[5px] font-ui text-[10px] font-semibold tracking-[0.06em] text-ink-muted uppercase no-underline hover:text-ink"
        >
          Filings register →
        </Link>
      </span>

      <LiveStatus todayCount={todayCount} venue={venue} />
    </div>
  );
}

import Link from "next/link";
import { SectionBar, PromoCard } from "@/components/ui";
import { venueName } from "@/lib/reader/format";
import type { WireVenueFacet } from "@/lib/data/wire";

/**
 * Left rail (1d): FILTER (filing-type facet, active row inverted to ink) →
 * VENUE (checklist, filled square = included in the current view) → the
 * "turn this view into an alert" `PromoCard`. Both facet lists are links
 * that toggle a single `?venue=`/`?type=` search param — clicking the
 * already-active row clears it back to "all".
 */

export interface WireLeftRailProps {
  categories: Array<{ type: string; count: number }>;
  venues: WireVenueFacet[];
  activeType?: string;
  activeVenue?: string;
  hrefFor: (next: { venue?: string; type?: string }) => string;
}

export function WireLeftRail({ categories, venues, activeType, activeVenue, hrefFor }: WireLeftRailProps) {
  return (
    <aside className="lg:border-r lg:border-hairline lg:pr-6">
      <SectionBar label="Filter" variant="rule" />
      <nav className="flex flex-col pt-1.5">
        {categories.map((c) => {
          const active = activeType === c.type;
          return (
            <Link
              key={c.type}
              href={hrefFor({ type: active ? undefined : c.type })}
              className={
                active
                  ? "flex items-baseline gap-2 bg-ink px-[9px] py-[7px] text-paper-tint"
                  : "flex items-baseline gap-2 border-b border-hairline-faint px-[9px] py-[7px] text-ink-mid hover:text-ink"
              }
            >
              <span className={`text-[12.5px] uppercase ${active ? "font-bold" : ""}`}>{c.type}</span>
              <span
                className={`ml-auto font-mono text-[9.5px] ${active ? "text-hairline-strong" : "text-[#a8a396]"}`}
              >
                {c.count.toLocaleString("en-US")}
              </span>
            </Link>
          );
        })}
      </nav>

      <SectionBar label="Venue" variant="rule" className="mt-6" />
      <nav className="flex flex-col pt-1.5">
        {venues.map((v) => {
          const checked = !activeVenue || activeVenue === v.venue;
          return (
            <Link
              key={v.venue}
              href={hrefFor({ venue: activeVenue === v.venue ? undefined : v.venue })}
              className="flex items-center gap-[9px] border-b border-hairline-faint px-0.5 py-[6.5px] text-ink-mid hover:text-ink"
            >
              <span
                className={`grid h-[11px] w-[11px] flex-none place-items-center border-[1.5px] border-ink ${checked ? "bg-ink" : "bg-transparent"}`}
                aria-hidden
              >
                {checked ? <span className="h-[5px] w-[5px] bg-paper-tint" /> : null}
              </span>
              <span className="text-[12px]">{venueName(v.venue).split(" · ").pop() ?? v.venue}</span>
              <span className="ml-auto font-mono text-[9.5px] text-[#a8a396]">
                {v.count.toLocaleString("en-US")}
              </span>
            </Link>
          );
        })}
      </nav>

      <PromoCard
        className="mt-6"
        label="Wire alert"
        headline="Turn this view into an alert"
        body="Email or push the moment a new item matches these filters."
        ctaText="Create alert"
        ctaHref="/alerts"
      />
    </aside>
  );
}

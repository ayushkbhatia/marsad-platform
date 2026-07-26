import Link from "next/link";
import type { WireCategory, WireVenue } from "@/lib/contracts/newswire";

/**
 * Newswire (1d) left filter rail (232px) — the category filter list (the one
 * selected row is a solid-ink block, the rest are plain rows with mono
 * counts), the venue checklist (all pre-checked), and the "turn this view
 * into an alert" CTA card.
 *
 * LIVE as of P2.2 — counts are real `public.filings` facets and both rails
 * filter for real (`/wire?type=…&venue=…`). The venue checkbox becomes a
 * toggle link when the adapter supplies `venue.href`; without one it renders
 * exactly as before (a static design mark), so the sample still works.
 */
function RailHeader({ label }: { label: string }) {
  return (
    <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
      {label}
    </div>
  );
}

export function NewswireFilterRail({
  categories,
  venues,
}: {
  categories: WireCategory[];
  venues: WireVenue[];
}) {
  return (
    <div className="lg:border-r lg:border-hairline lg:pr-6">
      <RailHeader label="Filter" />
      <div className="flex flex-col pt-1.5">
        {categories.map((c) =>
          c.selected ? (
            <div
              key={c.name}
              className="flex items-baseline gap-2 bg-ink px-[9px] py-[7px] text-paper-tint"
            >
              <span className="text-[12.5px] font-bold">{c.name}</span>
              <span className="ml-auto font-mono text-[9.5px] text-hairline-strong">{c.count}</span>
            </div>
          ) : (
            <Link
              key={c.name}
              href={c.href}
              className="flex items-baseline gap-2 border-b border-hairline-faint px-[9px] py-[7px] hover:bg-paper-tint"
            >
              <span className="text-[12.5px] text-ink-mid">{c.name}</span>
              <span className="ml-auto font-mono text-[9.5px] text-[#a8a396]">{c.count}</span>
            </Link>
          ),
        )}
      </div>

      <div className="mt-6">
        <RailHeader label="Venue" />
      </div>
      <div className="flex flex-col pt-1.5">
        {venues.map((v) => {
          const row = (
            <>
              <span
                className={`grid h-[11px] w-[11px] flex-none place-items-center border-[1.5px] border-ink ${
                  v.checked ? "bg-ink" : "bg-transparent"
                }`}
                aria-hidden
              >
                {v.checked ? <span className="h-[5px] w-[5px] bg-paper-tint" /> : null}
              </span>
              <span className={`text-[12px] ${v.checked ? "text-ink-mid" : "text-ink-faint"}`}>{v.name}</span>
              <span className="ml-auto font-mono text-[9.5px] text-[#a8a396]">{v.count}</span>
            </>
          );
          const cls = "flex items-center gap-[9px] border-b border-hairline-faint px-0.5 py-[6.5px]";
          return v.href ? (
            <Link key={v.code ?? v.name} href={v.href} className={`${cls} hover:bg-paper-tint`}>
              {row}
            </Link>
          ) : (
            <div key={v.code ?? v.name} className={cls}>
              {row}
            </div>
          );
        })}
      </div>

      <div className="mt-6 border border-ink bg-paper-tint px-3.5 py-[13px]">
        <div className="text-[12.5px] font-bold leading-[1.35] text-ink">Turn this view into an alert</div>
        <div className="mt-[5px] text-[11px] leading-[1.5] text-ink-muted">
          Email or push the moment a new item matches these filters.
        </div>
        <span className="mt-2.5 inline-block cursor-not-allowed bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.08em] text-paper-tint uppercase">
          Create alert
        </span>
      </div>
    </div>
  );
}

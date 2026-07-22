"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarketOpen } from "@/lib/hooks/usePulse";

/**
 * Row 3 of the desktop masthead (`MarsadNav`, ~44px) — the 8-tab section bar
 * with a 3px inset active underline (`MarsadNav.dc.html`:
 * `box-shadow: inset 0 -3px 0 #14120e`) plus the markets-open/closed status
 * dot on the right.
 *
 * `usePathname` is a request-time read, so the caller wraps `<NavTabs />` in
 * `<Suspense fallback={<NavTabsFallback />}>` — the same cacheComponents
 * rule already applied to `MobileNavDrawer` in this file's sibling.
 *
 * `Watchlist` has no route yet — member surfaces (`(member)/watchlist`) are
 * `[BLOCKED-BY: auth]` (docs/FORWARD-BUILD.md §S6/S7, no `(auth)` group
 * exists in this build). It renders as an inert stub using the same
 * `cursor-not-allowed` + `title="… — coming soon"` convention already used
 * for other not-yet-built affordances (`(reader)/compare`,
 * `(reader)/analysts/apply`) rather than linking to a 404.
 */

interface NavTab {
  label: string;
  href: string | null;
  match: (pathname: string) => boolean;
}

const section = (href: string) => (p: string) => p === href || p.startsWith(`${href}/`);

export const NAV_TABS: readonly NavTab[] = [
  { label: "Today", href: "/", match: (p) => p === "/" },
  { label: "Newswire", href: "/wire", match: section("/wire") },
  { label: "Heatmap", href: "/heatmap", match: section("/heatmap") },
  {
    label: "Screener",
    href: "/screener",
    // Saved screens live at /screens/[id], not nested under /screener.
    match: (p) => section("/screener")(p) || section("/screens")(p),
  },
  { label: "IPOs", href: "/ipo", match: section("/ipo") },
  { label: "Research", href: "/research", match: section("/research") },
  { label: "Analysts", href: "/analysts", match: section("/analysts") },
  { label: "Watchlist", href: null, match: () => false },
];

const TAB_BASE = "flex items-center font-ui text-[13.5px]";
const TAB_INACTIVE = `${TAB_BASE} font-medium text-ink-muted`;

function MarketStatus() {
  const open = useMarketOpen();
  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <span className="font-ui text-[11px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
        {open ? "Markets open" : "Markets closed"}
      </span>
      <span
        className={`h-[7px] w-[7px] flex-none rounded-full ${open ? "bg-positive" : "bg-ink-faint"}`}
        aria-hidden
      />
    </div>
  );
}

export function NavTabs() {
  const pathname = usePathname();

  return (
    <div className="h-[44px] border-b border-hairline-strong">
      <div className="mx-auto flex h-full max-w-[1440px] items-stretch gap-7 px-7">
        {NAV_TABS.map((tab) => {
          if (!tab.href) {
            return (
              <span
                key={tab.label}
                aria-disabled="true"
                title="Watchlist — coming soon"
                className={`${TAB_INACTIVE} cursor-not-allowed opacity-70`}
              >
                {tab.label}
              </span>
            );
          }
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.label}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? `${TAB_BASE} font-bold text-ink shadow-[inset_0_-3px_0_var(--color-ink)]`
                  : `${TAB_INACTIVE} hover:text-ink`
              }
            >
              {tab.label}
            </Link>
          );
        })}
        <MarketStatus />
      </div>
    </div>
  );
}

/**
 * Static fallback for the `<Suspense>` boundary around `NavTabs` — mirrors
 * `MobileNavFallback`: a non-interactive visual match with no tab marked
 * active (the pre-hydration render can't know the route yet) and a neutral
 * status dot.
 */
export function NavTabsFallback() {
  return (
    <div className="h-[44px] border-b border-hairline-strong" aria-hidden>
      <div className="mx-auto flex h-full max-w-[1440px] items-stretch gap-7 px-7">
        {NAV_TABS.map((tab) => (
          <span key={tab.label} className={TAB_INACTIVE}>
            {tab.label}
          </span>
        ))}
        <div className="ml-auto flex flex-none items-center gap-2">
          <span className="font-ui text-[11px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
            Markets
          </span>
          <span className="h-[7px] w-[7px] flex-none rounded-full bg-ink-faint" />
        </div>
      </div>
    </div>
  );
}

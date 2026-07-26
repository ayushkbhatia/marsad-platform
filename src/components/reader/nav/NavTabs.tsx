"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarketOpen } from "@/lib/hooks/usePulse";
import { nextOpenLabel } from "@/lib/market/hours";

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
 * `Watchlist` now links to `/watchlist` — the design-1h page, sample-seeded
 * for the pixel pass (DEF-WATCHLIST-LIVE-DATA). It is a MEMBER surface in the
 * real product; there is still no `(auth)` group, so the route ships ungated
 * with a shared sample list until auth + per-user lists land. The
 * `href: null` inert-stub branch below is retained for any future
 * not-yet-built tab.
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
  {
    label: "Research",
    href: "/research",
    // Article pages (/articles/[slug]) are research detail — keep Research lit there too.
    match: (p) => section("/research")(p) || section("/articles")(p),
  },
  { label: "Analysts", href: "/analysts", match: section("/analysts") },
  { label: "Watchlist", href: "/watchlist", match: section("/watchlist") },
];

const TAB_BASE = "flex items-center font-ui text-[13.5px]";
const TAB_INACTIVE = `${TAB_BASE} font-medium text-ink-muted`;

/**
 * Markets-open/closed status (design 16c). When closed, the label carries a
 * reopen hint ("Closed · opens Sun 10:00", TDWL-referenced) and the dot goes
 * grey — Thursday's close must not read as live. The reopen label is computed
 * once on the client after mount (empty during SSR/first paint so server and
 * client agree; it fills in on the next tick — same pattern as the LiveClock).
 */
function MarketStatus() {
  const open = useMarketOpen();
  const [reopen, setReopen] = useState("");
  useEffect(() => {
    if (open) return;
    const compute = () => setReopen(nextOpenLabel());
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, [open]);

  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <span className="font-ui text-[11px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
        {open ? "Markets open" : reopen ? `Closed · ${reopen}` : "Markets closed"}
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

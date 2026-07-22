import { Suspense } from "react";
import Link from "next/link";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { NavIndexStrip } from "./nav/NavIndexStrip";
import { NavTabs, NavTabsFallback } from "./nav/NavTabs";

/** Static hamburger shown during prerender / before the client drawer hydrates.
 * Visual match for MobileNavDrawer's closed button; non-interactive. */
function MobileNavFallback() {
  return (
    <span className="flex h-11 w-11 flex-none items-center justify-center lg:hidden" aria-hidden>
      <span className="block h-[11px] w-[18px]">
        <span className="block h-[1.5px] w-full bg-ink" />
        <span className="mt-[3.5px] block h-[1.5px] w-full bg-ink" />
        <span className="mt-[3.5px] block h-[1.5px] w-full bg-ink" />
      </span>
    </span>
  );
}

/**
 * Reader masthead (server component). Editorial ink-and-paper chrome, built
 * to the design's 3-row / ~147px `MarsadNav.dc.html` spec at `lg`+:
 *
 *   Row 1 (34px)  — GCC index strip (`NavIndexStrip`, client) + the
 *                    DELAYED-data indicator in the design's row-1 clock slot.
 *   Row 2 (68px)  — wordmark lockup ("Marsad" + "مرصد" + tagline) on the
 *                    left; search / LOCAL·USD / Sign in / Go Premium on the
 *                    right (anon session — the only state this build ships;
 *                    Premium/avatar states are documented, not built, since
 *                    there is no `(auth)` group yet).
 *   Row 3 (44px)  — the 8-tab section bar (`NavTabs`, client — active
 *                    underline via `usePathname`) + a markets-open/closed dot.
 *
 * Below `lg` this collapses to a condensed single-row masthead (wordmark +
 * persistent DELAYED badge + `MobileNavDrawer`) — every reader surface is
 * 15-minute delayed by owner decision, so that badge lives in the global
 * chrome, not just on quote panels. Solid `paper-tint` background (no
 * translucency/backdrop-blur — that was never in the design).
 *
 * No user-specific / request-time reads of its own — this renders
 * identically for every anon visitor and prerenders with the shell.
 * `usePathname` inside `NavTabs` is the one request-time read, so it (like
 * `MobileNavDrawer`) is wrapped in its own `<Suspense>` boundary to prerender
 * under cacheComponents on dynamic routes (no `generateStaticParams`).
 */
export function MarsadNav() {
  return (
    <header className="sticky top-0 z-30 bg-paper-tint">
      {/* Mobile masthead (<lg): condensed single row. */}
      <div className="flex items-center gap-5 border-b border-hairline px-5 py-2.5 sm:px-8 lg:hidden">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">
            Marsad
          </span>
          <span className="hidden font-mono text-[8.5px] tracking-[0.22em] text-ink-faint sm:inline">
            GCC MARKETS
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-3">
          {/* Persistent delayed-data indicator (never "live" — scrape-only, 15-min delayed). */}
          <span
            className="inline-flex items-center gap-[6px]"
            title="All market data is delayed at least 15 minutes"
          >
            <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
            <span className="hidden font-mono text-[9.5px] tracking-[0.08em] text-ink-faint sm:inline">
              DELAYED 15 MIN
            </span>
          </span>
          <Suspense fallback={<MobileNavFallback />}>
            <MobileNavDrawer />
          </Suspense>
        </div>
      </div>

      {/* Desktop masthead (lg+): 3 rows, ~147px total. */}
      <div className="hidden lg:block">
        <NavIndexStrip />

        {/* Row 2 — wordmark lockup + utility cluster. */}
        <div className="h-[68px] border-b-2 border-ink">
          <div className="mx-auto flex h-full max-w-[1440px] items-center gap-4 px-7">
            <Link href="/" className="flex items-baseline gap-3">
              <span className="font-display text-[37px] font-bold leading-none tracking-[-0.015em] text-ink">
                Marsad
              </span>
              <span lang="ar" dir="rtl" className="font-arabic text-[20px] text-ink-muted">
                مرصد
              </span>
            </Link>

            <div className="h-7 w-px flex-none bg-hairline" aria-hidden />

            <span className="font-ui text-[10px] font-semibold tracking-[0.24em] text-ink-muted uppercase">
              Gulf Markets Intelligence
            </span>

            <div className="ml-auto flex flex-none items-center gap-3.5">
              {/* Static GET form — no client JS needed; /search already reads ?q= (see (reader)/search/page.tsx). */}
              <form action="/search" method="GET" role="search">
                <input
                  type="text"
                  name="q"
                  placeholder="Search tickers, companies, analysts…"
                  className="h-[34px] w-[240px] border border-hairline-strong bg-paper px-3 font-ui text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
                />
              </form>

              {/* Local/USD display-mode indicator — every reader price is shown
                  in local venue currency today; USD conversion isn't wired
                  anywhere in the app, so this is a static indicator of the
                  current (only) mode, not a disabled control. */}
              <div className="flex h-7 flex-none items-stretch border border-hairline-strong">
                <span className="flex items-center bg-ink px-[9px] font-ui text-[10.5px] font-bold text-paper-tint">
                  LOCAL
                </span>
                <span className="flex items-center px-[9px] font-ui text-[10.5px] font-semibold text-ink-muted">
                  USD
                </span>
              </div>

              {/* Anon session state — the only one this build ships (no
                  `(auth)` group / user session exists yet, docs/FORWARD-BUILD.md
                  §S7). Premium (badge) and signed-in (avatar) states are in the
                  design (MarsadNav.dc.html `isPremium`/`hasUser`) but have
                  nothing to wire to here, so they're not scaffolded as dead
                  branches — this stays inert until auth lands. */}
              <span
                className="cursor-not-allowed font-ui text-[12.5px] font-semibold text-ink underline underline-offset-[3px]"
                title="Sign in — coming soon"
              >
                Sign in
              </span>
              <span
                className="cursor-not-allowed bg-ink px-4 py-[9px] font-ui text-[11px] font-bold tracking-[0.08em] text-paper-tint uppercase"
                title="Go Premium — coming soon"
              >
                Go Premium
              </span>
            </div>
          </div>
        </div>

        {/* Row 3 — 8-tab section bar + markets-open/closed status. */}
        <Suspense fallback={<NavTabsFallback />}>
          <NavTabs />
        </Suspense>
      </div>
    </header>
  );
}

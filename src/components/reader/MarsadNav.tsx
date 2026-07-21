import { Suspense } from "react";
import Link from "next/link";
import { MobileNavDrawer } from "./MobileNavDrawer";

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
 * Reader masthead (server component). Editorial ink-and-paper chrome: wordmark,
 * a few section links, a disabled search affordance, and a persistent
 * DELAYED-data indicator — every reader surface is 15-minute delayed by owner
 * decision, so the badge lives in the global chrome, not just on quote panels.
 *
 * No user-specific / request-time reads — this renders identically for every
 * anon visitor and prerenders with the shell.
 */
export function MarsadNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1180px] items-center gap-5 px-5 py-2.5 sm:px-8">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="h-2.5 w-2.5 flex-none rotate-45 bg-ink" aria-hidden />
          <span className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">
            Marsad
          </span>
          <span className="hidden font-mono text-[8.5px] tracking-[0.22em] text-ink-faint sm:inline">
            GCC MARKETS
          </span>
        </Link>

        <nav className="ml-2 hidden items-center gap-4 font-ui text-[12.5px] text-ink-muted lg:flex">
          <Link href="/markets" className="hover:text-ink hover:underline underline-offset-4">
            Markets
          </Link>
          <Link href="/wire" className="hover:text-ink hover:underline underline-offset-4">
            Wire
          </Link>
          <Link href="/screener" className="hover:text-ink hover:underline underline-offset-4">
            Screener
          </Link>
          <Link href="/earnings" className="hover:text-ink hover:underline underline-offset-4">
            Earnings
          </Link>
          <Link href="/dividends" className="hover:text-ink hover:underline underline-offset-4">
            Dividends
          </Link>
          <Link href="/ipo" className="hover:text-ink hover:underline underline-offset-4">
            IPOs
          </Link>
          <Link href="/filings" className="hover:text-ink hover:underline underline-offset-4">
            Register
          </Link>
          <Link href="/search" className="hover:text-ink hover:underline underline-offset-4">
            Search
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Persistent delayed-data indicator (never "live" — scrape-only, 15-min delayed). */}
          <span className="inline-flex items-center gap-[6px]" title="All market data is delayed 15 minutes">
            <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
            <span className="hidden font-mono text-[9.5px] tracking-[0.08em] text-ink-faint sm:inline">
              DELAYED 15 MIN
            </span>
          </span>
          {/* Mobile section menu (below lg the inline nav is hidden). usePathname is a
              request-time read, so it needs a Suspense boundary to prerender under
              cacheComponents on dynamic routes (no generateStaticParams). */}
          <Suspense fallback={<MobileNavFallback />}>
            <MobileNavDrawer />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

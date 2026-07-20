import type { Metadata } from "next";
import { ScreenerGrid } from "@/components/reader/ScreenerGrid";

/**
 * Screener (1f) — dark data-room. The page is a static shell; the entire filter
 * + results grid is a client island that calls `/api/screener/run` over a
 * constrained PUBLIC field allowlist (venue, sector, price, change%, headline
 * Score/rating). Premium ratio columns render as locked stubs. `noindex` per
 * §8 (SEO backbone is stock pages / filings, not the screener).
 */

export const metadata: Metadata = {
  title: "Screener",
  description: "Filter and sort GCC equities by venue, sector, price, change and the Marsad Score.",
  robots: { index: false, follow: false },
};

export default function ScreenerPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="mb-5 border-b border-dark-hairline pb-3">
        <h1 className="font-display text-heading font-bold text-dark-text">Screener</h1>
        <p className="mt-1 font-ui text-[13px] text-dark-text-mid">
          Filter the GCC universe by venue, sector, price, change and the headline Marsad Score.
          Delayed data.
        </p>
      </header>

      <ScreenerGrid />
    </div>
  );
}

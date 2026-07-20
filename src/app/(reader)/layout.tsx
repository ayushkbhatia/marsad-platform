import type { Metadata } from "next";
import Link from "next/link";
import { MarsadNav } from "@/components/reader/MarsadNav";

/**
 * Reader shell (P2). Wraps every public reader route in the editorial chrome:
 * the `MarsadNav` masthead + a footer. Server component, anon — reads nothing
 * user-specific, so it prerenders with each route's static shell. The root
 * `app/layout.tsx` supplies <html>/<body> + the font variables; this group
 * layout only provides the in-body chrome.
 */

export const metadata: Metadata = {
  title: {
    default: "Marsad — GCC markets, read closely",
    template: "%s · Marsad",
  },
  description:
    "Delayed-data research on Gulf-listed equities — filings, prices, and the Marsad Score across six GCC venues.",
};

export default function ReaderLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-paper-tint">
      <MarsadNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-hairline bg-paper">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-8 font-mono text-[10px] leading-[1.7] text-ink-faint sm:flex-row sm:items-start sm:justify-between sm:px-8">
          <div className="max-w-[440px]">
            <span className="font-display text-[13px] font-bold not-italic text-ink">Marsad</span>
            <p className="mt-1.5 tracking-[0.02em]">
              Independent research on six GCC venues — Tadawul, DFM, ADX, QE, MSX, BHB.
              All prices and quotes are delayed at least 15 minutes and are for
              information only, not investment advice.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 tracking-[0.1em] uppercase">
            <Link href="/markets" className="hover:text-ink-muted hover:underline underline-offset-4">
              Markets
            </Link>
            <Link href="/wire" className="hover:text-ink-muted hover:underline underline-offset-4">
              Newswire
            </Link>
            <Link href="/filings" className="hover:text-ink-muted hover:underline underline-offset-4">
              Filings register
            </Link>
            <span className="text-hairline-strong">Methodology · soon</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

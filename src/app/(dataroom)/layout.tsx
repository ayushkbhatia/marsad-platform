import Link from "next/link";
import { MarsadNav } from "@/components/reader/MarsadNav";

/**
 * Data-room shell (04-reader-app.md §1): the same MarsadNav masthead over a DARK
 * surface for the always-dark data rooms (screener, heatmap). Surface is a
 * property of the region, not a user preference — there is no theme toggle. The
 * root layout supplies <html>/<body> + fonts; this group layout supplies the
 * dark in-body chrome.
 */
export default function DataroomLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-dark-bg">
      <MarsadNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-dark-hairline bg-dark-panel">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-2 px-5 py-8 font-mono text-[10px] leading-[1.7] text-dark-text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="max-w-[560px] tracking-[0.02em]">
            Data room · delayed at least 15 minutes, information only, not investment advice.
            Valuation ratios and Score factor grades are Premium.
          </p>
          <div className="flex gap-4 tracking-[0.1em] uppercase">
            <Link href="/markets" className="hover:text-dark-text hover:underline underline-offset-4">
              Markets
            </Link>
            <Link href="/wire" className="hover:text-dark-text hover:underline underline-offset-4">
              Wire
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

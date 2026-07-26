import Link from "next/link";

/**
 * Data-room shell (design 1e/1f). The platform's only DARK surfaces.
 *
 * The data room deliberately does NOT carry `MarsadNav` — per the 1e/1f
 * handoff it is a full-bleed focus mode with its own 54px chrome bar
 * (`DataRoomChrome`, rendered by each page so it can carry that page's mode
 * chip + controls). Arriving here from the light reader shell is a MODE
 * SWITCH, not a page navigation; the chrome's brand lockup is the way back.
 *
 * Surface is a property of the region, not a user preference — there is no
 * theme toggle. (`/heatmap?edition=paper` is a separate, documented
 * server-resolved exception for that one page.) The root layout supplies
 * <html>/<body> + fonts; this group layout supplies the dark in-body chrome.
 */
export default function DataroomLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-dark-bg">
      <main className="flex-1">{children}</main>
      <footer className="border-t border-dark-hairline">
        <div className="flex flex-col gap-2 px-6 py-6 font-mono text-[9.5px] leading-[1.7] text-dark-text-faint sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-[620px] tracking-[0.02em]">
            Data room · delayed at least 15 minutes, information only, not investment advice.
            Valuation ratios and Score factor grades are Premium.
          </p>
          <div className="flex gap-4 tracking-[0.1em] uppercase">
            <Link href="/" className="hover:text-dark-text hover:underline underline-offset-4">
              ← Reader
            </Link>
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

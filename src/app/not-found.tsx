import Link from "next/link";

/**
 * Global 404 (screen 17d). Rendered inside the root layout, so it carries its
 * own centered editorial chrome. Static — no request-time reads.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper-tint px-6 text-center">
      <span className="font-mono text-[10px] tracking-[0.22em] text-ink-faint uppercase">
        Marsad · 404
      </span>
      <div className="mt-4 flex items-baseline gap-3">
        <span className="h-3 w-3 flex-none rotate-45 bg-ink" aria-hidden />
        <h1 className="font-display text-[54px] font-bold leading-none tracking-[-0.02em] text-ink">
          This page has delisted.
        </h1>
      </div>
      <p className="mt-4 max-w-[440px] font-ui text-[14px] leading-[1.6] text-ink-muted">
        The security or page you were looking for isn&apos;t on the board. It may
        have been delisted, renamed, or never listed at all.
      </p>
      <div className="mt-7 flex items-center gap-3">
        <Link
          href="/"
          className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
        >
          Markets
        </Link>
        <Link
          href="/filings"
          className="px-2 py-2 font-ui text-[12.5px] text-ink-muted hover:text-ink hover:underline underline-offset-4"
        >
          Filings wire →
        </Link>
      </div>
    </div>
  );
}

import Link from "next/link";

/**
 * 17c — zero-result state. Bespoke (not the shared `EmptyState` primitive):
 * the design specs a circular magnifying-glass icon + suggestion chips + a
 * "tell the desk" line, which is richer than `EmptyState`'s diamond-mark shape
 * — building it here keeps `src/components/ui/*` untouched per the collision
 * rules while still matching the assigned screen exactly.
 *
 * COPY FIX vs the design fixture: the mock's static copy says "seven Gulf
 * exchanges" — stale (pre-dates the locked decision, six venues day one, BK
 * "coming soon"; see 04-reader-app.md D11 and the reader footer's own "six GCC
 * venues" copy). Corrected to six here rather than propagating a fact that
 * contradicts the rest of the site.
 */
export function SearchNoResults({ q }: { q: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center sm:px-10">
      <div className="grid h-[52px] w-[52px] flex-none place-items-center rounded-full border-2 border-hairline-strong text-ink-faint">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="9.5" cy="9.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <line x1="14.5" y1="14.5" x2="19" y2="19" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      </div>

      <p className="mt-4 font-display text-[24px] font-bold leading-tight text-ink">
        No matches in GCC coverage
      </p>
      <p className="mt-2 max-w-[460px] font-ui text-[13px] leading-relaxed text-ink-muted">
        Marsad covers six Gulf exchanges —{" "}
        {q ? `“${q}”` : "that"}
        {" "}isn&rsquo;t listed here. Check the spelling, or try a Gulf name, ticker, sector or
        filing phrase.
      </p>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          href="/search?q=ACWA+Power"
          className="border border-hairline-strong px-3 py-1.5 font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
        >
          Try &ldquo;ACWA Power&rdquo;
        </Link>
        <Link
          href="/search?q=utilities"
          className="border border-hairline-strong px-3 py-1.5 font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
        >
          Try &ldquo;utilities&rdquo;
        </Link>
        <Link
          href="/ipo"
          className="border border-hairline-strong px-3 py-1.5 font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
        >
          Try &ldquo;IPO&rdquo;
        </Link>
      </div>

      <div className="mt-7 max-w-[460px] border-t border-hairline pt-4">
        <p className="font-ui text-[11.5px] leading-relaxed text-ink-muted">
          Want a market added?{" "}
          <span className="font-semibold text-ink underline decoration-1 underline-offset-[3px]">
            Tell the desk what to cover
          </span>
        </p>
      </div>
    </div>
  );
}

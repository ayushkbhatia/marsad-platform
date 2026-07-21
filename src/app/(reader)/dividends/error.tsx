"use client";

import { useEffect } from "react";

/** Segment error boundary (App Router error.tsx must be a client component). */
export default function DividendsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[dividends]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-16 sm:px-8">
      <div className="flex flex-col items-center gap-3 border border-dashed border-hairline bg-paper-tint/60 px-6 py-14 text-center">
        <span className="h-2.5 w-2.5 rotate-45 bg-negative" aria-hidden />
        <p className="max-w-[420px] font-display text-[17px] leading-tight text-ink-mid">
          The dividend calendar didn&apos;t load.
        </p>
        <p className="max-w-[440px] font-ui text-[12.5px] leading-relaxed text-ink-faint">
          Try again — if this keeps happening, the confirmation feed may be degraded.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-1 border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

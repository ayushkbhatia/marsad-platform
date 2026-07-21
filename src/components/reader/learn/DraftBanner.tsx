/**
 * Top-of-page banner for `status: "draft-legal"` docs (Terms, Privacy). Makes
 * it visually unmissable that the page below is a structural skeleton, not
 * Marsad's actual legal terms — per the build brief, these must never read as
 * finished law. Monochrome ink treatment (no amber — that token is reserved
 * for data freshness per CONVENTIONS §4).
 */
export function DraftBanner({ notice }: { notice: string }) {
  return (
    <div className="mt-4 border-2 border-ink bg-paper-tint px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className="h-2 w-2 flex-none rotate-45 bg-ink" aria-hidden />
        <span className="font-mono text-[9.5px] font-bold tracking-[0.16em] text-ink uppercase">
          Draft — requires owner &amp; legal review before launch
        </span>
      </div>
      <p className="mt-2 font-ui text-[12.5px] leading-[1.65] text-ink-mid">{notice}</p>
    </div>
  );
}

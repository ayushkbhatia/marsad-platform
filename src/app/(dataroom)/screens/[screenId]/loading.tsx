/** Shimmer skeleton for a screen preview while the run resolves. */
export default function ScreenPreviewLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="h-4 w-40 animate-pulse border-b border-dark-hairline bg-dark-hairline-soft pb-3" />
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <div className="h-3 w-28 animate-pulse bg-dark-hairline-soft" />
          <div className="h-8 w-72 animate-pulse bg-dark-hairline" />
          <div className="h-4 w-full max-w-[560px] animate-pulse bg-dark-hairline-soft" />
          <div className="mt-4 h-24 w-full animate-pulse bg-dark-panel" />
          <div className="mt-4 space-y-[2px]">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 w-full animate-pulse bg-dark-hairline-soft" />
            ))}
          </div>
        </div>
        <div className="h-40 w-full animate-pulse bg-dark-panel" />
      </div>
    </div>
  );
}

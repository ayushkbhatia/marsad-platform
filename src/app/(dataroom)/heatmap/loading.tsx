/** Shimmer skeleton for the heatmap while the cached sector reads resolve. */
export default function HeatmapLoading() {
  return (
    <div className="min-h-[60vh] bg-dark-bg">
      <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
        <div className="flex items-end justify-between gap-4 border-b border-dark-hairline pb-4">
          <div className="space-y-2">
            <div className="h-6 w-52 animate-pulse bg-dark-hairline-soft" />
            <div className="h-3 w-80 animate-pulse bg-dark-hairline" />
          </div>
          <div className="h-8 w-64 animate-pulse bg-dark-hairline-soft" />
        </div>
        <div className="mt-4 flex divide-x divide-dark-hairline border border-dark-hairline-strong bg-dark-panel">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex-1 space-y-2 px-3.5 py-3">
              <div className="h-2 w-12 animate-pulse bg-dark-hairline-soft" />
              <div className="h-5 w-10 animate-pulse bg-dark-hairline" />
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-col gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1">
              <div className="h-2.5 w-32 animate-pulse bg-dark-hairline-soft" />
              <div className="flex gap-[2px]">
                {[0, 1, 2, 3, 4, 5].map((j) => (
                  <div key={j} className="h-16 flex-1 animate-pulse bg-dark-hairline-soft" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

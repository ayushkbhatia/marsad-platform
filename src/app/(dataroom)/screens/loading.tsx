/** Shimmer skeleton for the Explore gallery while preset counts resolve. */
export default function ScreensLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="space-y-2 border-b-2 border-dark-hairline pb-4">
        <div className="h-4 w-40 animate-pulse bg-dark-hairline-soft" />
        <div className="h-8 w-96 animate-pulse bg-dark-hairline" />
        <div className="h-3 w-72 animate-pulse bg-dark-hairline-soft" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex min-h-[152px] flex-col gap-2 border border-dark-hairline bg-dark-panel px-4 py-4">
            <div className="h-2 w-24 animate-pulse bg-dark-hairline-soft" />
            <div className="h-5 w-32 animate-pulse bg-dark-hairline" />
            <div className="h-3 w-full animate-pulse bg-dark-hairline-soft" />
            <div className="mt-auto h-3 w-20 animate-pulse bg-dark-hairline-soft" />
          </div>
        ))}
      </div>
    </div>
  );
}

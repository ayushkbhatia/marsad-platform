/** Shimmer for the dividends segment while the shell resolves (nav transitions). */
export default function DividendsLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-64 animate-pulse bg-hairline" />
      </div>
      <div className="mt-4 h-[64px] w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="h-[300px] animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

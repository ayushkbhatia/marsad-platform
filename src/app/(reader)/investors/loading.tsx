/** Shimmer for Investors (directory + detail — shared segment loading state). */
export default function InvestorsLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-64 animate-pulse bg-hairline" />
      </div>
      <div className="mt-4 flex gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-6 w-20 animate-pulse bg-hairline-soft" />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 w-full animate-pulse bg-hairline-soft" />
        ))}
      </div>
    </div>
  );
}

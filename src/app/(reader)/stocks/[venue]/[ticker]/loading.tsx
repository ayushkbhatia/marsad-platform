/**
 * Shimmer skeleton for the stock segment while the cached shell resolves.
 * Mirrors the header + tab-bar + body layout so the transition is calm.
 */
export default function StockLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 sm:px-8">
      <section className="border-b border-hairline pb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="h-3 w-24 animate-pulse bg-hairline-soft" />
            <div className="h-7 w-64 animate-pulse bg-hairline" />
          </div>
          <div className="space-y-2 sm:text-right">
            <div className="h-8 w-32 animate-pulse bg-hairline sm:ml-auto" />
            <div className="h-4 w-40 animate-pulse bg-hairline-soft sm:ml-auto" />
          </div>
        </div>
      </section>

      <div className="mt-1 flex gap-4 border-b border-hairline py-3">
        {[64, 48, 56, 72].map((w, i) => (
          <div key={i} className="h-4 animate-pulse bg-hairline-soft" style={{ width: w }} />
        ))}
      </div>

      <div className="grid gap-6 py-7 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="h-40 animate-pulse bg-hairline-soft" />
          <div className="h-64 animate-pulse bg-hairline-soft" />
        </div>
        <div className="h-72 animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

/**
 * Shimmer for the `/learn` segment (hub + `[docSlug]` detail) while the shell
 * resolves on client-side nav. Both routes are fully static/prerendered, so
 * this only ever shows briefly during a route transition, never a real fetch.
 */
export default function LearnLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-8 w-40 animate-pulse bg-hairline" />
        <div className="mt-2 h-4 w-80 max-w-full animate-pulse bg-hairline-soft" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-9 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-8">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-24 w-full animate-pulse bg-hairline-soft" />
              ))}
            </div>
          ))}
        </div>
        <div className="h-64 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

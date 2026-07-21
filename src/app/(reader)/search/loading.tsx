/** 17e shimmer for Search while the results resolve (nav transitions). */
export default function SearchLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6 sm:px-8">
      <div className="flex items-center gap-3 border-b-2 border-ink pb-3">
        <div className="h-6 w-64 animate-pulse bg-hairline" />
        <div className="ml-auto h-6 w-40 animate-pulse bg-hairline-soft" />
      </div>
      <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          <div className="h-16 w-full animate-pulse bg-hairline-soft" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-9 w-full animate-pulse bg-hairline-soft" />
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-24 w-full animate-pulse bg-hairline-soft" />
          <div className="h-16 w-full animate-pulse bg-hairline-soft" />
        </div>
      </div>
    </div>
  );
}

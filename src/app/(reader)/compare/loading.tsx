/** Shimmer for Compare while the shell resolves (nav transitions). */
export default function CompareLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="border-b-2 border-ink pb-3.5">
        <div className="h-7 w-40 animate-pulse bg-hairline" />
      </div>
      <div className="mt-6 space-y-2">
        <div className="h-16 w-full animate-pulse bg-hairline-soft" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 w-full animate-pulse bg-hairline-soft" />
        ))}
      </div>
    </div>
  );
}

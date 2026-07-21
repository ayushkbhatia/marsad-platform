/** Shimmer for a datapoint series page while the shell resolves (nav transitions). */
export default function DatapointsLoading() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-10 sm:px-8">
      <div className="h-4 w-52 animate-pulse bg-hairline-soft" />
      <div className="mt-4 h-9 w-2/3 animate-pulse bg-hairline" />
      <div className="mt-4 h-52 animate-pulse bg-hairline-soft" />
    </div>
  );
}

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getOhlcvSeries, normalizeRange, type OhlcvRange } from "@/lib/data/stocks";
import { PriceChart } from "@/components/reader/PriceChart";
import { fmtDate } from "@/lib/reader/format";

/**
 * Chart tab. Reads `?range=` (runtime searchParams) → the data-reading body
 * runs inside a <Suspense> boundary so the static shell prerenders and the
 * range-specific chart streams (cacheComponents rule; admin-page precedent).
 *
 * The chart itself is a SERVER-rendered inline SVG (see PriceChart) — no client
 * charting dep in this pass. The range selector is plain links that re-render
 * the server component via searchParams.
 */

type Params = { venue: string; ticker: string };
type Search = { range?: string };

const RANGES: OhlcvRange[] = ["1M", "3M", "6M", "1Y", "5Y", "MAX"];

export default function ChartPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  return (
    <Suspense fallback={<ChartFallback />}>
      <ChartBody params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function ChartFallback() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-64 animate-pulse bg-hairline-soft" />
      <div className="h-[340px] w-full animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function ChartBody({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const [{ venue, ticker }, { range: rawRange }] = await Promise.all([params, searchParams]);
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const range = normalizeRange(rawRange);
  const series = await getOhlcvSeries(sec.id, range);
  const base = `/stocks/${sec.venueCode}/${sec.ticker}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-heading-sm font-semibold text-ink">Price history</h2>
          <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-ink-faint">
            Daily closes · delayed EOD data
            {series.points.length
              ? ` · ${fmtDate(series.from)} – ${fmtDate(series.to)} · ${series.points.length} bars${
                  series.capped ? " (capped)" : ""
                }`
              : ""}
          </p>
        </div>

        {/* Range selector — server-rendered links keyed on ?range= */}
        <nav className="flex flex-none gap-0 border border-hairline">
          {RANGES.map((r) => {
            const active = r === range;
            return (
              <Link
                key={r}
                href={`${base}/chart?range=${r}`}
                aria-current={active ? "true" : undefined}
                className={`border-l border-hairline px-2.5 py-1.5 font-mono text-[10.5px] tracking-[0.06em] first:border-l-0 ${
                  active ? "bg-ink text-paper-tint" : "text-ink-muted hover:bg-paper-tint hover:text-ink"
                }`}
              >
                {r}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="border border-hairline bg-paper p-3 sm:p-4">
        <PriceChart points={series.points} />
      </div>

      <p className="font-mono text-[9px] leading-[1.6] tracking-[0.02em] text-ink-faint">
        {/* SEAM: v1 is a static server SVG. An interactive candle chart can drop in
            behind the same getOhlcvSeries(id, range) contract without route changes. */}
        Chart shows daily closing prices only. Intraday, candles, and overlays are
        planned. Data is delayed at least 15 minutes and provided for information only.
      </p>
    </div>
  );
}

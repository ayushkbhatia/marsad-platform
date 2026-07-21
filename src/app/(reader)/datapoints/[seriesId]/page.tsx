import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getDatapointSeries, getRelatedSeries } from "@/lib/data/entities";
import { EmptyState } from "@/components/ui";
import { DatapointBars } from "@/components/reader/entities/DatapointBars";
import { fmtDate } from "@/lib/reader/format";

/**
 * 18b Datapoint series detail. `datapoint_series`/`datapoints` are 0 rows today (analyst-
 * maintained depth, producer pending per 07-lake-enrichment.md §L) — no `generateStaticParams`,
 * params are runtime, body Suspense-wrapped (cacheComponents rule, same shape as
 * `ipo/[offerSlug]`). An unresolved/malformed id renders `EmptyState awaitingFeed`, not
 * `notFound()` — same non-404 treatment as the other pre-launch tiers. Indexable (not in the
 * `noindex` list at 04-reader-app.md §8).
 */

type Params = { seriesId: string };

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { seriesId } = await params;
  const id = parseId(seriesId);
  const series = id != null ? await getDatapointSeries(id) : null;
  if (!series) return { title: "Datapoints" };
  return {
    title: series.displayName,
    description: `${series.displayName}${series.companyName ? ` — ${series.companyName}` : ""}, ${series.cadence} · ${series.unit}.`,
  };
}

export default function DatapointSeriesPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-10 sm:px-8">
      <Suspense fallback={<SeriesFallback />}>
        <DatapointSeriesBody params={params} />
      </Suspense>
    </div>
  );
}

function SeriesFallback() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-40 animate-pulse bg-hairline-soft" />
      <div className="h-9 w-2/3 animate-pulse bg-hairline" />
      <div className="h-52 animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function DatapointSeriesBody({ params }: { params: Promise<Params> }) {
  const { seriesId } = await params;
  const id = parseId(seriesId);
  const series = id != null ? await getDatapointSeries(id) : null;

  if (!series) {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
          <span className="text-ink-faint">Datapoints</span>
        </div>
        <div className="mt-6">
          <EmptyState
            variant="awaitingFeed"
            title="This series isn't tracked yet"
            body="Analyst-maintained datapoint series populate here once a metric is added and the first value lands."
            action={
              <Link href="/" className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper">
                ← Back to Marsad
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const related = series.securityId != null ? await getRelatedSeries(series.securityId, series.id, 3) : [];
  const latest = series.latest;
  // Values arrive newest-first (query order); the chart reads oldest → newest, last 12 periods.
  const chartPoints = series.values
    .slice(0, 12)
    .filter((v): v is typeof v & { value: number } => v.value != null)
    .slice()
    .reverse()
    .map((v) => ({ period: v.period, value: v.value }));

  return (
    <article>
      <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
        {series.securityId != null && series.ticker && series.venueCode ? (
          <Link
            href={`/stocks/${series.venueCode}/${series.ticker}`}
            className="underline decoration-hairline-strong underline-offset-4 hover:text-ink"
          >
            {series.companyName}
          </Link>
        ) : (
          <span>{series.entityRef ?? series.entityKind}</span>
        )}
        <span className="text-ink-faint">/</span>
        <span>Tracked datapoints</span>
        <span className="text-ink-faint">/</span>
        <span className="font-semibold text-ink">{series.displayName}</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-[34px] lg:grid-cols-[1fr_336px]">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-display text-[23px] font-bold text-ink">{series.displayName}</h1>
            <span className="font-mono text-[9px] text-ink-faint uppercase">
              {series.unit} · {series.cadence} · {series.isAnalystMaintained ? "analyst-maintained" : "auto-computed"}
            </span>
            <span
              className="ml-auto cursor-not-allowed border border-ink px-3 py-1.5 font-ui text-[10.5px] font-semibold text-ink"
              title="Alerts — coming soon"
            >
              + Alert on this series
            </span>
          </div>

          {latest ? (
            <div className="mt-3 flex flex-wrap items-baseline gap-2.5">
              <span className="font-display text-[34px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
                {latest.value != null ? latest.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
              </span>
              <span className="text-[13px] text-ink-muted">
                {series.unit} · {latest.period}
              </span>
              {latest.qoqDelta != null ? (
                <span className={`text-[13px] font-semibold ${latest.qoqDelta >= 0 ? "text-positive" : "text-negative"}`}>
                  {latest.qoqDelta >= 0 ? "+" : ""}
                  {latest.qoqDelta.toLocaleString("en-US", { maximumFractionDigits: 2 })} q/q
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3.5 border border-hairline-soft bg-paper px-4 py-4">
            {chartPoints.length >= 2 ? (
              <DatapointBars points={chartPoints} />
            ) : (
              <EmptyState
                variant="awaitingFeed"
                title="No values yet"
                body="Values populate here once the maintainer records the first period for this series."
              />
            )}
          </div>

          <div className="mt-5 border-t-2 border-ink pt-3">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Values</span>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_90px_90px_1fr] gap-2.5 border-b border-hairline px-1 py-1.5">
            <span className="font-mono text-[8px] text-ink-faint">PERIOD</span>
            <span className="text-right font-mono text-[8px] text-ink-faint">VALUE</span>
            <span className="text-right font-mono text-[8px] text-ink-faint">Δ Q/Q</span>
            <span className="font-mono text-[8px] text-ink-faint">AS OF</span>
          </div>
          {series.values.length === 0 ? (
            <EmptyState
              className="mt-3"
              variant="awaitingFeed"
              title="No recorded values yet"
              body="Period values populate here once the maintainer records the first entry for this series."
            />
          ) : (
            series.values.map((v) => (
              <div
                key={v.periodEnd}
                className="grid grid-cols-[1fr_90px_90px_1fr] items-baseline gap-2.5 border-b border-hairline-faint px-1 py-2"
              >
                <span className="text-[12px] font-semibold">{v.period}</span>
                <span className="text-right font-mono text-[11.5px] tabular-nums">
                  {v.value != null ? v.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                </span>
                <span
                  className={`text-right font-mono text-[11px] tabular-nums ${
                    v.qoqDelta == null ? "text-ink-faint" : v.qoqDelta >= 0 ? "text-positive" : "text-negative"
                  }`}
                >
                  {v.qoqDelta == null ? "—" : `${v.qoqDelta >= 0 ? "+" : ""}${v.qoqDelta.toFixed(2)}`}
                </span>
                <span className="font-mono text-[10px] text-ink-faint">{v.asOf ? fmtDate(v.asOf) : "—"}</span>
              </div>
            ))
          )}
        </div>

        <div>
          <div className="border border-hairline px-4 py-3.5">
            <div className="font-mono text-[8px] tracking-[0.14em] text-ink-faint uppercase">About this series</div>
            <p className="mt-2 font-ui text-[12px] leading-[1.6] text-ink-mid">
              {series.metricKey.replace(/_/g, " ")} — {series.unit}, {series.cadence} cadence. Revised within{" "}
              {series.revisionSlaHours}h of each disclosure.
            </p>
          </div>

          <div className="mt-3 border border-hairline px-4 py-3.5">
            <div className="font-mono text-[8px] tracking-[0.14em] text-ink-faint uppercase">Maintainer</div>
            <p className="mt-2 font-ui text-[12px] text-ink-mid">
              {series.isAnalystMaintained ? "Analyst-maintained series." : "Auto-computed from ingested filings."}
            </p>
          </div>

          {related.length > 0 ? (
            <div className="mt-3 border border-ink bg-paper-tint px-4 py-3.5">
              <div className="font-mono text-[8px] tracking-[0.14em] text-ink-faint uppercase">Related series</div>
              {related.map((r) => (
                <Link
                  key={r.id}
                  href={`/datapoints/${r.id}`}
                  className="mt-1 block border-b border-hairline-faint py-1.5 font-ui text-[12.5px] font-semibold text-ink last:border-b-0 hover:underline"
                >
                  {r.displayName} →
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

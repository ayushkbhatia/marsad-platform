import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEarningsEvent } from "@/lib/data/calendars";
import { RatingBadge } from "@/components/ui";
import { fmtDate, fmtSignedPct, venueName, toRating, siteUrl } from "@/lib/reader/format";
import { JsonLd } from "@/components/reader/JsonLd";

/**
 * Earnings event detail (8b). No `generateStaticParams` (4190 rows, same
 * shape as `filings/[filingId]`) — params are runtime, so the body runs
 * inside a `<Suspense>` boundary (cacheComponents rule).
 *
 * Ground truth (see `src/lib/data/calendars.ts` header): `eps_consensus`,
 * `eps_marsad`, `verdict`, `surprise_pct`, `next_session_reaction_pct`,
 * `rvc_table`, `segment_breakdown` and `desk_take` are NULL on every row
 * today (no estimates/desk producer yet) — those panels render an honest
 * "not yet published" placeholder rather than fabricated figures. The header
 * badge reads "REPORTED" (not BEAT/MISS) because no verdict exists yet.
 */

type Params = { eventId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { eventId } = await params;
  const id = Number(eventId);
  if (!Number.isInteger(id) || id <= 0) return { title: "Not found" };
  const ev = await getEarningsEvent(id);
  if (!ev) return { title: "Not found" };
  return {
    title: `${ev.ticker} ${ev.fiscalPeriod} results`,
    description: `${ev.name} (${ev.ticker}, ${venueName(ev.venueCode)}) — ${ev.fiscalPeriod} earnings, reported ${fmtDate(ev.reportDate)}.`,
  };
}

export default function EarningsEventPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-10 sm:px-8">
      <Suspense fallback={<EventFallback />}>
        <EarningsEventBody params={params} />
      </Suspense>
    </div>
  );
}

function EventFallback() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-40 animate-pulse bg-hairline-soft" />
      <div className="h-9 w-2/3 animate-pulse bg-hairline" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="h-64 animate-pulse bg-hairline-soft" />
        <div className="h-64 animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-r border-hairline px-4 py-4 last:border-r-0">
      <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{label}</div>
      <div className="mt-1 font-display text-[27px] font-bold leading-none text-ink">{value}</div>
      {sub ? <div className="mt-1 font-ui text-[10.5px] font-semibold text-ink-muted">{sub}</div> : null}
    </div>
  );
}

/** rvc_table / segment_breakdown are arbitrary jsonb with no confirmed shape
 * (always NULL today — see file header). Rendered defensively as data, never
 * as code, mirroring `filings/[filingId]`'s `ExtractedFacts` treatment. */
function JsonPanel({ title, data }: { title: string; data: unknown }) {
  if (data == null) {
    return (
      <p className="mt-2 border border-dashed border-hairline px-4 py-6 text-center font-mono text-[10.5px] text-ink-faint">
        No {title.toLowerCase()} published for this print yet.
      </p>
    );
  }
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((v, i) => [String(i + 1), v])
    : typeof data === "object"
      ? Object.entries(data as Record<string, unknown>)
      : [["value", data]];
  const render = (v: unknown): string => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <dl className="mt-2 divide-y divide-hairline-faint border-y border-hairline-faint">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-start gap-4 py-2">
          <dt className="w-[140px] flex-none font-mono text-[9.5px] tracking-[0.04em] text-ink-muted uppercase">{k}</dt>
          <dd className="min-w-0 flex-1 break-words font-ui text-[12px] text-ink">{render(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

async function EarningsEventBody({ params }: { params: Promise<Params> }) {
  const { eventId } = await params;
  const id = Number(eventId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const ev = await getEarningsEvent(id);
  if (!ev) notFound();

  const pageUrl = `${siteUrl()}/earnings/${ev.id}`;
  const yoyColor = ev.epsYoyPct == null ? "text-ink-faint" : ev.epsYoyPct >= 0 ? "text-positive" : "text-negative";
  const reactionColor =
    ev.nextSessionReactionPct == null ? "text-ink-faint" : ev.nextSessionReactionPct >= 0 ? "text-positive" : "text-negative";
  const verdictColor = ev.verdict === "BEAT" ? "bg-positive-fill" : ev.verdict === "MISS" ? "bg-negative" : "bg-ink";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Report",
    name: `${ev.ticker} ${ev.fiscalPeriod} results`,
    url: pageUrl,
    datePublished: ev.reportDate,
    about: {
      "@type": "Corporation",
      name: ev.name,
      tickerSymbol: ev.ticker,
      url: `${siteUrl()}/stocks/${ev.venueCode}/${ev.ticker}`,
    },
  };

  return (
    <article>
      <JsonLd data={jsonLd} />

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
        <Link href="/earnings" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
          Earnings calendar
        </Link>
        <span className="text-ink-faint">/</span>
        <Link
          href={`/stocks/${ev.venueCode}/${ev.ticker}`}
          className="underline decoration-hairline-strong underline-offset-4 hover:text-ink"
        >
          {ev.name}
        </Link>
        <span className="text-ink-faint">/</span>
        <span className="font-semibold text-ink">{ev.fiscalPeriod} results</span>
        <Link href="/earnings" className="ml-auto font-mono text-[10.5px] text-ink-muted hover:text-ink hover:underline">
          ← Back to calendar
        </Link>
      </div>

      {/* Header */}
      <div className="mt-3.5 flex flex-wrap items-end gap-4 border-b-2 border-ink pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-2 py-[3px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase ${verdictColor}`}>
              {ev.verdict ?? "Reported"}
            </span>
            <span className="border border-hairline-strong px-1.5 py-[2px] font-mono text-[8.5px] text-ink-muted">
              {venueName(ev.venueCode).toUpperCase()} · {ev.ticker}
            </span>
            <span className="font-mono text-[8.5px] text-ink-faint uppercase">
              Reported {fmtDate(ev.reportDate)}
              {ev.session ? ` · ${ev.session}` : ""}
            </span>
          </div>
          <h1 className="mt-2.5 font-display text-[27px] font-bold leading-[1.1] tracking-[-0.01em] text-ink">
            {ev.name} — {ev.fiscalPeriod}
          </h1>
        </div>
        <div className="ml-auto text-right">
          <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
            Price reaction · next session
          </div>
          <div className={`mt-0.5 font-display text-[22px] font-semibold tabular-nums ${reactionColor}`}>
            {fmtSignedPct(ev.nextSessionReactionPct)}
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_340px]">
        {/* Main column */}
        <div>
          <div className="grid grid-cols-3 border border-ink">
            <Fact label="EPS · actual" value={ev.epsActual == null ? "—" : ev.epsActual.toFixed(2)} sub={fmtSignedPct(ev.epsYoyPct) + " y/y"} />
            <Fact label="Consensus" value={ev.epsConsensus == null ? "—" : ev.epsConsensus.toFixed(2)} sub={ev.epsConsensus == null ? "not tracked yet" : fmtSignedPct(ev.surprisePct)} />
            <Fact label="Marsad estimate" value={ev.epsMarsad == null ? "—" : ev.epsMarsad.toFixed(2)} sub={ev.epsMarsad == null ? "not tracked yet" : undefined} />
          </div>

          <div className="mt-6 flex items-baseline gap-2 border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Headline vs consensus
            </span>
            <span className="font-mono text-[9px] text-ink-faint">
              Revenue actual: {ev.revenueActual == null ? "—" : ev.revenueActual.toLocaleString("en-US")}
              {ev.currency ? ` ${ev.currency.trim()}` : ""}
            </span>
          </div>
          <JsonPanel title="line-item detail" data={ev.rvcTable} />

          <div className="mt-6 border-l-2 border-ink bg-paper-tint px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] flex-none rotate-45 bg-ink" aria-hidden />
              <span className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink uppercase">
                Marsad desk take
              </span>
            </div>
            {ev.deskTake ? (
              <p className="mt-2 font-display text-[14px] leading-relaxed text-ink-mid">{ev.deskTake}</p>
            ) : (
              <p className="mt-2 font-ui text-[12px] text-ink-faint">No desk commentary published for this print yet.</p>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <aside>
          <div className="border border-hairline px-4 py-3.5">
            <div className="font-mono text-[8.5px] tracking-[0.12em] text-ink-faint uppercase">Segment net profit</div>
            <JsonPanel title="segment breakdown" data={ev.segmentBreakdown} />
          </div>

          <div className="mt-5 border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
            Go deeper
          </div>
          {ev.resultsFilingId ? (
            <Link
              href={`/filings/${ev.resultsFilingId}`}
              className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5 text-ink hover:bg-paper-tint"
            >
              <span className="flex-none border border-hairline-strong px-1.5 py-[2px] font-mono text-[8px] font-semibold text-ink-muted">
                FILING
              </span>
              <span className="font-ui text-[12.5px] font-semibold">Results disclosure →</span>
            </Link>
          ) : (
            <p className="border-b border-hairline-faint py-2.5 font-mono text-[10.5px] text-ink-faint">
              No linked filing for this print.
            </p>
          )}
          <Link
            href={`/stocks/${ev.venueCode}/${ev.ticker}`}
            className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5 text-ink hover:bg-paper-tint"
          >
            <span className="flex-none border border-hairline-strong px-1.5 py-[2px] font-mono text-[8px] font-semibold text-ink-muted">
              STOCK
            </span>
            <span className="font-ui text-[12.5px] font-semibold">{ev.ticker} overview →</span>
          </Link>

          <div className="mt-5 border border-ink bg-paper-tint px-4 py-3.5">
            {ev.score && ev.score.score != null ? (
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-[10px] font-semibold">{ev.score.score}</span>
                <span className="font-ui text-[11.5px] text-ink-muted">Marsad Score</span>
                <span className="ml-auto">
                  {toRating(ev.score.rating) ? <RatingBadge rating={toRating(ev.score.rating)!} /> : null}
                </span>
              </div>
            ) : (
              <p className="font-mono text-[10.5px] tracking-[0.06em] text-ink-faint uppercase">
                Marsad Score not yet computed for this security
              </p>
            )}
          </div>
        </aside>
      </div>
    </article>
  );
}

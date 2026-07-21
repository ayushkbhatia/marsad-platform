import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getAnalystLeaderboard, getCoverageBySector, listResearchArticles } from "@/lib/data/editorial";
import { EmptyState } from "@/components/ui";
import { AnalystLeaderboard } from "@/components/reader/editorial/AnalystLeaderboard";
import { ArticleCard } from "@/components/reader/editorial/ArticleCard";

/**
 * Analyst hub (1i) — "The Coverage Desk". `public.analysts` is world-readable
 * but has 0 rows today (producer pending, per AGENTS.md task brief); every
 * section below reads a real table (`analysts`, `analyst_calls`,
 * `content_items`) and renders `EmptyState awaitingFeed` honestly rather than
 * the design mock's fabricated stats (61 names, 12.4k followers, a sector
 * breakdown, etc. — none of that is backed by a column today). The design's
 * "Request coverage / cast a vote" box is omitted entirely: no
 * `coverage_requests` table exists yet (it's listed as a future entity in
 * `docs/architecture/02-data-lake.md` §"Improvements adopted") — this page
 * doesn't fabricate a vote count either.
 */

export const metadata: Metadata = {
  title: "The Coverage Desk",
  description: "Marsad's in-house analysts — every call timestamped, tracked and scored in public.",
};

export default function AnalystHubPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-4 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">The Coverage Desk</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">
          Every call timestamped and archived — track records can&rsquo;t be edited retroactively.
        </p>
        <Link
          href="/analysts/apply"
          className="ml-auto flex-none border border-ink bg-ink px-4 py-2 font-ui text-[11px] font-semibold tracking-[0.04em] text-paper-tint uppercase hover:opacity-90"
        >
          Apply to publish
        </Link>
      </header>

      <Suspense fallback={<HubFallback />}>
        <HubBody />
      </Suspense>
    </div>
  );
}

function HubFallback() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
      <div className="h-72 animate-pulse bg-hairline-soft" />
      <div className="h-72 animate-pulse bg-hairline-soft" />
    </div>
  );
}

async function HubBody() {
  const [leaderboard, sectorCoverage, latest] = await Promise.all([
    getAnalystLeaderboard(20),
    getCoverageBySector(),
    listResearchArticles({ limit: 3 }),
  ]);

  return (
    <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-8">
        <section>
          <div className="border-b-2 border-ink pb-1.5">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Leaderboard — trailing 24 months
            </span>
          </div>
          <div className="mt-2">
            <AnalystLeaderboard rows={leaderboard} />
          </div>
        </section>

        <section>
          <div className="border-b-2 border-ink pb-1.5">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Latest from the desk
            </span>
          </div>
          <div className="mt-3">
            {latest.length === 0 ? (
              <EmptyState
                variant="awaitingFeed"
                title="No research published yet"
                body="Visit the research index to see the pipeline once the first piece goes live."
                action={
                  <Link
                    href="/research"
                    className="border border-ink px-4 py-2 font-ui text-[11.5px] font-semibold text-ink hover:bg-paper-tint"
                  >
                    Go to Research →
                  </Link>
                }
              />
            ) : (
              <div className="grid grid-cols-1 border-t border-l border-hairline sm:grid-cols-3">
                {latest.map((a) => (
                  <ArticleCard key={a.id} article={a} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <aside className="flex flex-col gap-6">
        <div>
          <div className="border-b-2 border-ink pb-1.5">
            <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
              Coverage by sector
            </span>
          </div>
          <div className="mt-3">
            {sectorCoverage.length === 0 ? (
              <EmptyState variant="awaitingFeed" title="No open calls yet" />
            ) : (
              <div className="flex flex-col gap-2.5">
                {sectorCoverage.map((s) => (
                  <div key={s.sector} className="flex items-center gap-2.5">
                    <span className="w-[92px] flex-none truncate font-ui text-[11.5px] text-ink-mid">
                      {s.sector}
                    </span>
                    <span className="h-[9px] flex-1 bg-hairline">
                      <span
                        className="block h-full bg-ink"
                        style={{ width: `${Math.min(100, s.count * 8)}%` }}
                      />
                    </span>
                    <span className="w-[24px] flex-none text-right font-mono text-[10px] text-ink-muted">
                      {s.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border border-hairline-strong bg-paper-tint px-4 py-4">
          <span className="font-mono text-[9.5px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
            Publish on Marsad
          </span>
          <p className="mt-2 font-ui text-[12px] leading-[1.55] text-ink-mid">
            Marsad analysts keep a public, permanent track record and share revenue on reader
            subscriptions. Want to see a name covered — or cover one yourself?
          </p>
          <Link
            href="/analysts/apply"
            className="mt-3 inline-block border border-ink px-3.5 py-2 font-ui text-[11px] font-semibold text-ink hover:bg-paper"
          >
            Apply to publish →
          </Link>
        </div>
      </aside>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { runPresetScreen, screenerHref, criteriaLines, findPresetScreen } from "@/lib/data/dataroom";
import { ScreenMatchTable } from "@/components/reader/dataroom/ScreenMatchTable";
import { SectionBar, EmptyState } from "@/components/ui";

/**
 * Screen preview (9b) — dark data-room. Runs one curated preset against the
 * live (cached) screener universe in-memory, shows a 3-row free preview
 * (`ScreenMatchTable`) and a "see all N" CTA into the real, unrestricted
 * `/screener?...` run. The mockup's backtest/social rails (forks, follows,
 * analyst byline, hit-rate backtest) need data this platform doesn't have
 * (no backtesting engine, no social graph, no per-analyst authorship) and are
 * left out rather than fabricated. `noindex`.
 */

const FREE_LIMIT = 3;

type Params = { screenId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { screenId } = await params;
  const screen = findPresetScreen(screenId);
  return {
    title: screen ? screen.name : "Screen",
    description: screen?.description,
    robots: { index: false, follow: false },
  };
}

export default async function ScreenPreviewPage({ params }: { params: Promise<Params> }) {
  const { screenId } = await params;
  const result = await runPresetScreen(screenId);
  if (!result) notFound();

  const { screen, matches, total, universe } = result;
  const lines = criteriaLines(screen.criteria);
  const href = screenerHref(screen.criteria);

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <div className="flex items-center gap-2 border-b border-dark-hairline pb-3 font-mono text-[11px] text-dark-text-mid">
        <Link href="/screens" className="no-underline hover:text-dark-text hover:underline underline-offset-2">
          Explore
        </Link>
        <span className="text-dark-text-faint">/</span>
        <span className="font-semibold text-dark-text">{screen.name}</span>
        <Link href="/screens" className="ml-auto no-underline hover:text-dark-text hover:underline underline-offset-2">
          ← All screens
        </Link>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div>
          <span className="font-mono text-[8px] font-semibold tracking-[0.1em] text-dark-text-faint uppercase">
            {screen.tag}
          </span>
          <h1 className="mt-2 font-display text-[28px] font-bold tracking-[-0.015em] text-dark-text">
            {screen.name}
          </h1>
          <p className="mt-2 max-w-[640px] font-ui text-[13px] leading-relaxed text-dark-text-mid">
            {screen.description}
          </p>

          {lines.length > 0 && (
            <>
              <div className="mt-5 font-mono text-[8.5px] tracking-[0.14em] text-dark-text-faint uppercase">
                Criteria
              </div>
              <div className="mt-1.5 border border-dark-hairline-strong bg-dark-panel px-4 py-3 font-mono text-[12px] leading-[1.9] text-dark-text">
                {lines.map((line, i) => (
                  <span key={line}>
                    {line}
                    {i < lines.length - 1 && <span className="text-dark-text-faint"> AND</span>}
                    <br />
                  </span>
                ))}
              </div>
            </>
          )}

          <div className="mt-6">
            <SectionBar
              surface="dark"
              label="Matches"
              right={
                total <= FREE_LIMIT
                  ? `${total} ${total === 1 ? "NAME" : "NAMES"}`
                  : `${total} NAMES · ${FREE_LIMIT} SHOWN FREE`
              }
            />
          </div>

          {matches.length === 0 ? (
            <div className="mt-2">
              <EmptyState
                surface="dark"
                variant="empty"
                title="Nothing matches this screen right now."
                body="The universe moves intraday — check back later or open it in the Screener to adjust the filters."
                action={
                  <Link
                    href={href}
                    className="inline-block bg-dark-text px-4 py-2 font-ui text-[11px] font-bold tracking-[0.06em] text-dark-bg uppercase no-underline"
                  >
                    Open in Screener →
                  </Link>
                }
              />
            </div>
          ) : (
            <ScreenMatchTable rows={matches} total={total} screenerHref={href} freeLimit={FREE_LIMIT} />
          )}
        </div>

        <aside>
          <div className="border border-dark-hairline-strong bg-dark-panel px-4 py-4">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-dark-text-faint uppercase">
              Run this screen
            </div>
            <p className="mt-2 font-ui text-[12px] leading-relaxed text-dark-text-mid">
              See all {total.toLocaleString("en-US")} matches with delayed prices, add filters and re-sort — free,
              no lock beyond the usual premium ratio columns.
            </p>
            <Link
              href={href}
              className="mt-3 block bg-dark-text py-2.5 text-center font-ui text-[11.5px] font-bold tracking-[0.06em] text-dark-bg uppercase no-underline"
            >
              Open in Screener →
            </Link>
          </div>
          <p className="mt-4 font-mono text-[9px] leading-[1.6] text-dark-text-faint">
            Run against {universe.toLocaleString("en-US")} public names. Delayed data, information only, not
            investment advice.
          </p>
        </aside>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { runSearch, type SearchDocType } from "@/lib/data/search";
import type { FilingItem } from "@/lib/data/filings";
import { SearchTopMatch } from "@/components/reader/search/SearchTopMatch";
import { SearchNoResults } from "@/components/reader/search/SearchNoResults";
import { RecentSearches } from "@/components/reader/search/RecentSearches";
import { FilingsList } from "@/components/reader/FilingsList";
import { EmptyState } from "@/components/ui";

/**
 * Measure the search round-trip OUTSIDE any component body.
 *
 * The "N results in X.XXs" line is a credibility signal, so it must be a real
 * measurement — but `Date.now()` inside a component is impure during render
 * (react-hooks/purity), and that rule is static, so `connection()` alone does
 * not satisfy it. Doing the timing in a plain module-scope async function is
 * both lint-clean and honest.
 *
 * NOTE this reports RESPONSE time, not query time: `runSearch` is `use cache`,
 * so a cache hit legitimately measures a few milliseconds.
 */
async function timedSearch(q: string) {
  const t0 = Date.now();
  const result = await runSearch(q);
  return { result, elapsedS: ((Date.now() - t0) / 1000).toFixed(2) };
}

/**
 * 16a Search results / 17c No results — federated search over Postgres FTS +
 * pg_trgm (`public.fn_search`, 04-reader-app.md §6). `noindex` per §8 (a query
 * string's worth of canonical chaos, same reasoning as Compare).
 *
 * Whole page is dynamic on `?q=`/`?type=` (consuming `searchParams` already
 * forces the dynamic API, same as `(reader)/compare/page.tsx` — no manual
 * `<Suspense>` needed; `loading.tsx` covers the 17e shimmer state).
 *
 * NOT built here (out of scope for this slice, flagged for the lead): a search
 * INPUT box. Neither assigned screen (16a/17c) shows one inside the results
 * page body — the nav's disabled `<span>Search</span>` stub
 * (`src/components/reader/MarsadNav.tsx`) is presumably where that lives once
 * wired to `<Link href="/search">` (or a search modal); this route only
 * renders results for an already-supplied `?q=`.
 */

type Search = { q?: string; type?: string };

function firstParam(v: string | undefined): string {
  return (v ?? "").trim();
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  return {
    title: q ? `Search: ${q}` : "Search",
    description:
      "Federated search across GCC stocks, filings, and research — Postgres full-text search, single-digit-millisecond results.",
    robots: { index: false, follow: false },
  };
}

const FACETS: Array<{ key: SearchDocType | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "security", label: "Stocks" },
  { key: "filing", label: "Filings" },
];

function facetHref(q: string, key: string): string {
  const p = new URLSearchParams({ q });
  if (key !== "all") p.set("type", key);
  return `/search?${p.toString()}`;
}

function FacetBar({
  q,
  active,
  counts,
}: {
  q: string;
  active: string;
  counts: Map<string, number>;
}) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div className="ml-auto flex flex-none flex-wrap gap-1.5">
      {FACETS.filter((f) => f.key === "all" || (counts.get(f.key) ?? 0) > 0).map((f) => {
        const isActive = f.key === active || (active === "" && f.key === "all");
        const count = f.key === "all" ? total : (counts.get(f.key) ?? 0);
        return (
          <Link
            key={f.key}
            href={facetHref(q, f.key)}
            className={
              isActive
                ? "bg-ink px-2.5 py-1 font-ui text-[10px] font-bold text-paper-tint"
                : "border border-hairline-strong px-2.5 py-1 font-ui text-[10px] text-ink-muted transition-colors hover:text-ink"
            }
          >
            {f.label}
            {f.key !== "all" ? <span className="ml-1 opacity-70">{count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

function AskAiTeaser({ q }: { q: string }) {
  return (
    <div>
      <div className="border-b-2 border-ink pb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
        Ask Marsad AI
      </div>
      <div
        className="mt-2.5 cursor-not-allowed border border-hairline-strong bg-paper-tint px-3.5 py-3.5 opacity-70"
        title="Marsad AI — coming soon"
      >
        <div className="flex items-center gap-[7px]">
          <span className="h-[7px] w-[7px] flex-none rotate-45 bg-ink" aria-hidden="true" />
          <span className="font-mono text-[8px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
            Grounded answer
          </span>
        </div>
        <p className="mt-2 font-display text-[14.5px] font-semibold leading-snug text-ink-muted">
          &ldquo;Summarise everything {q} disclosed this week&rdquo; →
        </p>
      </div>
    </div>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const activeType = firstParam(sp.type);

  if (!q) {
    return (
      <div className="mx-auto max-w-[1180px] px-5 py-10 sm:px-8">
        <EmptyState
          title="Search Marsad"
          body="Enter a ticker, company name, sector, or filing phrase — for example “2222”, “Aramco”, “utilities”, or “rights issue”."
        />
      </div>
    );
  }

  // `connection()` marks the wall-clock read below as the deliberate dynamic
  // read it is (same posture as `getMarketState` in `lib/data/markets.ts`).
  await connection();
  const { result, elapsedS } = await timedSearch(q);

  const counts = new Map(result.typeCounts.map((c) => [c.docType, c.count]));
  const hasResults = result.totalCount > 0;

  const filingItems: FilingItem[] = result.filingHits.map((h) => ({
    id: h.docId,
    securityId: null,
    venueCode: null,
    ticker: h.ticker,
    name: null,
    formCode: null,
    filingType: h.filingType,
    title: h.title,
    filedAt: h.filedAt,
    isMarketMoving: h.isMarketMoving,
    pdfPages: null,
    aiSummary: null,
  }));

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-center gap-3 border-b-2 border-ink pb-3">
        <span className="font-display text-[15px] text-ink-muted">Results for</span>
        <span className="font-display text-[24px] font-bold text-ink">&ldquo;{q}&rdquo;</span>
        {hasResults ? (
          <span className="font-mono text-[9px] text-ink-faint">
            {result.totalCount.toLocaleString("en-US")} RESULT{result.totalCount === 1 ? "" : "S"} ·{" "}
            {elapsedS}s
          </span>
        ) : (
          <span className="font-mono text-[9px] text-ink-faint">0 RESULTS</span>
        )}
        {hasResults ? <FacetBar q={q} active={activeType} counts={counts} /> : null}
      </div>

      {!hasResults ? (
        <SearchNoResults q={q} />
      ) : (
        <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            {activeType === "security" ? (
              <>
                <div className="mb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
                  Stocks · {counts.get("security") ?? result.securityHits.length}
                </div>
                <ul className="divide-y divide-hairline-faint border-y border-hairline-faint">
                  {result.securityHits.map((h) => (
                    <li key={`${h.docType}-${h.docId}`}>
                      <Link
                        href={h.url}
                        className="flex items-baseline gap-3 py-3 text-ink no-underline hover:underline"
                      >
                        <span className="w-[64px] flex-none font-mono text-[11px] font-semibold text-ink">
                          {h.ticker}
                        </span>
                        <span className="font-ui text-[13.5px] text-ink">{h.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : activeType === "filing" ? (
              <>
                <div className="mb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
                  Filings · {counts.get("filing") ?? filingItems.length}
                </div>
                <FilingsList items={filingItems} showTicker />
              </>
            ) : (
              <>
                {result.topSecurity ? <SearchTopMatch hit={result.topSecurity} /> : null}

                {filingItems.length > 0 ? (
                  <div className={result.topSecurity ? "mt-6" : ""}>
                    <div className="mb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
                      Filings · {counts.get("filing") ?? filingItems.length}
                    </div>
                    <FilingsList items={filingItems.slice(0, 6)} showTicker />
                    {filingItems.length > 6 ? (
                      <Link
                        href={facetHref(q, "filing")}
                        className="mt-2 inline-block font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
                      >
                        All {counts.get("filing") ?? filingItems.length} filings →
                      </Link>
                    ) : null}
                  </div>
                ) : null}

                {!result.topSecurity && filingItems.length === 0 ? (
                  <EmptyState
                    title="Matched, but nothing to preview yet"
                    body="This query matched documents outside the types shown here."
                  />
                ) : null}
              </>
            )}
          </div>

          <aside className="flex flex-col gap-5">
            <AskAiTeaser q={q} />
            <RecentSearches current={q} />
          </aside>
        </div>
      )}
    </div>
  );
}

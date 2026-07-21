import type { Metadata } from "next";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getCompareEntity, parseComparePairs, type CompareEntity } from "@/lib/data/entities";
import { CompareTable } from "@/components/reader/entities/CompareTable";
import { CompareHeaderRow } from "@/components/reader/entities/CompareHeaderRow";
import { EmptyState } from "@/components/ui";

/**
 * 18a Compare — `?t=TDWL:2222,QE:QNBK,ADX:FAB` (up to 4 venue:ticker pairs). Fully server-
 * computed from `resolveSecurity` + `getCompareEntity` (both `use cache`); the only client JS
 * on the page is `CompareHeaderRow`'s add/remove control (04-reader-app.md §2: "Compare —
 * server-computed table … / Add/remove ticker control"). `noindex` — canonical chaos across
 * every `?t=` permutation (04-reader-app.md §8).
 *
 * Reads directly off `searchParams` (a dynamic API under cacheComponents), same shape as
 * `(dataroom)/heatmap`'s `?sector=` handling — no `<Suspense>` needed since the whole page is
 * already dynamic on `t`.
 */

type Search = { t?: string | string[] };

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const sp = await searchParams;
  const pairs = parseComparePairs(sp.t);
  const label = pairs.map((p) => p.ticker).join(", ");
  return {
    title: label ? `Compare: ${label}` : "Compare",
    description:
      "Side-by-side comparison of GCC-listed equities — price, USD market cap, returns, margins, growth and the Marsad Score.",
    robots: { index: false, follow: false },
  };
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const pairs = parseComparePairs(sp.t);

  const resolved = await Promise.all(pairs.map((p) => resolveSecurity(p.venue, p.ticker)));
  const unresolved = pairs.filter((_, i) => resolved[i] == null);
  const ids = resolved.filter((r): r is NonNullable<(typeof resolved)[number]> => r != null).map((r) => r.id);

  const entities = (await Promise.all(ids.map((id) => getCompareEntity(id)))).filter(
    (e): e is CompareEntity => e != null,
  );

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading font-bold text-ink">Compare</h1>
        <p className="font-ui text-[12.5px] text-ink-muted">Up to four GCC names, side by side</p>
      </header>

      {unresolved.length > 0 ? (
        <p className="mt-3 font-mono text-[10px] text-caution-text">
          Not found: {unresolved.map((p) => `${p.venue}:${p.ticker}`).join(", ")}
        </p>
      ) : null}

      {entities.length === 0 ? (
        <div className="mt-6">
          <CompareHeaderRow columns={[]} />
          <EmptyState
            className="mt-4"
            variant="empty"
            title="Nothing to compare yet"
            body="Add up to four venue:ticker pairs above (e.g. TDWL:2222) — or share a link with ?t=TDWL:2222,QE:QNBK,ADX:FAB to jump straight in."
          />
        </div>
      ) : (
        <div className="mt-2">
          <CompareTable entities={entities} />
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <span
          className="cursor-not-allowed bg-ink px-4 py-2.5 font-ui text-[11px] font-semibold tracking-[0.02em] text-paper-tint uppercase opacity-60"
          title="Marsad AI — coming soon"
        >
          ✦ Ask AI to compare these
        </span>
        <span
          className="cursor-not-allowed border border-hairline-strong px-4 py-2 font-ui text-[11px] font-semibold text-ink-muted"
          title="Export — coming soon"
        >
          Export table
        </span>
      </div>
    </div>
  );
}

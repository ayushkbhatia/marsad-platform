import type { Metadata } from "next";
import Link from "next/link";
import { getHoldersDirectory } from "@/lib/data/entities";
import { EmptyState } from "@/components/ui";
import { fmtCompact } from "@/lib/reader/format";

/**
 * 20b Investors & shareholders directory. `holders` has 0 rows today (producer pending, same
 * tier as `ownership_snapshots`/`company_people` on the stock ownership tab) — the full
 * directory shell (filter chips, header row) is built against real columns so it lights up
 * unmodified the moment holders land; today it renders `EmptyState awaitingFeed`. Indexable
 * (04-reader-app.md §8 only lists heatmap/screener/member/search/compare as `noindex`).
 */

export const metadata: Metadata = {
  title: "Investors & Shareholders",
  description:
    "Who owns the GCC — sovereign funds, institutions, family offices and funds, cross-referenced against disclosed positions.",
};

type Search = { type?: string };

const TYPES: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "sovereign", label: "Sovereign" },
  { key: "institution", label: "Institutions" },
  { key: "family_office", label: "Family offices" },
  { key: "fund", label: "Funds" },
];

export default async function InvestorsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const activeType = TYPES.some((t) => t.key === sp.type) ? (sp.type ?? "") : "";

  const holders = await getHoldersDirectory();
  const filtered = activeType ? holders.filter((h) => h.holderType === activeType) : holders;

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="border-b-2 border-ink pb-3.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-display text-heading font-bold text-ink">Investors &amp; shareholders</h1>
          <p className="font-ui text-[12.5px] text-ink-muted">
            Who owns the GCC — funds, family offices and holders, cross-referenced
          </p>
        </div>
      </header>

      <nav className="mt-3.5 flex flex-wrap gap-1.5">
        {TYPES.map((t) => (
          <Link
            key={t.key || "all"}
            href={t.key ? `/investors?type=${t.key}` : "/investors"}
            className={`px-2.5 py-1 font-ui text-[10.5px] font-semibold ${
              activeType === t.key ? "bg-ink text-paper-tint" : "border border-hairline-strong text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="mt-4 grid grid-cols-[1fr_130px_90px_150px_110px] gap-3 border-b border-hairline px-2.5 py-2">
        <span className="font-mono text-[8.5px] text-ink-faint uppercase">Holder</span>
        <span className="font-mono text-[8.5px] text-ink-faint uppercase">Type</span>
        <span className="text-right font-mono text-[8.5px] text-ink-faint uppercase">Holdings</span>
        <span className="text-right font-mono text-[8.5px] text-ink-faint uppercase">Disclosed value</span>
        <span className="text-right font-mono text-[8.5px] text-ink-faint uppercase">AUM</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          className="mt-4"
          variant="awaitingFeed"
          title={activeType ? "No holders in this category yet" : "No investor directory yet"}
          body="Sovereign funds, institutions, family offices and fund positions appear here once disclosed >5% stakes and registrar filings are ingested."
        />
      ) : (
        filtered.map((h) => (
          <Link
            key={h.id}
            href={`/investors/${h.slug}`}
            className="grid grid-cols-[1fr_130px_90px_150px_110px] items-center gap-3 border-b border-hairline-faint px-2.5 py-3 text-ink hover:bg-paper-tint"
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              <span className="flex h-8 w-8 flex-none items-center justify-center border-[1.5px] border-ink font-display text-[11px] font-semibold">
                {h.name.slice(0, 3).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{h.name}</div>
                <div className="font-mono text-[8.5px] text-ink-faint uppercase">{h.country ?? "—"}</div>
              </div>
            </div>
            <span className="border border-hairline-strong px-1.5 py-[3px] text-center font-ui text-[9px] font-semibold uppercase text-ink-muted">
              {h.holderType.replace("_", " ")}
            </span>
            <span className="text-right font-mono text-[12px] font-semibold tabular-nums">{h.holdingsCount}</span>
            <span className="text-right font-mono text-[12px] tabular-nums">
              {h.disclosedValueUsd != null ? `$${fmtCompact(h.disclosedValueUsd)}` : "—"}
            </span>
            <span className="text-right font-mono text-[10px] text-ink-faint uppercase">
              {h.aumSelfReported ? "Self-reported" : "—"}
            </span>
          </Link>
        ))
      )}

      <p className="mt-4 font-mono text-[9px] leading-[1.6] text-ink-faint">
        Holdings and changes from disclosed &gt;5% stakes and fund filings. Some AUM figures are self-reported.
      </p>
    </div>
  );
}

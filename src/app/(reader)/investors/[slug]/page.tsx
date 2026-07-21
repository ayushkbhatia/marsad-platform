import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getHolderDetail } from "@/lib/data/entities";
import { EmptyState } from "@/components/ui";
import { fmtCompact, sectorLabel } from "@/lib/reader/format";

/**
 * 20c Investor detail (e.g. PIF). No `generateStaticParams` — `holders` has 0 rows today
 * (producer pending), same non-404 treatment as `ipo/[offerSlug]`/`getIpoOffer`: an
 * unresolved slug renders `EmptyState awaitingFeed` (the whole tier is pre-launch, not one
 * missing record), so params are runtime and the body is Suspense-wrapped (cacheComponents
 * rule). "Sector tilt" and per-position "VALUE" are derived (stakePct × the position's
 * USD-normalized market cap) — `holder_positions` carries no value column — see
 * `src/lib/data/entities.ts` for the exact math and its own upstream dependency on the
 * `key_ratios` anon-read gap flagged at the top of that file.
 */

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const holder = await getHolderDetail(slug);
  if (!holder) return { title: "Investors" };
  return {
    title: holder.name,
    description: `${holder.name} — GCC holdings, disclosed positions and sector tilt.`,
  };
}

export default function InvestorDetailPage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-10 sm:px-8">
      <Suspense fallback={<DetailFallback />}>
        <InvestorDetailBody params={params} />
      </Suspense>
    </div>
  );
}

function DetailFallback() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-40 animate-pulse bg-hairline-soft" />
      <div className="h-14 w-2/3 animate-pulse bg-hairline" />
      <div className="h-64 animate-pulse bg-hairline-soft" />
    </div>
  );
}

function fmtStake(n: number | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
function fmtPP(n: number | null): { text: string; dir: "up" | "down" | "flat" } {
  if (n == null) return { text: "—", dir: "flat" };
  if (n === 0) return { text: "unch", dir: "flat" };
  const s = Math.abs(n).toFixed(2);
  return n > 0 ? { text: `▲ +${s}pp`, dir: "up" } : { text: `▼ −${s}pp`, dir: "down" };
}

async function InvestorDetailBody({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const holder = await getHolderDetail(slug);

  if (!holder) {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
          <Link href="/investors" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
            Investors
          </Link>
          <span className="text-ink-faint">/</span>
          <span className="text-ink-faint">Holder</span>
        </div>
        <div className="mt-6">
          <EmptyState
            variant="awaitingFeed"
            title="This holder isn't tracked yet"
            body="Investor profiles populate once disclosed positions are ingested (holders/holder_positions). Check the directory for what's currently tracked."
            action={
              <Link href="/investors" className="border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink hover:bg-paper">
                ← Back to Investors
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <article>
      <div className="flex items-center gap-2 border-b border-hairline pb-3 font-ui text-[11px] text-ink-muted">
        <Link href="/investors" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink">
          Investors
        </Link>
        <span className="text-ink-faint">/</span>
        <span className="font-semibold text-ink">{holder.name}</span>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-[18px] border-b-2 border-ink pb-4">
        <span className="flex h-[60px] w-[60px] flex-none items-center justify-center border-2 border-ink font-display text-[20px] font-semibold">
          {holder.name.slice(0, 3).toUpperCase()}
        </span>
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.012em] text-ink">{holder.name}</h1>
          <p className="mt-0.5 font-ui text-[12px] text-ink-muted">
            {holder.holderType.replace("_", " ")}
            {holder.country ? ` · ${holder.country}` : ""}
            {holder.established ? ` · established ${holder.established}` : ""}
          </p>
        </div>
        <div className="ml-auto flex gap-6 text-right">
          <div>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">GCC holdings</div>
            <div className="text-[20px] font-semibold">{holder.positions.length}</div>
          </div>
          <div>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Disclosed value</div>
            <div className="text-[20px] font-semibold">
              {holder.disclosedValueUsd != null ? `$${fmtCompact(holder.disclosedValueUsd)}` : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-[18px] grid grid-cols-1 gap-[34px] lg:grid-cols-[1fr_320px]">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
              Disclosed GCC positions
            </span>
            <span className="font-mono text-[9px] text-ink-faint">SORTED BY VALUE</span>
          </div>
          <div className="mt-2 grid grid-cols-[64px_1fr_70px_90px_96px] gap-3 border-b border-hairline px-2 py-1.5">
            <span className="font-mono text-[8px] text-ink-faint">TICKER</span>
            <span className="font-mono text-[8px] text-ink-faint">COMPANY</span>
            <span className="text-right font-mono text-[8px] text-ink-faint">STAKE</span>
            <span className="text-right font-mono text-[8px] text-ink-faint">VALUE</span>
            <span className="text-right font-mono text-[8px] text-ink-faint">Δ QOQ</span>
          </div>

          {holder.positions.length === 0 ? (
            <EmptyState
              className="mt-3"
              variant="awaitingFeed"
              title="No disclosed positions yet"
              body="This holder's GCC positions appear here once >5% disclosures or fund filings are ingested."
            />
          ) : (
            holder.positions.map((p) => {
              const chg = fmtPP(p.qoqChangePp);
              return (
                <Link
                  key={p.securityId}
                  href={`/stocks/${p.venueCode}/${p.ticker}`}
                  className="grid grid-cols-[64px_1fr_70px_90px_96px] items-center gap-3 border-b border-hairline-faint px-2 py-2.5 text-ink hover:bg-paper-tint"
                >
                  <span className="font-mono text-[11px] font-semibold">{p.ticker}</span>
                  <span className="truncate text-[12px]">{p.companyName}</span>
                  <span className="text-right font-mono text-[11.5px]">{fmtStake(p.stakePct)}</span>
                  <span className="text-right font-mono text-[11.5px] font-semibold">
                    {p.valueUsd != null ? `$${fmtCompact(p.valueUsd)}` : "—"}
                  </span>
                  <span
                    className={`text-right font-mono text-[11px] ${
                      chg.dir === "up" ? "text-positive" : chg.dir === "down" ? "text-negative" : "text-ink-faint"
                    }`}
                  >
                    {chg.text}
                  </span>
                </Link>
              );
            })
          )}
        </div>

        <div>
          <div className="border border-hairline px-4 py-3.5">
            <div className="font-mono text-[8px] tracking-[0.14em] text-ink-faint uppercase">Sector tilt</div>
            {holder.sectorTilt.length === 0 ? (
              <p className="mt-2.5 font-ui text-[11.5px] text-ink-faint">
                Not enough disclosed positions to compute a sector mix yet.
              </p>
            ) : (
              <div className="mt-[11px] flex flex-col gap-2">
                {holder.sectorTilt.map((s) => (
                  <div key={s.sector} className="flex items-center gap-2.5">
                    <span className="w-16 flex-none truncate text-[11px]">{sectorLabel(s.sector)}</span>
                    <span className="h-[9px] flex-1 bg-hairline-soft">
                      <span className="block h-full bg-ink" style={{ width: `${Math.min(100, s.weightPct)}%` }} />
                    </span>
                    <span className="font-mono text-[9px] text-ink-muted">{s.weightPct.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 border border-hairline-strong px-4 py-3.5 text-center font-ui text-[10.5px] font-semibold text-ink-muted uppercase tracking-[0.06em]">
            Alert on disclosures — coming soon
          </div>
        </div>
      </div>
    </article>
  );
}

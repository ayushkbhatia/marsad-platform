import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getStockOverview } from "@/lib/data/stocks";
import { getFilingsForSecurity, getFilingsCountForSecurity } from "@/lib/data/filings";
import { ScoreModule } from "@/components/ui";
import { Sparkline } from "@/components/reader/Sparkline";
import { FilingsList } from "@/components/reader/FilingsList";
import { PremiumLock } from "@/components/reader/PremiumLock";
import {
  toRating,
  sectorLabel,
  currencyLabel,
  fmtPrice,
  fmtDate,
} from "@/lib/reader/format";

/**
 * Overview tab. PUBLIC-only surface: identity, the headline Marsad Score
 * (grades LOCKED — never fetched), a real-close sparkline, 52-week range,
 * filings teaser, and empty-state tiles. The valuation strip is a premium STUB.
 *
 * Every read is `use cache` (resolveSecurity / getStockOverview / filings), so
 * this prerenders per prebuilt param; the quote header (in the layout) carries
 * the live-ish delayed poll.
 */

type Params = { venue: string; ticker: string };

function deltaString(d: number | null): string {
  if (d == null || d === 0) return "▬ FLAT THIS WEEK";
  return d > 0 ? `▲ +${d} THIS WEEK` : `▼ −${Math.abs(d)} THIS WEEK`;
}

function Stat({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[9px] tracking-[0.14em] text-ink-faint uppercase">{label}</span>
      <span className={`text-[14px] text-ink ${mono ? "font-mono tabular-nums" : "font-ui"}`}>{value}</span>
    </div>
  );
}

function Range52w({
  low,
  high,
  last,
}: {
  low: number | null;
  high: number | null;
  last: number | null;
}) {
  if (low == null || high == null || high <= low) {
    return <span className="font-mono text-[14px] text-ink-faint">—</span>;
  }
  const pct =
    last == null ? null : Math.max(0, Math.min(100, ((last - low) / (high - low)) * 100));
  return (
    <div className="w-full">
      <div className="relative h-[6px] w-full bg-hairline">
        {pct != null ? (
          <span
            className="absolute top-1/2 h-[12px] w-[2px] -translate-y-1/2 bg-ink"
            style={{ left: `${pct}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-ink-muted">
        <span>{fmtPrice(low)}</span>
        <span>{fmtPrice(high)}</span>
      </div>
    </div>
  );
}

export default async function OverviewPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const [overview, filings, filingsCount] = await Promise.all([
    getStockOverview(sec.id),
    getFilingsForSecurity(sec.id, 5),
    getFilingsCountForSecurity(sec.id),
  ]);
  if (!overview) notFound();

  const { quote, score, sparkline, sparklineFrom, sparklineTo } = overview;
  const base = `/stocks/${overview.venueCode}/${overview.ticker}`;
  const cur = currencyLabel(overview.currency);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      {/* Main column */}
      <div className="flex flex-col gap-8">
        {/* Sparkline + key facts */}
        <section className="border border-hairline bg-paper">
          <div className="flex items-center justify-between border-b border-hairline-faint px-4 py-2.5">
            <span className="font-mono text-[9px] font-semibold tracking-[0.18em] text-ink-muted uppercase">
              Price · recent sessions
            </span>
            <Link
              href={`${base}/chart`}
              className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
            >
              Full chart →
            </Link>
          </div>
          <div className="px-4 py-4">
            {sparkline.length >= 2 ? (
              <>
                <Sparkline values={sparkline} width={640} height={72} className="w-full" />
                <div className="mt-2 flex justify-between font-mono text-[9.5px] text-ink-faint">
                  <span>{fmtDate(sparklineFrom)}</span>
                  <span>{sparkline.length} sessions</span>
                  <span>{fmtDate(sparklineTo)}</span>
                </div>
              </>
            ) : (
              <p className="py-6 text-center font-mono text-[11px] tracking-[0.08em] text-ink-faint uppercase">
                No recent price history
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-hairline-faint px-4 py-4 sm:grid-cols-4">
            <Stat label="Sector" value={sectorLabel(overview.sector)} mono={false} />
            <Stat label="Currency" value={cur || "—"} />
            <Stat label="Filings" value={filingsCount.toLocaleString("en-US")} />
            <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
              <span className="font-mono text-[9px] tracking-[0.14em] text-ink-faint uppercase">
                52-week range
              </span>
              <Range52w low={quote?.week52Low ?? null} high={quote?.week52High ?? null} last={quote?.last ?? null} />
            </div>
          </div>
        </section>

        {/* Latest filings teaser */}
        <section>
          <div className="mb-2 flex items-baseline justify-between border-b border-hairline pb-1.5">
            <h2 className="font-display text-heading-sm font-semibold text-ink">Latest filings</h2>
            <Link
              href={`${base}/filings`}
              className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
            >
              All {filingsCount.toLocaleString("en-US")} →
            </Link>
          </div>
          <FilingsList items={filings} showSummary emptyLabel="No filings recorded for this security yet." />
        </section>

        {/* Upcoming — empty-state tiles (data gated / not yet ingested) */}
        <section>
          <h2 className="mb-2 border-b border-hairline pb-1.5 font-display text-heading-sm font-semibold text-ink">
            Upcoming
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              { k: "Next dividend", v: "No dividend scheduled" },
              { k: "Next earnings", v: "No date announced" },
            ].map((t) => (
              <div key={t.k} className="border border-hairline bg-paper px-4 py-4">
                <span className="font-mono text-[9px] tracking-[0.14em] text-ink-faint uppercase">{t.k}</span>
                <p className="mt-1.5 font-ui text-[13px] text-ink-faint">{t.v}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Aside: Score + valuation gate */}
      <aside className="flex flex-col gap-5">
        {score && score.score != null ? (
          <ScoreModule
            surface="light"
            variant="locked"
            score={score.score}
            rating={toRating(score.rating) ?? "Hold"}
            delta={deltaString(score.weeklyDelta)}
            footnote={`UPDATED ${fmtDate(score.computedAt)} · FACTOR GRADES PREMIUM`}
          />
        ) : (
          <ScoreModule
            surface="light"
            variant="pending"
            footnote="MARSAD SCORE · NOT YET COMPUTED FOR THIS SECURITY"
          />
        )}

        <PremiumLock
          variant="inline"
          title="Valuation"
          teaser="P/E, P/B, EV/EBITDA and peer multiples — Premium."
        />
      </aside>
    </div>
  );
}

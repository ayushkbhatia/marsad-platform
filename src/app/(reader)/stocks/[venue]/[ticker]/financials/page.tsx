import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { PremiumLock } from "@/components/reader/PremiumLock";

/**
 * Financials tab — PREMIUM STUB (owner decision: financials + valuation ratios +
 * score factor-grades are premium-gated). This route fetches ZERO statement data
 * and sends none to the client: it renders a locked panel with a blurred,
 * data-free statement-tab scaffold and an upgrade affordance. The only read is
 * `resolveSecurity` (public identity, cached) to 404 unknown tickers.
 *
 * DO NOT add financial_statements / key_ratios reads here.
 */

type Params = { venue: string; ticker: string };

const STATEMENT_TABS = ["Income statement", "Balance sheet", "Cash flow"];

/** Data-free blurred scaffold shown behind the paywall (no real numbers). */
function StatementScaffold() {
  return (
    <div className="p-4">
      <div className="flex gap-2 border-b border-hairline-faint pb-3">
        {STATEMENT_TABS.map((t, i) => (
          <span
            key={t}
            className={`px-3 py-1.5 font-ui text-[12px] ${
              i === 0 ? "border-b-2 border-ink font-semibold text-ink" : "text-ink-muted"
            }`}
          >
            {t}
          </span>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 7 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4">
            <div className="h-3 w-40 bg-hairline-soft" />
            <div className="ml-auto h-3 w-16 bg-hairline-soft" />
            <div className="h-3 w-16 bg-hairline-soft" />
            <div className="h-3 w-16 bg-hairline-soft" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function FinancialsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-heading-sm font-semibold text-ink">Financials</h2>
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          {sec.ticker} · {sec.venueCode}
        </span>
      </div>

      <PremiumLock
        variant="panel"
        title="Financial statements"
        teaser={`Full income statement, balance sheet, and cash flow for ${sec.name} — with multi-year history and restatement tracking. Available on Marsad Premium.`}
        scaffold={<StatementScaffold />}
      />

      <p className="font-mono text-[9px] leading-[1.6] text-ink-faint">
        Financials, valuation ratios, and Marsad Score factor grades are Premium
        features. Headline price, filings, and the Marsad Score remain free.
      </p>
    </div>
  );
}

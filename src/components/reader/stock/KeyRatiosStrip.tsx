import type { KeyRatiosStripData } from "@/lib/data/stock-overview";
import { fmtMarketCapLocal } from "@/lib/data/stock-overview";
import { fmtPrice } from "@/lib/reader/format";

/**
 * Overview 9-col key-ratios strip (screen 3a). Free cells (market cap, price,
 * 52w hi/lo) render real numbers from `getKeyRatiosStrip`; the six
 * valuation/return ratios (P/E TTM, book value, div yield, ROCE, ROE, net
 * debt/EBITDA) live in `public.key_ratios` behind `marsad_worker`-only RLS —
 * this component never receives them, only ever rendering the locked stub.
 */

function FreeCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase">{label}</div>
      <div className="mt-[3px] font-ui text-[15px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function LockedCell({ label }: { label: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase">{label}</div>
      <div className="mt-[3px] flex items-center gap-1">
        <span className="text-[10px] opacity-60" aria-hidden>
          🔒
        </span>
        <span className="font-mono text-[9px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Premium
        </span>
      </div>
    </div>
  );
}

export function KeyRatiosStrip({ data }: { data: KeyRatiosStripData }) {
  const week52 =
    data.week52High != null && data.week52Low != null
      ? `${fmtPrice(data.week52High)} / ${fmtPrice(data.week52Low)}`
      : "—";

  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
          Key ratios
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[860px] grid-cols-9 divide-x divide-hairline-soft border border-ink">
          <FreeCell label="Market cap" value={fmtMarketCapLocal(data.marketCap, data.marketCapCurrency)} />
          <FreeCell label="Price" value={fmtPrice(data.price)} />
          <FreeCell label="52W high / low" value={week52} />
          <LockedCell label="P/E (TTM)" />
          <LockedCell label="Book value" />
          <LockedCell label="Div yield" />
          <LockedCell label="ROCE" />
          <LockedCell label="ROE" />
          <LockedCell label="Net debt / EBITDA" />
        </div>
      </div>
    </section>
  );
}

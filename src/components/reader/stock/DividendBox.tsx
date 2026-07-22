import type { DividendBoxData } from "@/lib/data/stock-overview";
import { fmtDate } from "@/lib/reader/format";

/**
 * Rail dividend box (screen 1g). Sourced from the most recently disclosed
 * `dividends` row for this security (see `getDividendBox`'s doc — the anon
 * RLS `world_read` policy on `dividends` only exposes `state = 'live'` rows,
 * so every field renders "—" until the 33b human-confirm gate promotes one).
 */

function DivStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[8.5px] tracking-[0.04em] text-ink-faint uppercase">{label}</div>
      <div className="mt-[3px] font-ui text-[14px] font-semibold text-ink">{value}</div>
    </div>
  );
}

function fmtDps(dps: number | null, currency: string | null): string {
  if (dps == null) return "—";
  return `${currency ? `${currency} ` : ""}${dps.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function fmtPct1(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function DividendBox({ data }: { data: DividendBoxData }) {
  return (
    <div className="border border-ink bg-paper-tint px-4 py-3.5">
      <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">Dividend</div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-3">
        <DivStat label="Next ex-date" value={fmtDate(data.exDate)} />
        <DivStat label={data.fiscalRef ? `DPS ${data.fiscalRef}` : "DPS"} value={fmtDps(data.dps, data.currency)} />
        <DivStat label="Yield" value={fmtPct1(data.yieldPct)} />
        <DivStat label="Payout" value={fmtPct1(data.payoutPct)} />
      </div>
    </div>
  );
}

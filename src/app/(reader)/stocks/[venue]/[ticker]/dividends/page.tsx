import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getDividendsForSecurity, type DividendItem } from "@/lib/data/stock-events";
import { SectionBar, StatStrip, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/reader/format";

/**
 * Dividends tab — dividend history for this security (public.dividends).
 * `state = 'live'` is enforced by RLS (anon reads never see `pending_confirm`
 * or `cancelled` rows), so this table renders whatever has cleared the 33b
 * human-confirm gate. Today that is ZERO rows for every security (1147 rows
 * exist, all `pending_confirm`) — the page is built to full depth and lights
 * up the moment any dividend goes live; see `src/lib/data/stock-events.ts`.
 */

type Params = { venue: string; ticker: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) return { title: "Not found" };
  return { title: `Dividends · ${sec.name}` };
}

const TYPE_STYLE: Record<string, string> = {
  SPECIAL: "bg-ink text-paper-tint px-2 py-[3px] font-semibold",
  FINAL: "border border-hairline-strong text-ink-muted px-[7px] py-[2px]",
  INTERIM: "border border-hairline-strong text-ink-muted px-[7px] py-[2px]",
};

function DivTypeChip({ type }: { type: string }) {
  const cls = TYPE_STYLE[type] ?? "border border-hairline-strong text-ink-muted px-[7px] py-[2px]";
  return (
    <span className={`inline-block flex-none font-mono text-[8px] tracking-[0.08em] uppercase ${cls}`}>
      {type}
    </span>
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

const ROW_GRID =
  "grid grid-cols-[74px_88px_72px_72px_72px_96px_66px_60px] items-center gap-[10px] px-3 py-[9px]";

function DividendRow({ d }: { d: DividendItem }) {
  const overPayout = d.payoutRatio != null && d.payoutRatio > 1;
  return (
    <div className={`${ROW_GRID} border-b border-hairline-faint font-ui text-ink hover:bg-paper-tint`}>
      <DivTypeChip type={d.divType} />
      <span className="truncate font-mono text-[10.5px] text-ink-muted">{d.fiscalRef ?? "—"}</span>
      <span className="font-mono text-[10.5px] text-ink-muted">{fmtDate(d.exDate)}</span>
      <span className="font-mono text-[10.5px] text-ink-muted">{fmtDate(d.recordDate)}</span>
      <span className="font-mono text-[10.5px] text-ink-muted">{fmtDate(d.payDate)}</span>
      <span className="text-right font-mono text-[11px] font-semibold tabular-nums">
        {fmtDps(d.dps, d.currency)}
      </span>
      <span className="text-right font-mono text-[11px] font-semibold tabular-nums">
        {d.yieldAtAnnounce == null ? "—" : fmtPct1(d.yieldAtAnnounce * 100)}
      </span>
      <span
        className={`text-right font-mono text-[10px] tabular-nums ${
          overPayout ? "font-semibold text-negative" : "text-ink-faint"
        }`}
        title={overPayout ? "Payout ratio exceeds 100% of earnings — distribution cut risk" : undefined}
      >
        {d.payoutRatio == null ? "—" : `${fmtPct1(d.payoutRatio * 100)}${overPayout ? " ⚠" : ""}`}
      </span>
    </div>
  );
}

export default async function DividendsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const dividends = await getDividendsForSecurity(sec.id, 80);

  const specials = dividends.filter((d) => d.divType === "SPECIAL").length;
  const latest = dividends[0] ?? null;
  const flaggedPayout = dividends.filter((d) => d.payoutRatio != null && d.payoutRatio > 1).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-heading-sm font-semibold text-ink">Dividends</h2>
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          {sec.ticker} · {sec.venueCode}
        </span>
      </div>

      {dividends.length > 0 ? (
        <>
          <StatStrip
            items={[
              { label: "Confirmed dividends", value: dividends.length.toLocaleString("en-US") },
              { label: "Latest DPS", value: latest ? fmtDps(latest.dps, latest.currency) : "—" },
              {
                label: "Latest yield",
                value: latest?.yieldAtAnnounce != null ? fmtPct1(latest.yieldAtAnnounce * 100) : "—",
              },
              { label: "Specials", value: specials.toLocaleString("en-US") },
            ]}
          />

          {flaggedPayout > 0 ? (
            <p className="font-mono text-[9px] leading-[1.6] text-ink-faint">
              {flaggedPayout} payout{flaggedPayout > 1 ? "s" : ""} above 100% of earnings, flagged{" "}
              <span className="font-semibold text-negative">⚠</span> — distribution exceeds income for the period.
            </p>
          ) : null}

          <div>
            <SectionBar
              label="Dividend history"
              right={<span>OWN BEFORE EX-DATE TO RECEIVE · DPS IN LOCAL CCY</span>}
            />
            <div
              className={`${ROW_GRID} border-b border-hairline bg-paper-tint font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase`}
            >
              <span>Type</span>
              <span>Fiscal</span>
              <span>Ex-date</span>
              <span>Record</span>
              <span>Pay date</span>
              <span className="text-right">DPS</span>
              <span className="text-right">Yield</span>
              <span className="text-right">Payout</span>
            </div>
            {dividends.map((d) => (
              <DividendRow key={d.id} d={d} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          variant="awaitingFeed"
          title="No confirmed dividends yet for this security"
          body="Dividend records are held for human confirmation before publication. Once a disclosure clears review, it appears here with its ex-date, pay date, and yield."
        />
      )}

      <p className="mt-1 font-mono text-[9px] leading-[1.6] text-ink-faint">
        Ex-date, record-date, and pay-date data is sourced from venue disclosures and registrar
        filings. DPS and yield are in the security&apos;s trading currency.
      </p>
    </div>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getEarningsForSecurity, type EarningsEventItem } from "@/lib/data/stock-events";
import { SectionBar, StatStrip, EmptyState } from "@/components/ui";
import { fmtDate, fmtSignedPct, fmtCompact } from "@/lib/reader/format";

/**
 * Earnings tab — earnings-event history for this security (public.earnings_events,
 * 4190 rows, world-readable). `eps_actual` (91%) / `eps_prior` (47%) / `revenue_actual`
 * (96%) are populated from the income-statement projection; `eps_consensus`,
 * `eps_marsad`, `verdict`, `surprise_pct`, `next_session_reaction_pct`, `desk_take`,
 * and `session` are 100% NULL today (no desk/consensus producer yet) — every
 * column degrades to "—" rather than hiding, so the table lights up in place
 * once that producer lands.
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
  return { title: `Earnings · ${sec.name}` };
}

function fmtEps(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function yoyPct(actual: number | null, prior: number | null): number | null {
  if (actual == null || prior == null || prior === 0) return null;
  return ((actual - prior) / Math.abs(prior)) * 100;
}

const VERDICT_STYLE: Record<string, string> = {
  BEAT: "bg-positive-fill text-paper-tint px-[7px] py-[2px] font-semibold",
  MISS: "bg-negative text-paper-tint px-[7px] py-[2px] font-semibold",
  IN_LINE: "border border-hairline-strong text-ink-muted px-[6px] py-[2px]",
  HELD: "border border-hairline-strong text-ink-muted px-[6px] py-[2px]",
};

function VerdictChip({ verdict }: { verdict: string | null }) {
  if (!verdict) return <span className="font-mono text-[10px] text-ink-faint">—</span>;
  const cls = VERDICT_STYLE[verdict] ?? "border border-hairline-strong text-ink-muted px-[6px] py-[2px]";
  return (
    <span className={`inline-block flex-none font-mono text-[8px] tracking-[0.06em] uppercase ${cls}`}>
      {verdict.replace("_", " ")}
    </span>
  );
}

function SessionChip({ session }: { session: string | null }) {
  if (!session) return <span className="font-mono text-[9px] text-ink-faint">—</span>;
  const post = session === "post";
  return (
    <span
      className={`inline-block flex-none font-mono text-[8px] font-semibold uppercase ${
        post
          ? "bg-ink px-[6px] py-[2px] text-paper-tint"
          : "border border-hairline-strong px-[6px] py-[2px] text-ink-muted"
      }`}
    >
      {session}
    </span>
  );
}

const ROW_GRID =
  "grid min-w-[940px] grid-cols-[78px_76px_46px_64px_64px_58px_64px_54px_88px_66px_74px] items-center gap-[8px] px-3 py-[9px]";

function EarningsRow({ e }: { e: EarningsEventItem }) {
  const delta = yoyPct(e.epsActual, e.epsPrior);
  return (
    <div className={`${ROW_GRID} border-b border-hairline-faint font-ui text-ink hover:bg-paper-tint`}>
      <span className="truncate font-mono text-[10.5px] font-semibold">{e.fiscalPeriod}</span>
      <span className="font-mono text-[10.5px] text-ink-muted">{fmtDate(e.reportDate)}</span>
      <SessionChip session={e.session} />
      <span className="text-right font-mono text-[11px] font-semibold tabular-nums">{fmtEps(e.epsActual)}</span>
      <span className="text-right font-mono text-[11px] text-ink-muted tabular-nums">{fmtEps(e.epsPrior)}</span>
      <span
        className={`text-right font-mono text-[10px] font-semibold tabular-nums ${
          delta == null ? "text-ink-faint" : delta >= 0 ? "text-positive" : "text-negative"
        }`}
      >
        {fmtSignedPct(delta)}
      </span>
      <span className="text-right font-mono text-[11px] text-ink-muted tabular-nums">{fmtEps(e.epsConsensus)}</span>
      <span className="text-right font-mono text-[10px] text-ink-faint tabular-nums">
        {fmtSignedPct(e.surprisePct)}
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums">{fmtCompact(e.revenueActual)}</span>
      <span
        className={`text-right font-mono text-[10px] font-semibold tabular-nums ${
          e.nextSessionReactionPct == null
            ? "text-ink-faint"
            : e.nextSessionReactionPct >= 0
              ? "text-positive"
              : "text-negative"
        }`}
      >
        {fmtSignedPct(e.nextSessionReactionPct)}
      </span>
      <span className="flex justify-end">
        <VerdictChip verdict={e.verdict} />
      </span>
    </div>
  );
}

export default async function EarningsPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const earnings = await getEarningsForSecurity(sec.id, 80);
  const latest = earnings[0] ?? null;
  const confirmedCount = earnings.filter((e) => e.dateState === "confirmed").length;
  const deskTakeEvent = earnings.find((e) => e.deskTake);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-heading-sm font-semibold text-ink">Earnings</h2>
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          {sec.ticker} · {sec.venueCode}
        </span>
      </div>

      {earnings.length > 0 ? (
        <>
          <StatStrip
            items={[
              { label: "Reports on record", value: earnings.length.toLocaleString("en-US") },
              { label: "Latest period", value: latest?.fiscalPeriod ?? "—" },
              {
                label: "Latest EPS actual",
                value: latest ? fmtEps(latest.epsActual) : "—",
                delta: latest ? fmtSignedPct(yoyPct(latest.epsActual, latest.epsPrior)) : undefined,
                dir:
                  latest && yoyPct(latest.epsActual, latest.epsPrior) != null
                    ? (yoyPct(latest.epsActual, latest.epsPrior)! >= 0 ? "up" : "down")
                    : undefined,
              },
              { label: "Confirmed dates", value: confirmedCount.toLocaleString("en-US") },
            ]}
          />

          {deskTakeEvent ? (
            <div className="border-l-[3px] border-ink bg-paper-tint px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="h-[7px] w-[7px] flex-none rotate-45 bg-ink" />
                <span className="font-mono text-[8.5px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
                  Marsad desk take · {deskTakeEvent.fiscalPeriod}
                </span>
              </div>
              <p className="mt-2 font-display text-[14px] leading-[1.6] text-ink-mid">
                {deskTakeEvent.deskTake}
              </p>
            </div>
          ) : null}

          <div>
            <SectionBar
              label="Earnings history"
              right={<span>CONS. = CONSENSUS · MARSAD = DESK ESTIMATE · EPS IN LOCAL CCY</span>}
            />
            <div className="overflow-x-auto">
              <div
                className={`${ROW_GRID} border-b border-hairline bg-paper-tint font-mono text-[8px] tracking-[0.06em] text-ink-faint uppercase`}
              >
                <span>Fiscal</span>
                <span>Report</span>
                <span>Sess.</span>
                <span className="text-right">Actual</span>
                <span className="text-right">Prior</span>
                <span className="text-right">Δ y/y</span>
                <span className="text-right">Cons.</span>
                <span className="text-right">Surprise</span>
                <span className="text-right">Revenue</span>
                <span className="text-right">Reaction</span>
                <span className="text-right">Verdict</span>
              </div>
              {earnings.map((e) => (
                <EarningsRow key={e.id} e={e} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          variant="awaitingFeed"
          title="No earnings events recorded for this security"
          body="Quarterly and annual results appear here as they're reported, with EPS, revenue, and the consensus surprise once desk coverage begins."
        />
      )}

      <p className="mt-1 font-mono text-[9px] leading-[1.6] text-ink-faint">
        Actuals and prior-year comparatives are projected from filed financial statements.
        Consensus, Marsad estimates, and the desk take are supplied once analyst coverage is live.
      </p>
    </div>
  );
}

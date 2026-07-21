import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { DeskTopBar } from "@/components/admin/DeskTopBar";
import { DataGapNotice } from "@/components/admin/DataGapNotice";
import { SectionBar, EmptyState, FreshnessBadge } from "@/components/ui";
import { toBadgeState } from "@/lib/market/freshness";
import {
  getFeedHealth,
  getMarketHalts,
  getMarketSessions,
  getUpcomingHolidays,
  ago,
  type FeedHealthRow,
  type MarketHaltRow,
  type MarketSessionRow,
  type MarketHolidayRow,
} from "@/lib/data/desk";

export const metadata: Metadata = { title: "Market data ops" };

// Live operator screen — see admin/page.tsx for the shell/Suspense pattern
// this mirrors.

export default function MarketDataOpsPage() {
  return (
    <>
      <DeskTopBar crumbs={["DESK", "DATA DESK", "FEEDS & MARKETS"]} />
      <Suspense fallback={<OpsSkeleton />}>
        <OpsBody />
      </Suspense>
    </>
  );
}

function OpsSkeleton() {
  return (
    <main className="flex-1 px-[26px] py-5">
      <p className="font-mono text-[13px] text-ink-faint">Loading market data ops…</p>
    </main>
  );
}

function fmtLocal(t: string): string {
  // Postgres `time` comes back as "HH:MM:SS" — trim to "HH:MM".
  return t.slice(0, 5);
}

async function OpsBody() {
  await connection();
  const today = new Date().toISOString().slice(0, 10);

  const [feedRes, haltsRes, sessionsRes, holidaysRes] = await Promise.allSettled([
    getFeedHealth(),
    getMarketHalts(),
    getMarketSessions(),
    getUpcomingHolidays(today, 12),
  ]);

  const feed: FeedHealthRow[] = feedRes.status === "fulfilled" ? feedRes.value : [];
  const halts: MarketHaltRow[] = haltsRes.status === "fulfilled" ? haltsRes.value : [];
  const sessions: MarketSessionRow[] = sessionsRes.status === "fulfilled" ? sessionsRes.value : [];
  const holidays: MarketHolidayRow[] = holidaysRes.status === "fulfilled" ? holidaysRes.value : [];

  const nextHolidayFor = (venueCode: string) => holidays.find((h) => h.venueCode === venueCode) ?? null;

  return (
    <main className="flex-1 px-[26px] py-5">
      <header className="flex items-baseline gap-3.5 border-b-2 border-ink pb-3">
        <h1 className="font-display text-[26px] font-bold text-ink">Market data ops</h1>
        <span className="font-ui text-[12px] text-ink-muted">
          Data agents keep it current — this desk supervises and overrides
        </span>
      </header>

      <SectionBar label="Venue feeds" right={<span>{feed.length} venues</span>} className="mt-4" />
      <div className="grid grid-cols-2 gap-[10px] border-b border-hairline pb-4 pt-3 sm:grid-cols-3 lg:grid-cols-6">
        {feed.map((f) => {
          const issue = !["live", "closed", "auction"].includes(f.state);
          return (
            <div
              key={f.venueCode}
              className={`border px-[13px] py-[11px] ${issue ? "border-negative bg-paper-tint" : "border-hairline"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] font-bold text-ink">{f.venueCode}</span>
                <span className={`font-mono text-[8px] ${issue ? "text-negative" : "text-ink-faint"}`}>
                  {f.latencyMs != null ? `${f.latencyMs}MS` : f.state.toUpperCase()}
                </span>
              </div>
              <div className="mt-[7px]">
                <FreshnessBadge state={toBadgeState(f.state)} detail={f.detail ?? undefined} />
              </div>
              <div className={`mt-[7px] font-mono text-[7.5px] ${issue ? "text-negative" : "text-ink-faint"}`}>
                {issue ? `SINCE ${ago(f.updatedAt).toUpperCase()} · RETRY ${f.retryCount}` : `SYNCED ${ago(f.lastSyncAt).toUpperCase()}`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-7 xl:grid-cols-[1fr_300px]">
        <div>
          <SectionBar
            label="Halts desk"
            right={<span>auto-detected by data agents · annotated by desk</span>}
          />
          {halts.length === 0 ? (
            <EmptyState variant="awaitingFeed" title="No open halts." body="public.security_status is empty." />
          ) : (
            <ul>
              {halts.map((h) => (
                <li
                  key={h.securityId}
                  className="flex items-center gap-[10px] border-b border-hairline-faint px-3 py-[9px]"
                >
                  <span className="w-14 flex-none font-mono text-[10px] font-semibold text-ink">
                    {h.ticker ?? h.securityId}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-ink">
                    {h.nameEn ?? "—"} <span className="text-ink-faint">· {h.venueCode ?? "—"}</span>
                  </span>
                  <span className="flex-none">
                    <FreshnessBadge state={h.state === "halted" ? "halted" : "auction"} detail={h.reason ?? undefined} />
                  </span>
                  <span className="flex-none font-mono text-[9px] text-ink-faint">{ago(h.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <SectionBar label="Incident banner · live on reader surfaces" className="mt-5" />
          <DataGapNotice
            className="mt-0"
            note="The composer and the currently-live banner list both read the incident_banners table."
            tables={["ops.incident_banners"]}
          />

          <SectionBar label="Market hours & holidays" right={<span>feeds the nav clock + closed states</span>} className="mt-5" />
          <div className="grid grid-cols-[76px_1fr_1fr_1fr] gap-[10px] border-b border-hairline px-3 pb-[5px] pt-[7px]">
            <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint">VENUE</span>
            <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint">REGULAR SESSION</span>
            <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint">AUCTION OPEN</span>
            <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint">NEXT HOLIDAY</span>
          </div>
          {sessions.length === 0 ? (
            <EmptyState variant="awaitingFeed" title="No market sessions configured." />
          ) : (
            sessions.map((s) => {
              const nh = nextHolidayFor(s.venueCode);
              return (
                <div
                  key={s.venueCode}
                  className="grid grid-cols-[76px_1fr_1fr_1fr] items-center gap-[10px] border-b border-hairline-faint px-3 py-[8px]"
                >
                  <span className="font-mono text-[9.5px] font-semibold text-ink">{s.venueCode}</span>
                  <span className="font-mono text-[9.5px] text-ink-muted">
                    {fmtLocal(s.openLocal)}–{fmtLocal(s.closeLocal)} local
                  </span>
                  <span className="font-mono text-[9.5px] text-ink-muted">
                    {s.auctionOpenLocal ? fmtLocal(s.auctionOpenLocal) : "—"}
                  </span>
                  <span className="font-ui text-[11px] text-ink">
                    {nh ? (
                      <>
                        {nh.name}{" "}
                        <span className="font-mono text-[9px] text-ink-faint">
                          · {nh.holidayDate}
                          {nh.isHijriEstimated ? " (est.)" : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-faint">none in range</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div>
          <div className="border border-ink bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">SUPERVISION MODEL</div>
            <p className="mt-[7px] font-ui text-[11.5px] leading-relaxed text-ink-mid">
              Agents detect, annotate and pre-load; the desk confirms and overrides. Every override
              is meant to be audit-logged with the agent value it replaced — that log read is one of
              the flagged gaps below.
            </p>
          </div>

          <div className="mt-4">
            <div className="border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold uppercase tracking-[0.18em] text-ink">
              Data ops · 30 days
            </div>
            <div className="flex justify-between border-b border-hairline-faint py-2">
              <span className="font-ui text-[11.5px] text-ink-muted">Halts open now</span>
              <span className="font-mono text-[10px] font-semibold text-ink">{halts.length}</span>
            </div>
            <DataGapNotice
              className="mt-3"
              note="Incident history and manual-override counts."
              tables={["ops.incidents", "ops.audit_log"]}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

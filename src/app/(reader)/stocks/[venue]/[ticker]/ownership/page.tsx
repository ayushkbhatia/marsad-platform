import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveSecurity } from "@/lib/securities/resolve";
import {
  getOwnershipForSecurity,
  type CompanyPerson,
  type HolderPosition,
  type OwnershipSnapshot,
} from "@/lib/data/stock-events";
import { EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/reader/format";

/**
 * Ownership & people tab (design 3d) — shareholding-pattern matrix, top holders,
 * board of directors, and key management. `holders`, `holder_positions`,
 * `ownership_snapshots`, and `company_people` are all 0 rows today (producer
 * pending — venue-profile scrape, 07-lake-enrichment.md §1.1 I) — every block
 * below renders its own `EmptyState awaitingFeed` independently so the page
 * lights up section-by-section as each producer lands, rather than an
 * all-or-nothing gate.
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
  return { title: `Ownership · ${sec.name}` };
}

function fmtStake(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function fmtPP(n: number | null): { text: string; dir: "up" | "down" | "flat" } {
  if (n == null || !Number.isFinite(n) || n === 0) return { text: n === 0 ? "flat" : "—", dir: "flat" };
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? { text: `+${s}pp`, dir: "up" } : { text: `−${s}pp`, dir: "down" };
}

function categoryLabel(key: string): string {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Shareholding-pattern matrix ─────────────────────────────────────────────

function ShareholdingPattern({ snapshots }: { snapshots: OwnershipSnapshot[] }) {
  const latest = snapshots[snapshots.length - 1] ?? null;

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Shareholding pattern</h3>
        {latest?.isFolRecord && latest.foreignOwnershipPct != null ? (
          <span className="bg-positive px-1.5 py-[2px] font-mono text-[8px] font-semibold tracking-[0.08em] text-paper-tint uppercase">
            Foreign ownership at record {fmtStake(latest.foreignOwnershipPct)}
          </span>
        ) : null}
      </div>

      {snapshots.length === 0 ? (
        <EmptyState
          className="mt-3"
          variant="awaitingFeed"
          title="No ownership snapshots yet"
          body="Category-level shareholding (government, foreign, institutional, retail) appears here once the ownership-disclosure feed lands."
        />
      ) : (
        <div className="mt-2 overflow-x-auto">
          {(() => {
            const keys: string[] = [];
            for (const s of snapshots) {
              for (const k of Object.keys(s.categories)) {
                if (!keys.includes(k)) keys.push(k);
              }
            }
            const cols = `200px repeat(${snapshots.length}, minmax(64px,1fr))`;
            return (
              <div className="min-w-[520px]">
                <div className="grid border-b border-hairline-soft" style={{ gridTemplateColumns: cols }}>
                  <span />
                  {snapshots.map((s) => (
                    <span
                      key={s.asOf}
                      className="px-1.5 py-2 text-right font-mono text-[9px] text-ink-muted"
                    >
                      {fmtDate(s.asOf)}
                    </span>
                  ))}
                </div>
                {keys.map((k) => (
                  <div
                    key={k}
                    className="grid border-b border-hairline-faint hover:bg-paper-tint"
                    style={{ gridTemplateColumns: cols }}
                  >
                    <span className="px-2.5 py-2 font-ui text-[12px] font-semibold text-ink-mid">
                      {categoryLabel(k)}
                    </span>
                    {snapshots.map((s) => (
                      <span
                        key={s.asOf}
                        className="px-1.5 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted"
                      >
                        {s.categories[k] != null ? fmtStake(s.categories[k]) : "—"}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
}

// ── Top holders ──────────────────────────────────────────────────────────

function TopHolders({ holders }: { holders: HolderPosition[] }) {
  return (
    <div>
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
        <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
          Top holders
        </span>
        {holders[0] ? (
          <span className="font-mono text-[9px] text-ink-faint">AS OF {fmtDate(holders[0].asOf)}</span>
        ) : null}
      </div>

      {holders.length === 0 ? (
        <EmptyState
          className="mt-3"
          variant="awaitingFeed"
          title="No disclosed holders yet"
          body="Major shareholders and their stake changes appear here once registrar/disclosure positions are ingested."
        />
      ) : (
        <ul className="divide-y divide-hairline-faint">
          {holders.map((h) => {
            const chg = fmtPP(h.qoqChangePp);
            return (
              <li
                key={h.holderId}
                className="grid grid-cols-[1fr_120px_66px_74px] items-baseline gap-[10px] py-[9px]"
              >
                <span className="truncate font-ui text-[12.5px] font-semibold text-ink underline decoration-hairline underline-offset-[3px]">
                  {h.name}
                </span>
                <span className="truncate font-mono text-[10px] text-ink-faint uppercase">
                  {h.holderType.replace("_", " ")}
                </span>
                <span className="text-right font-mono text-[12px] font-semibold tabular-nums text-ink">
                  {fmtStake(h.stakePct)}
                </span>
                <span
                  className={`text-right font-mono text-[10.5px] font-semibold tabular-nums ${
                    chg.dir === "up" ? "text-positive" : chg.dir === "down" ? "text-negative" : "text-ink-faint"
                  }`}
                >
                  {chg.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Board & management ──────────────────────────────────────────────────

function BoardAndManagement({ board, management }: { board: CompanyPerson[]; management: CompanyPerson[] }) {
  const independentCount = board.filter((p) => p.isIndependent).length;

  return (
    <div>
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
        <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
          Board of directors
        </span>
        {board.length > 0 ? (
          <span className="font-mono text-[9px] text-ink-faint">
            {board.length} SEATS · {independentCount} INDEPENDENT
          </span>
        ) : null}
      </div>

      {board.length === 0 ? (
        <EmptyState
          className="mt-3"
          variant="awaitingFeed"
          title="No board directory yet"
          body="Directors, independence status, and tenure appear here once the governance-disclosure feed lands."
        />
      ) : (
        <ul className="divide-y divide-hairline-faint">
          {board.map((p) => (
            <li key={p.id} className="grid grid-cols-[1fr_150px_60px] items-baseline gap-[10px] py-[8px]">
              <span className="truncate font-ui text-[12.5px] font-semibold text-ink">{p.name}</span>
              <span className="truncate font-ui text-[10.5px] text-ink-muted">
                {p.title ?? (p.isIndependent ? "Independent director" : "Director")}
              </span>
              <span className="text-right font-mono text-[9.5px] text-ink-faint">{fmtDate(p.asOf)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 border-b-2 border-ink pb-2">
        <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
          Key management
        </span>
      </div>

      {management.length === 0 ? (
        <EmptyState
          className="mt-3"
          variant="awaitingFeed"
          title="No management directory yet"
          body="Executive leadership appears here once the governance-disclosure feed lands."
        />
      ) : (
        <ul className="divide-y divide-hairline-faint">
          {management.map((p) => (
            <li key={p.id} className="py-[9px]">
              <div className="flex flex-wrap items-baseline gap-[10px]">
                <span className="font-ui text-[13px] font-bold text-ink">{p.name}</span>
                <span className="font-mono text-[10.5px] text-ink-faint uppercase">{p.title ?? "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function OwnershipPage({ params }: { params: Promise<Params> }) {
  const { venue, ticker } = await params;
  const sec = await resolveSecurity(venue, ticker);
  if (!sec) notFound();

  const bundle = await getOwnershipForSecurity(sec.id);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-heading-sm font-semibold text-ink">Ownership &amp; people</h2>
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-faint">
          {sec.ticker} · {sec.venueCode}
        </span>
      </div>

      <ShareholdingPattern snapshots={bundle.snapshots} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <TopHolders holders={bundle.holders} />
        <BoardAndManagement board={bundle.board} management={bundle.management} />
      </div>

      <p className="font-mono text-[9px] leading-[1.6] text-ink-faint">
        Ownership positions, shareholding categories, and the board/management directory are
        sourced from venue profile pages and periodic disclosures — free float, ISIN, and sector
        already flow through the same pipeline for other tabs.
      </p>
    </div>
  );
}

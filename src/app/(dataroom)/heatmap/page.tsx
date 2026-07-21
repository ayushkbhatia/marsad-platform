import type { Metadata } from "next";
import Link from "next/link";
import { getSectorHeatmap } from "@/lib/data/markets";
import { getHeatmapConstituents, getSectorBreadthForVenue } from "@/lib/data/dataroom";
import { SectorTreemap, SectorFocusPanel } from "@/components/reader/dataroom/SectorTreemap";
import { StatStrip, EmptyState } from "@/components/ui";
import { fmtSignedPct, venueName } from "@/lib/reader/format";

/**
 * Sector heatmap (1e dark terminal / 2a `?edition=paper` light). Per-sector
 * breadth (`getSectorHeatmap` / the venue-scoped derivative) nested with every
 * constituent's live-ish delayed tile (`getHeatmapConstituents`), drilling into
 * one sector via `?sector=`. Surface flips per request from the `edition`
 * searchParam — a deliberate, documented exception to "dataroom is always
 * dark" for this one page (04-reader-app / CONVENTIONS §4), not a theme
 * toggle: it is resolved server-side, same as every other searchParam here.
 * `noindex` — data rooms are never in the sitemap.
 */

export const metadata: Metadata = {
  title: "Sector Heatmap",
  description:
    "GCC sector breadth — advancers, decliners and today's move by sector, drilling down to every constituent.",
  robots: { index: false, follow: false },
};

const VENUES = ["TDWL", "DFM", "ADX", "QE", "MSX", "BHB", "BK"] as const;
type VenueCode = (typeof VENUES)[number];

const PERIODS = ["1d", "1w", "1m", "ytd"] as const;

type Search = { edition?: string; venue?: string; period?: string; sector?: string };
type HeatmapState = { paper: boolean; venue: VenueCode | null; period: string; sector: string | null };

function heatmapHref(s: HeatmapState): string {
  const p = new URLSearchParams();
  if (s.paper) p.set("edition", "paper");
  if (s.venue) p.set("venue", s.venue);
  if (s.period && s.period !== "1d") p.set("period", s.period);
  if (s.sector) p.set("sector", s.sector);
  const qs = p.toString();
  return qs ? `/heatmap?${qs}` : "/heatmap";
}

function tabClass(active: boolean, dark: boolean): string {
  if (active) return dark ? "bg-dark-text text-dark-bg" : "bg-ink text-paper-tint";
  return dark
    ? "text-dark-text-mid hover:text-dark-text"
    : "text-ink-muted hover:text-ink";
}

export default async function HeatmapPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const paper = sp.edition === "paper";
  const surface = paper ? "light" : "dark";
  const dark = !paper;

  const venueRaw = sp.venue?.toUpperCase();
  const venue: VenueCode | null = venueRaw && (VENUES as readonly string[]).includes(venueRaw) ? (venueRaw as VenueCode) : null;
  const period = PERIODS.includes((sp.period ?? "1d").toLowerCase() as (typeof PERIODS)[number])
    ? (sp.period ?? "1d").toLowerCase()
    : "1d";
  const sectorKey = sp.sector || null;

  const state: HeatmapState = { paper, venue, period, sector: sectorKey };

  const cells = venue ? await getSectorBreadthForVenue(venue) : await getSectorHeatmap();
  const withData = cells.filter((c) => c.count > 0);

  const totals = withData.reduce(
    (acc, c) => ({
      count: acc.count + c.count,
      adv: acc.adv + c.advancers,
      dec: acc.dec + c.decliners,
      unch: acc.unch + c.unchanged,
    }),
    { count: 0, adv: 0, dec: 0, unch: 0 },
  );

  const shell = dark ? "bg-dark-bg text-dark-text" : "bg-paper text-ink";
  const tabShell = dark ? "border-dark-hairline-strong" : "border-hairline-strong";

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3 border-b pb-4" style={{ borderColor: dark ? "var(--color-dark-hairline)" : "var(--color-hairline)" }}>
      <div>
        <h1 className={`font-display text-heading font-bold ${dark ? "text-dark-text" : "text-ink"}`}>
          Sector Heatmap
        </h1>
        <p className={`mt-1 font-ui text-[12.5px] ${dark ? "text-dark-text-mid" : "text-ink-muted"}`}>
          Breadth by sector, delayed data. Tap a sector to drill into its constituents, tap any tile for the stock page.
        </p>
      </div>
      <div className="ml-auto flex flex-col items-end gap-2">
        <div className={`flex border ${tabShell}`}>
          <Link href={heatmapHref({ ...state, sector: null })} className={`px-3 py-1.5 font-mono text-[10.5px] font-semibold ${tabClass(!dark, dark)}`}>
            TERMINAL
          </Link>
          <Link href={heatmapHref({ ...state, paper: true, sector: null })} className={`px-3 py-1.5 font-mono text-[10.5px] font-semibold ${tabClass(paper, dark)}`}>
            PAPER
          </Link>
        </div>
        <div className={`flex flex-wrap border ${tabShell}`}>
          <Link href={heatmapHref({ ...state, venue: null })} className={`px-2.5 py-1 font-mono text-[10px] font-semibold ${tabClass(!venue, dark)}`}>
            ALL GCC
          </Link>
          {VENUES.map((v) => (
            <Link key={v} href={heatmapHref({ ...state, venue: v })} className={`px-2.5 py-1 font-mono text-[10px] font-semibold ${tabClass(venue === v, dark)}`}>
              {v}
            </Link>
          ))}
        </div>
        <div className={`flex border ${tabShell}`}>
          <Link href={heatmapHref({ ...state, period: "1d" })} className={`px-2.5 py-1 font-mono text-[10px] font-semibold ${tabClass(period === "1d", dark)}`}>
            1D
          </Link>
          {["1w", "1m", "ytd"].map((p) => (
            <span
              key={p}
              title="Needs historical sector aggregation — not yet built"
              className={`cursor-not-allowed px-2.5 py-1 font-mono text-[10px] ${dark ? "text-dark-text-faint/60" : "text-ink-faint/60"}`}
            >
              {p.toUpperCase()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  if (withData.length === 0) {
    return (
      <div className={`min-h-[60vh] ${shell}`}>
        <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
          {toolbar}
          <div className="mt-6">
            <EmptyState
              surface={surface}
              variant="awaitingFeed"
              title="No sector breadth yet"
              body={venue ? `No quoted names on ${venueName(venue)} right now.` : "No quoted names across the public universe right now."}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Focused single-sector drilldown (?sector=) ──────────────────────────
  if (sectorKey) {
    const cell = withData.find((c) => c.key === sectorKey);
    const constituents = await getHeatmapConstituents(sectorKey, venue);

    return (
      <div className={`min-h-[60vh] ${shell}`}>
        <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
          {toolbar}
          <div className="mt-5 flex items-center gap-3">
            <Link
              href={heatmapHref({ ...state, sector: null })}
              className={`font-mono text-[10.5px] tracking-[0.06em] no-underline hover:underline underline-offset-2 ${dark ? "text-dark-text-mid" : "text-ink-muted"}`}
            >
              ← All sectors
            </Link>
            <span className={`font-display text-[22px] font-bold ${dark ? "text-dark-text" : "text-ink"}`}>
              {cell?.name ?? sectorKey}
            </span>
          </div>

          {cell && (
            <div className="mt-4">
              <StatStrip
                surface={surface}
                items={[
                  { label: "Names", value: String(cell.count) },
                  { label: "Advancers", value: String(cell.advancers), dir: "up" },
                  { label: "Decliners", value: String(cell.decliners), dir: "down" },
                  { label: "Unchanged", value: String(cell.unchanged) },
                  {
                    label: "Avg change",
                    value: cell.avgChangePct != null ? fmtSignedPct(cell.avgChangePct) : "—",
                    dir: cell.avgChangePct == null ? undefined : cell.avgChangePct > 0 ? "up" : cell.avgChangePct < 0 ? "down" : undefined,
                  },
                ]}
              />
            </div>
          )}

          <div className="mt-5">
            {constituents.length > 0 ? (
              <SectorFocusPanel items={constituents} surface={surface} />
            ) : (
              <EmptyState surface={surface} variant="empty" title="No quoted names in this sector yet." />
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Default: every sector, compact nested tiles ─────────────────────────
  const constituentEntries = await Promise.all(
    withData.map(async (c) => [c.key, await getHeatmapConstituents(c.key, venue)] as const),
  );
  const constituentsByKey = Object.fromEntries(constituentEntries);

  return (
    <div className={`min-h-[60vh] ${shell}`}>
      <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
        {toolbar}

        <div className="mt-4">
          <StatStrip
            surface={surface}
            items={[
              { label: "Names", value: String(totals.count) },
              { label: "Advancers", value: String(totals.adv), dir: "up" },
              { label: "Decliners", value: String(totals.dec), dir: "down" },
              { label: "Unchanged", value: String(totals.unch) },
            ]}
          />
        </div>

        <div className="mt-5">
          <SectorTreemap
            cells={withData}
            constituentsByKey={constituentsByKey}
            surface={surface}
            sectorHref={(key) => heatmapHref({ ...state, sector: key })}
          />
        </div>

        <p className={`mt-5 font-mono text-[9px] leading-[1.6] ${dark ? "text-dark-text-faint" : "text-ink-faint"}`}>
          1D change, −3% → +3%. Tile size reflects the size of today&apos;s move (market cap is not yet
          available for every name). Delayed data, information only.
        </p>
      </div>
    </div>
  );
}

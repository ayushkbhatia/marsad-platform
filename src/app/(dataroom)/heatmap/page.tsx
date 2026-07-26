import type { Metadata } from "next";
import Link from "next/link";
import { getSectorHeatmap } from "@/lib/data/markets";
import { getHeatmapConstituents, getSectorBreadthForVenue } from "@/lib/data/dataroom";
import { SectorTreemap, SectorFocusPanel } from "@/components/reader/dataroom/SectorTreemap";
import {
  DataRoomChrome,
  Segmented,
  Segment,
  ChromeButton,
  ChromeMeta,
} from "@/components/reader/dataroom/DataRoomChrome";
import { StatStrip, EmptyState } from "@/components/ui";
import { fmtSignedPct, venueName } from "@/lib/reader/format";

/**
 * Sector heatmap — design 1e (dark data room) / 2a `?edition=paper` (light).
 *
 * DESIGN PASS (1e): the page now wears the data-room chrome — a 54px bar
 * carrying the mode chip, the venue + period segmented controls and the
 * SIZE/EXPORT slot — over a full-bleed treemap, closed by the 7-stop change
 * ramp legend and a breadth line. `MarsadNav` is gone from this surface by
 * design (mode switch, not page nav — see `(dataroom)/layout.tsx`).
 *
 * DATA IS UNCHANGED AND REAL: per-sector breadth (`getSectorHeatmap` / the
 * venue-scoped derivative) nested with every constituent's delayed tile
 * (`getHeatmapConstituents`), drilling into one sector via `?sector=`. Surface
 * flips per request from the `edition` searchParam — a deliberate, documented
 * exception to "dataroom is always dark" for this one page (04-reader-app /
 * CONVENTIONS §4), resolved server-side. `noindex` — data rooms are never in
 * the sitemap.
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

/** The design's 7-stop 1D-change ramp (−3% → +3%). */
const RAMP = [
  "var(--color-heatmap-1)",
  "var(--color-heatmap-2)",
  "var(--color-heatmap-3)",
  "var(--color-heatmap-4)",
  "var(--color-heatmap-5)",
  "var(--color-heatmap-6)",
  "var(--color-heatmap-9)",
];

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

function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export default async function HeatmapPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const paper = sp.edition === "paper";
  const surface = paper ? "light" : "dark";
  const dark = !paper;

  const venueRaw = sp.venue?.toUpperCase();
  const venue: VenueCode | null =
    venueRaw && (VENUES as readonly string[]).includes(venueRaw) ? (venueRaw as VenueCode) : null;
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
  const medianSectorMove = median(
    withData.map((c) => c.avgChangePct).filter((n): n is number => n != null),
  );

  // ── Chrome (dark) / light toolbar (paper edition) ───────────────────────
  const chrome = dark ? (
    <DataRoomChrome
      mode="HEATMAP"
      controls={
        <>
          <Segmented>
            <Segment href={heatmapHref({ ...state, venue: null, sector: null })} active={!venue}>
              ALL GCC
            </Segment>
            {VENUES.map((v) => (
              <Segment
                key={v}
                href={heatmapHref({ ...state, venue: v, sector: null })}
                active={venue === v}
              >
                {v}
              </Segment>
            ))}
          </Segmented>
          <Segmented>
            <Segment href={heatmapHref({ ...state, period: "1d" })} active={period === "1d"}>
              1D
            </Segment>
            {["1w", "1m", "ytd"].map((p) => (
              <Segment key={p} disabled title="Needs historical sector aggregation — not yet built">
                {p.toUpperCase()}
              </Segment>
            ))}
          </Segmented>
        </>
      }
      right={
        <>
          <ChromeMeta>SIZE: MOVE MAGNITUDE</ChromeMeta>
          <Segmented>
            <Segment href={heatmapHref({ ...state, paper: false })} active>
              TERMINAL
            </Segment>
            <Segment href={heatmapHref({ ...state, paper: true })}>PAPER</Segment>
          </Segmented>
          <ChromeButton>EXPORT</ChromeButton>
        </>
      }
    />
  ) : (
    <div className="border-b border-hairline bg-paper">
      <div className="flex flex-wrap items-center gap-3 px-6 py-3">
        <span className="font-mono text-[11px] font-semibold tracking-[0.18em] text-ink">
          MARSAD DATA ROOM
        </span>
        <span className="border border-hairline-strong px-1.5 py-[2.5px] font-mono text-[8.5px] tracking-[0.12em] text-ink-muted">
          HEATMAP · PAPER
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex border border-hairline-strong">
            <Link
              href={heatmapHref({ ...state, paper: false })}
              className="px-3 py-1.5 font-ui text-[10.5px] font-semibold text-ink-muted hover:text-ink"
            >
              TERMINAL
            </Link>
            <span className="bg-ink px-3 py-1.5 font-ui text-[10.5px] font-bold text-paper-tint">PAPER</span>
          </div>
          <Link
            href="/"
            className="font-mono text-[10px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
          >
            ← READER
          </Link>
        </div>
      </div>
    </div>
  );

  const shell = dark ? "bg-dark-bg text-dark-text" : "bg-paper text-ink";

  // ── Empty ───────────────────────────────────────────────────────────────
  if (withData.length === 0) {
    return (
      <div className={`min-h-[70vh] ${shell}`}>
        {chrome}
        <div className="px-6 py-8">
          <EmptyState
            surface={surface}
            variant="awaitingFeed"
            title="No sector breadth yet"
            body={
              venue
                ? `No quoted names on ${venueName(venue)} right now.`
                : "No quoted names across the public universe right now."
            }
          />
        </div>
      </div>
    );
  }

  // ── Focused single-sector drilldown (?sector=) ──────────────────────────
  if (sectorKey) {
    const cell = withData.find((c) => c.key === sectorKey);
    const constituents = await getHeatmapConstituents(sectorKey, venue);

    return (
      <div className={`min-h-[70vh] ${shell}`}>
        {chrome}
        <div className="px-6 pt-4 pb-8">
          <div className="flex items-center gap-3">
            <Link
              href={heatmapHref({ ...state, sector: null })}
              className={`font-mono text-[10.5px] tracking-[0.06em] no-underline hover:underline underline-offset-2 ${
                dark ? "text-dark-text-faint" : "text-ink-muted"
              }`}
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
                    dir:
                      cell.avgChangePct == null
                        ? undefined
                        : cell.avgChangePct > 0
                          ? "up"
                          : cell.avgChangePct < 0
                            ? "down"
                            : undefined,
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

  // ── Default: every sector, nested tiles ─────────────────────────────────
  const constituentEntries = await Promise.all(
    withData.map(async (c) => [c.key, await getHeatmapConstituents(c.key, venue)] as const),
  );
  const constituentsByKey = Object.fromEntries(constituentEntries);

  return (
    <div className={`min-h-[70vh] ${shell}`}>
      {chrome}

      <div className="px-6 pt-4">
        <SectorTreemap
          cells={withData}
          constituentsByKey={constituentsByKey}
          surface={surface}
          sectorHref={(key) => heatmapHref({ ...state, sector: key })}
        />
      </div>

      {/* Legend + breadth (design 1e footer). */}
      <div className="flex flex-wrap items-center gap-4 px-6 pt-4 pb-5">
        <span
          className={`font-mono text-[9px] tracking-[0.14em] ${dark ? "text-dark-text-faint" : "text-ink-faint"}`}
        >
          {period.toUpperCase()} CHANGE
        </span>
        <div className="flex items-center gap-[3px]">
          {RAMP.map((c) => (
            <span key={c} className="h-[15px] w-[15px]" style={{ background: c }} />
          ))}
        </div>
        <span className={`font-mono text-[9px] ${dark ? "text-dark-text-faint" : "text-ink-faint"}`}>
          −3% → +3%
        </span>
        <span className={`ml-auto font-mono text-[10px] ${dark ? "text-dark-text-faint" : "text-ink-muted"}`}>
          BREADTH · {totals.adv} ADV <span className="text-positive-dark">▲</span> / {totals.dec} DEC{" "}
          <span className="text-negative-dark">▼</span> / {totals.unch} UNCH
          {medianSectorMove != null ? ` · MEDIAN SECTOR MOVE ${fmtSignedPct(medianSectorMove)}` : ""} · TAP
          ANY TILE FOR THE STOCK PAGE
        </span>
      </div>

      <p
        className={`px-6 pb-6 font-mono text-[9px] leading-[1.6] ${
          dark ? "text-dark-text-faint" : "text-ink-faint"
        }`}
      >
        Tile size reflects the size of today&apos;s move — free-float market cap is not yet available for
        every name. Delayed data, information only.
      </p>
    </div>
  );
}

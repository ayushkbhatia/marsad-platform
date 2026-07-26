import "server-only";
import type { LedgerIndex, LiveMarkets, MoverRow, WireItem, LedgerLead, LedgerStory } from "@/lib/contracts/ledger";
import { getIndexTape, getTopMovers, getMarketState } from "@/lib/data/markets";
import { getIndexDailySeries } from "@/lib/data/index-history";
import { getGlobalFilings } from "@/lib/data/filings";
import { listResearchArticles } from "@/lib/data/editorial";
import { fmtDate } from "@/lib/reader/format";
import { fmtClock, fmtPrice } from "@/lib/reader/format";

/**
 * ADAPTER: real market reads → the market half of the `LedgerData` contract
 * (design 1b, the home page).
 *
 * SCOPE: indices, movers and the Live Markets focus card only. The EDITORIAL
 * half (lead story, secondary stories, analyst calls) is `content_items` /
 * `analyst_calls` and is wired in bridge P3 — it stays sample until there is
 * real content to serve.
 *
 * WHAT IS DELIBERATELY NOT HERE — the macro row (Brent, gold, UST10Y, USDSAR):
 * there is no commodity/rates/FX-quote producer anywhere in the schema. The
 * sample carries plausible-looking prices, and shipping those on a markets
 * product would be the most damaging kind of fabrication — a reader cannot tell
 * a fake Brent print from a real one. The adapter returns an EMPTY macro row and
 * the component omits it. Tracked as **DEF-LEDGER-MACRO-SOURCE**.
 */

/** The focus venue for the Live Markets card — the flagship the design leads with. */
const FOCUS_INDEX = "TASI";
const FOCUS_VENUE = "TDWL";

export function toLedgerIndices(tape: Awaited<ReturnType<typeof getIndexTape>>): LedgerIndex[] {
  return tape
    .filter((t) => t.level != null)
    .map((t) => ({
      code: t.code,
      name: t.name,
      venueCode: t.venueCode,
      level: t.level as number,
      changePct: t.changePct ?? 0,
    }));
}

export function toMoverRows(movers: Awaited<ReturnType<typeof getTopMovers>>["gainers"]): MoverRow[] {
  return movers
    .filter((m) => m.changePct != null)
    .map((m) => ({
      symbol: m.ticker,
      changePct: m.changePct as number,
      // Real link — the sample shipped `href: "#"` on every mover row.
      href: `/stocks/${m.venueCode}/${m.ticker}`,
    }));
}

/** Normalised polyline for the focus-index sparkline, in the design's viewBox. */
function sparkPoints(closes: number[], width: number, height: number): string {
  if (closes.length < 2) return "";
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  return closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * width;
      const y = height - ((c - lo) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * The home page's wire rail off real `public.filings`.
 *
 * The sample shipped six plausible-looking headlines ("Maaden completes
 * phosphate debottlenecking", "Salik July toll volumes +9% y/y") with
 * `href: "#"`. On a markets product that is indistinguishable from real news,
 * which makes it the worst kind of placeholder — so the rail is now real filings
 * with working links to `/filings/[id]`.
 *
 * TDWL machine-ref titles: ~3,436 TDWL rows carry a source ref as their title
 * (DEF-TDWL-FILED-AT's sibling problem). Those get a label derived from
 * `filing_type` instead of an unreadable ref.
 */
const MACHINE_REF = /^[A-Z]{2,6}[-_][A-Z0-9]+[-_]/i;

function wireSummary(f: {
  title: string | null;
  filingType: string | null;
  aiSummary: string | null;
  ticker: string | null;
  name: string | null;
}): string {
  // An AI summary already names the issuer, so use it verbatim.
  const summary = (f.aiSummary ?? "").trim();
  if (summary) return summary;

  const title = (f.title ?? "").trim();
  const issuer = (f.name ?? f.ticker ?? "").trim();
  const body =
    title && !MACHINE_REF.test(title)
      ? title
      : (() => {
          const type = (f.filingType ?? "filing").trim().toLowerCase();
          return type.charAt(0).toUpperCase() + type.slice(1);
        })();

  // Generic filing titles ("Detailed report — 2026-06-30") repeat across every
  // issuer on a venue, so a wire line without the company name is unreadable.
  // Prefix the issuer unless the title already mentions it.
  if (!issuer) return body;
  return body.toLowerCase().includes(issuer.toLowerCase()) ? body : `${issuer} — ${body}`;
}

export function toWireItems(items: Awaited<ReturnType<typeof getGlobalFilings>>["items"]): WireItem[] {
  return items.map((f) => ({
    time: fmtClock(f.filedAt),
    source: (f.venueCode ?? "—").toUpperCase(),
    summary: wireSummary(f),
    href: `/filings/${f.id}`,
  }));
}

/**
 * The home page's EDITORIAL half — lead + secondary stories off real
 * `content_items`.
 *
 * Honest degradation:
 * - `take` (the pull-quote) has no column; the dek carries the summary.
 * - `photoLabel`/`photoCaption` are empty — `content_attachments` is 0 rows, so
 *   there is no image pipeline and a fabricated photo credit is not an option.
 * - `calls` (the analyst-calls row) stays EMPTY: `analyst_calls` is 0 rows and
 *   the owner ruled against seeding fictional analysts making price-target
 *   calls on real securities (DEF-ANALYSTS-LIVE-DATA).
 */
function toLead(a: Awaited<ReturnType<typeof listResearchArticles>>[number]): LedgerLead {
  return {
    kicker: (a.kicker ?? a.section ?? "Research").toUpperCase(),
    headline: a.headline,
    dek: a.dek ?? "",
    take: "",
    byline: "Marsad Desk",
    time: fmtDate(a.publishedAt),
    readLabel: a.readMinutes ? `READ — ${a.readMinutes} MIN` : "READ",
    href: `/articles/${a.slug}`,
    photoLabel: "",
    photoCaption: "",
  };
}

function toStory(a: Awaited<ReturnType<typeof listResearchArticles>>[number]): LedgerStory {
  return {
    kicker: (a.kicker ?? a.section ?? "Research").toUpperCase(),
    time: fmtDate(a.publishedAt),
    headline: a.headline,
    dek: a.dek ?? "",
    href: `/articles/${a.slug}`,
  };
}

export interface LedgerEditorial {
  lead: LedgerLead | null;
  secondary: LedgerStory[];
}

export async function buildLedgerEditorial(): Promise<LedgerEditorial> {
  const articles = await listResearchArticles({ limit: 7 });
  if (articles.length === 0) return { lead: null, secondary: [] };
  const [first, ...rest] = articles;
  return { lead: toLead(first), secondary: rest.map(toStory) };
}

export interface LedgerMarketData {
  indices: LedgerIndex[];
  live: LiveMarkets | null;
  wires: WireItem[];
  gainers: MoverRow[];
  losers: MoverRow[];
}

export async function buildLedgerMarkets(): Promise<LedgerMarketData> {
  const [tape, movers, state, series, filings] = await Promise.all([
    getIndexTape(),
    getTopMovers(6),
    getMarketState(),
    getIndexDailySeries(FOCUS_INDEX, 30),
    getGlobalFilings(undefined, 6),
  ]);

  const focus = tape.find((t) => t.code === FOCUS_INDEX) ?? tape.find((t) => t.level != null) ?? null;
  const venueOpen = state.venues.find((v) => v.venueCode === FOCUS_VENUE)?.isOpen ?? state.anyOpen;

  const SPARK_W = 300;
  const SPARK_H = 64;

  const live: LiveMarkets | null =
    focus && focus.level != null
      ? {
          code: focus.code,
          name: focus.name,
          level: focus.level,
          changePct: focus.changePct ?? 0,
          open: venueOpen,
          dayHigh: focus.dayHigh != null ? fmtPrice(focus.dayHigh, 2) : "—",
          dayLow: focus.dayLow != null ? fmtPrice(focus.dayLow, 2) : "—",
          // `index_levels` carries `value_traded`, but `getIndexTape` does not
          // select it and this adapter does not re-query — shown as "—" rather
          // than guessed.
          volume: "—",
          spark: {
            width: SPARK_W,
            height: SPARK_H,
            points: sparkPoints(series.map((p) => p.close), SPARK_W, SPARK_H),
          },
          // DEF-LEDGER-MACRO-SOURCE — see the file header. Never fabricated.
          macro: [],
        }
      : null;

  return {
    indices: toLedgerIndices(tape),
    live,
    wires: toWireItems(filings.items),
    gainers: toMoverRows(movers.gainers),
    losers: toMoverRows(movers.losers),
  };
}

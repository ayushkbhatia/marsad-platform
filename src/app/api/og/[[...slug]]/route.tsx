import { ImageResponse } from "next/og";
import { resolveSecurity } from "@/lib/securities/resolve";
import { getStockHeader } from "@/lib/data/stocks";
import { getFilingDetail } from "@/lib/data/filings";
import { getEarningsEvent, getIpoOffer } from "@/lib/data/calendars";
import { fmtSignedPct, fmtPrice, venueName } from "@/lib/reader/format";

/**
 * `GET /api/og/[[...slug]]` — 1200×630 social cards via `next/og` (04-reader-app
 * §1/§8). No image storage cost: every card is generated on demand from the
 * SAME cached data-layer reads the pages already use (Pattern A `use cache`
 * fns), then served with a long, immutable Cache-Control so the CDN/social
 * crawlers only ever pay the render cost once per distinct slug.
 *
 * Slug shapes (all optional — bare `/api/og` renders the site default):
 *   /api/og                          → brand default
 *   /api/og/markets|wire|filings|earnings|dividends|ipo  → static per-surface card
 *   /api/og/stock/{venue}/{ticker}   → ticker, name, delayed last/change
 *   /api/og/filing/{id}              → filing headline + AI summary line
 *   /api/og/earnings/{id}            → print headline + EPS y/y
 *   /api/og/ipo/{offerSlug}          → offer headline
 * An unresolved id/slug (unknown ticker, deleted filing, empty ipo_offers
 * tier) falls through to the matching static card, never a broken image.
 *
 * Only public identity/summary fields ever reach this route — no financials,
 * ratios, or factor grades (same rule as `JsonLd`, `src/components/reader/JsonLd.tsx`).
 */

const WIDTH = 1200;
const HEIGHT = 630;

// Ink-and-paper palette, copied literally from `globals.css` `@theme` (satori
// cannot resolve CSS custom properties / Tailwind classes — it only reads
// inline style values). Keep these in sync with globals.css if that palette
// ever changes; this file does not import or modify it.
const INK = "#14120e";
const INK_MUTED = "#57534a";
const INK_FAINT = "#8a857a";
const HAIRLINE = "#dcd8cc";
const PAPER = "#fdfcf9";
const PAPER_TINT = "#f6f4ee";
const POSITIVE = "#0a7a3c";
const NEGATIVE = "#c0342b";

interface CardContent {
  kicker: string;
  title: string;
  sub?: string;
  changePct?: number | null;
}

/** Truncate at the last word boundary before `max` chars, so a long AI
 * summary or filing title never gets sliced mid-word on the card. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const DEFAULT_CARD: CardContent = {
  kicker: "Marsad",
  title: "Gulf markets, read closely.",
  sub: "Delayed prices, disclosures, and the Marsad Score across six GCC venues.",
};

const STATIC_CARDS: Record<string, CardContent> = {
  markets: {
    kicker: "Markets",
    title: "GCC markets, six venues",
    sub: "Index tape, sector breadth and top movers — delayed at least 15 minutes.",
  },
  wire: {
    kicker: "Newswire",
    title: "The filings wire",
    sub: "Every GCC disclosure, as it lands.",
  },
  filings: {
    kicker: "Filings register",
    title: "The GCC filings register",
    sub: "Machine-extracted disclosures across six venues.",
  },
  earnings: {
    kicker: "Earnings calendar",
    title: "The GCC reporting calendar",
    sub: "Confirmed and estimated report dates, actuals vs prior.",
  },
  dividends: {
    kicker: "Dividend calendar",
    title: "Ex-dates, pay dates and yields",
    sub: "Across six GCC venues — delayed, confirmed-only.",
  },
  ipo: {
    kicker: "IPO Center",
    title: "The Gulf listings pipeline",
    sub: "Subscriptions, pricing and debuts across six venues.",
  },
};

/** Resolve a slug to card copy, falling back through: entity → static → default. */
async function resolveCard(slug: string[]): Promise<CardContent> {
  if (slug.length === 0) return DEFAULT_CARD;
  const [kind, ...rest] = slug;

  if (kind === "stock" && rest.length >= 2) {
    const [venue, ticker] = rest;
    const sec = await resolveSecurity(venue, ticker);
    if (sec) {
      const header = await getStockHeader(sec.id);
      const last = header?.quote?.last ?? null;
      const changePct = header?.quote?.changePct ?? null;
      return {
        kicker: `${venueName(sec.venueCode)} · ${sec.ticker}`,
        title: sec.name,
        sub:
          last != null
            ? `${(header?.currency ?? "").trim()} ${fmtPrice(last)} · ${fmtSignedPct(changePct)} · delayed`.trim()
            : "Delayed price, filings, and the Marsad Score.",
        changePct,
      };
    }
  }

  if (kind === "filing" && rest.length >= 1) {
    const id = Number(rest[0]);
    if (Number.isInteger(id) && id > 0) {
      const f = await getFilingDetail(id);
      if (f) {
        return {
          kicker: f.ticker ? `${venueName(f.venueCode)} · ${f.ticker}` : "Filing",
          title: truncate(f.title ?? "Untitled filing", 100),
          sub: truncate(f.aiSummary ?? "Machine-extracted disclosure.", 130),
        };
      }
    }
  }

  if (kind === "earnings" && rest.length >= 1) {
    const id = Number(rest[0]);
    if (Number.isInteger(id) && id > 0) {
      const ev = await getEarningsEvent(id);
      if (ev) {
        return {
          kicker: `${venueName(ev.venueCode)} · ${ev.ticker}`,
          title: `${ev.name} — ${ev.fiscalPeriod}`,
          sub: ev.epsActual != null ? `EPS ${ev.epsActual.toFixed(2)} · ${fmtSignedPct(ev.epsYoyPct)} y/y` : "Results reported",
          changePct: ev.epsYoyPct,
        };
      }
    }
  }

  if (kind === "ipo" && rest.length >= 1) {
    const offer = await getIpoOffer(rest[0]);
    if (offer) {
      return {
        kicker: `${venueName(offer.venueCode)} · IPO`,
        title: offer.companyName,
        sub: offer.ticker ? `Ticker ${offer.ticker} · Gulf listings pipeline` : "Gulf listings pipeline",
      };
    }
  }

  return STATIC_CARDS[kind] ?? DEFAULT_CARD;
}

// ── Font loading (Google Fonts, subset to only the glyphs used) ────────────
// `next/font/google` (src/lib/fonts.ts) only works inside React components —
// a route handler must fetch font bytes itself. satori only parses ttf/otf/
// woff (not woff2), and Google's CSS2 API only serves those to legacy user
// agents, hence the spoofed UA below (the standard `next/og` recipe).
const LEGACY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36";

async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}&display=swap`;
    const cssRes = await fetch(cssUrl, { headers: { "User-Agent": LEGACY_UA } });
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const match = css.match(/src: url\(([^)]+)\)/);
    if (!match) return null;
    const fontRes = await fetch(match[1]);
    if (!fontRes.ok) return null;
    return await fontRes.arrayBuffer();
  } catch {
    // Network hiccup or Google Fonts unreachable — the caller degrades to
    // satori's built-in fallback rather than failing the whole image.
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const { slug } = await params;
  const card = await resolveCard(slug ?? []);

  const headline = truncate(card.title, 70);
  const kicker = card.kicker.toUpperCase();
  const labelText = "MARSAD · TADAWUL · DFM · ADX · QE · MSX · BHB · DELAYED 15 MIN";

  const [newsreaderBold, plexMonoMed, libreFranklinReg] = await Promise.all([
    loadGoogleFont("Newsreader", 700, headline),
    loadGoogleFont("IBM Plex Mono", 600, `${kicker}${labelText}${card.changePct != null ? fmtSignedPct(card.changePct) : ""}`),
    loadGoogleFont("Libre Franklin", 500, card.sub ?? ""),
  ]);

  const fonts: { name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 700; style: "normal" }[] = [];
  if (newsreaderBold) fonts.push({ name: "Newsreader", data: newsreaderBold, weight: 700, style: "normal" });
  if (plexMonoMed) fonts.push({ name: "IBM Plex Mono", data: plexMonoMed, weight: 600, style: "normal" });
  if (libreFranklinReg) fonts.push({ name: "Libre Franklin", data: libreFranklinReg, weight: 500, style: "normal" });

  const dirColor = card.changePct == null ? INK_MUTED : card.changePct >= 0 ? POSITIVE : NEGATIVE;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: PAPER,
          padding: "56px 72px",
        }}
      >
        {/* Masthead row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 14,
                height: 14,
                backgroundColor: INK,
                transform: "rotate(45deg)",
              }}
            />
            <span
              style={{
                fontFamily: "IBM Plex Mono",
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: 4,
                color: INK,
              }}
            >
              MARSAD
            </span>
          </div>
          <span
            style={{
              fontFamily: "IBM Plex Mono",
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: 2,
              color: INK_FAINT,
              backgroundColor: PAPER_TINT,
              padding: "8px 14px",
              border: `1px solid ${HAIRLINE}`,
            }}
          >
            DELAYED 15 MIN
          </span>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 1000 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, backgroundColor: dirColor }} />
            <span
              style={{
                fontFamily: "IBM Plex Mono",
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: 3,
                color: INK_MUTED,
              }}
            >
              {kicker}
            </span>
            {card.changePct != null ? (
              <span
                style={{
                  fontFamily: "IBM Plex Mono",
                  fontSize: 20,
                  fontWeight: 600,
                  color: dirColor,
                }}
              >
                {fmtSignedPct(card.changePct)}
              </span>
            ) : null}
          </div>
          <span
            style={{
              display: "flex",
              fontFamily: "Newsreader",
              fontWeight: 700,
              fontSize: headline.length > 40 ? 56 : 68,
              lineHeight: 1.12,
              letterSpacing: -1,
              color: INK,
            }}
          >
            {headline}
          </span>
          {card.sub ? (
            <span
              style={{
                display: "flex",
                fontFamily: "Libre Franklin",
                fontWeight: 500,
                fontSize: 24,
                lineHeight: 1.45,
                color: INK_MUTED,
                maxWidth: 880,
              }}
            >
              {card.sub}
            </span>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${HAIRLINE}`,
            paddingTop: 20,
          }}
        >
          <span
            style={{
              fontFamily: "IBM Plex Mono",
              fontSize: 14,
              letterSpacing: 2,
              color: INK_FAINT,
            }}
          >
            TADAWUL · DFM · ADX · QE · MSX · BHB
          </span>
          <span
            style={{
              fontFamily: "IBM Plex Mono",
              fontSize: 14,
              letterSpacing: 2,
              color: INK_FAINT,
            }}
          >
            MARSAD.COM
          </span>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: fonts.length > 0 ? fonts : undefined,
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}

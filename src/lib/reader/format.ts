import type { Rating } from "@/components/ui/types";

/**
 * Pure, isomorphic formatting helpers for the public reader (P2). No
 * `server-only` — the quote-header client island imports these too. Nothing
 * here reads the DB; these only shape values the `use cache` data layer already
 * returned. (Numeric coercion lives in `src/lib/data/util.ts`; these assume
 * already-coerced `number | null`.)
 */

// ── Score rating vocabulary ───────────────────────────────────────────────────
// `public.v_scores_public.rating` is UPPERCASE (BUY/OVERWEIGHT/HOLD/…); the
// ScoreModule / RatingBadge primitives take the title-case `Rating` union.
const RATING_MAP: Record<string, Rating> = {
  BUY: "Buy",
  OVERWEIGHT: "Overweight",
  HOLD: "Hold",
  UNDERWEIGHT: "Underweight",
  SELL: "Sell",
};

/** Map an uppercase DB rating to the title-case `Rating`, or null if unknown. */
export function toRating(raw: string | null | undefined): Rating | null {
  if (!raw) return null;
  return RATING_MAP[raw.trim().toUpperCase()] ?? null;
}

// ── Storage: public filings PDF URL ───────────────────────────────────────────
// The `filings` Storage bucket is PUBLIC, so a `pdf_storage_key` like
// `tdwl/1050/341_..._En.pdf` resolves to a stable public object URL. Each path
// segment is encoded so spaces/reserved chars in a key can't break the link.
export function pdfPublicUrl(storageKey: string | null | undefined): string | null {
  if (!storageKey) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!base) return null;
  const encoded = storageKey.split("/").map(encodeURIComponent).join("/");
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/filings/${encoded}`;
}

// ── Canonical site origin (SEO: sitemap / robots / JSON-LD / metadataBase) ────
// Prefer an explicit NEXT_PUBLIC_SITE_URL; fall back to the Vercel production
// host, then the marsad.com apex. Always returned without a trailing slash.
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const raw = explicit || (vercel ? `https://${vercel}` : "https://marsad.com");
  return raw.replace(/\/+$/, "");
}

// ── Venue / sector labels ─────────────────────────────────────────────────────
const VENUE_NAMES: Record<string, string> = {
  TDWL: "Tadawul",
  DFM: "Dubai · DFM",
  ADX: "Abu Dhabi · ADX",
  QE: "Qatar · QE",
  MSX: "Muscat · MSX",
  BHB: "Bahrain · BHB",
  BK: "Kuwait · BK",
};

export function venueName(code: string | null | undefined): string {
  if (!code) return "—";
  return VENUE_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** Title-case a sector slug (e.g. `real_estate` → `Real Estate`). */
export function sectorLabel(slug: string | null | undefined): string {
  if (!slug || slug === "unknown") return "—";
  return slug
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function currencyLabel(cur: string | null | undefined): string {
  return (cur ?? "").trim().toUpperCase() || "";
}

// ── Number / date formatting ──────────────────────────────────────────────────
export function fmtPrice(n: number | null | undefined, maxFrac = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}

export function fmtSignedNum(n: number | null | undefined, maxFrac = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
  return n > 0 ? `+${s}` : s;
}

export function fmtSignedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${s}%`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Compact large integers (share counts, volumes): 12.3M / 4.1B. */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display-only date formatting (e.g. `18 Jul 2026`). Never used for comparison. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Display-only date + UTC time (e.g. `18 Jul 2026 · 14:32`). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm}`;
}

/** Short mono timestamp (e.g. `14:32`, UTC) for the delayed-quote suffix. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

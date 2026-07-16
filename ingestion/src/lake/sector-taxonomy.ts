/**
 * Sector taxonomy — map a venue's raw sector string onto Marsad's INTERNAL taxonomy (07 §3.3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * Every venue prints its own sector vocabulary (Tadawul uses GICS-ish labels like
 * "Real Estate Mgt & Dev't"; ADX/DFM/QE/MSX each differ). The §3.3 sector→valid-ratio map
 * (ratios-compute.ts sectorValidity, owner D-1) and the §3.5 GCC-WIDE Score cohorts (D-2 — a
 * Saudi bank and a Qatari bank compete in ONE "banks" cohort) can only work if every venue's
 * strings collapse onto ONE shared vocabulary.
 *
 * ── THE OUTPUT VOCABULARY IS public.sectors.key (a FOREIGN KEY, verified live) ──────────────────
 * public.securities.sector is `FOREIGN KEY (sector) REFERENCES sectors(key)` — NOT free text. So this
 * mapper MUST emit one of the 13 seeded sectors.key slugs, or the projection UPDATE fails the FK. The
 * live keys (public.sectors): banks, insurance, financials, energy, materials, utilities, telecom,
 * healthcare, industrials, technology, real_estate, consumer, unknown. (The projection also validates against the
 * table defensively, so an out-of-sync mapper degrades to 'unknown' rather than erroring a tx — but
 * keep THIS list in sync with public.sectors as the primary contract.)
 *
 * THE ONE HARD CONSTRAINT (do not break): ratios-compute.ts special-cases banks/insurers by regex
 * `/bank/i` and `/insur/i` on securities.sector. The keys 'banks' and 'insurance' satisfy that. Every
 * other key only needs to be a valid sectors.key (it is a cohort key).
 *
 * FALLBACK DISCIPLINE (owner requirement): an unmappable venue string is NEVER SILENTLY left as the
 * pre-existing 'unknown'. It maps to the 'unknown' key (the sanctioned "Unknown / Unclassified" bucket,
 * mapped=false) AND the caller keeps the raw string (NormalizedProfile.rawSector, persisted on the
 * PROFILE.SECURITY object) + LOGS it (runtime.mapProfile). So a new/renamed venue sector surfaces as a
 * queryable, logged miss — distinguishable from a never-scraped 'unknown' by profile_scraped_at.
 *
 * PURITY: every export is a PURE function of its input — no I/O, no clock. Golden-testable.
 */

/** The internal taxonomy — the shared cohort vocabulary. MUST equal public.sectors.key (FK target).
 *  'banks'/'insurance' MUST keep those substrings (ratios-compute.ts sector regex). */
export const CANONICAL_SECTORS = [
  'banks',
  'insurance',
  'financials',
  'real_estate',
  'energy',
  'materials',
  'utilities',
  'telecom',
  'healthcare',
  'industrials',
  'technology',
  'consumer',
] as const;

export type CanonicalSector = (typeof CANONICAL_SECTORS)[number];

/** The sanctioned fallback key for an unmappable venue string — LOGGED, never a silent collapse. */
export const UNKNOWN_SECTOR = 'unknown';

/**
 * Priority-ordered keyword rules (raw venue string, lower-cased, whitespace-collapsed) → sectors.key.
 * ORDER MATTERS: 'bank' before generic finance, 'insur'/'takaful' before finance, materials (petrochem)
 * before energy (petro), real estate before finance. First match wins. Patterns are deliberately broad
 * substrings so casing/punctuation/venue phrasing drift is tolerated. 'technology' is placed AFTER
 * healthcare so "biotechnology" resolves to healthcare (not tech on the 'technolog' stem), and before
 * industrials/consumer so IT strings win over the broad capital-goods/consumer buckets.
 */
const SECTOR_RULES: ReadonlyArray<{ pattern: RegExp; sector: CanonicalSector }> = [
  // Financials — banks/insurers FIRST (they get the reduced §3.3 ratio set), then other finance.
  { pattern: /bank/, sector: 'banks' },
  { pattern: /insur|takaful|reinsur/, sector: 'insurance' },
  { pattern: /reit|real\s*estate|property|realty|estate development/, sector: 'real_estate' },
  { pattern: /financ|invest|brokerage|asset manage|securities/, sector: 'financials' },
  // Materials BEFORE Energy so "Petrochemicals" (GCC petrochem giants — SABIC etc.) resolves to
  // materials, not energy (both share the 'petro' stem; materials' 'petrochem' is the specific one).
  {
    pattern: /material|chemical|mining|metal|cement|petrochem|paper|glass|steel|packaging|basic resource/,
    sector: 'materials',
  },
  { pattern: /energy|oil|gas|petroleum|petro|refining|drilling/, sector: 'energy' },
  { pattern: /utilit|electric|power|water|desalinat/, sector: 'utilities' },
  { pattern: /telecom|communication/, sector: 'telecom' },
  { pattern: /health|pharma|medical|hospital|biotech|\bdrug/, sector: 'healthcare' },
  // Technology — AFTER healthcare so "biotechnology" stays healthcare (shared 'technolog' stem), and
  // before industrials/consumer so IT/software/hardware wins over the broad capital-goods buckets.
  { pattern: /technolog|software|\bit services|semiconductor|electronic equipment|hardware/, sector: 'technology' },
  // Industrials (capital goods, transport, contracting, commercial & professional services).
  {
    pattern: /industr|capital goods|transport|logistic|construct|contract|engineering|aerospace|machinery|building|commercial (?:&|and) professional|diversified operation/,
    sector: 'industrials',
  },
  // Consumer (one bucket — staples + discretionary collapse to the single 'consumer' key).
  {
    pattern: /food|beverage|agricultur|household|tobacco|dairy|poultry|retail|consumer|apparel|durables|media|entertainment|hotel|leisure|tourism|travel|restaurant|automobile|luxury|education/,
    sector: 'consumer',
  },
];

export interface SectorMapping {
  /** The internal-taxonomy key ('banks' | … | 'unknown'). Never blank; always a valid public.sectors.key. */
  sector: string;
  /** The venue's original string (trimmed), or null if the input was blank/absent. */
  rawSector: string | null;
  /** false ⇒ fell through to 'unknown' (the caller should log it). */
  mapped: boolean;
}

/**
 * PURE. Map a raw venue sector string onto the internal taxonomy (public.sectors.key). Blank/absent
 * input, or a string matching no rule, yields { sector: 'unknown', mapped: false } — the caller keeps
 * rawSector and logs the miss (never a silent collapse). Matching is case-insensitive + whitespace-
 * collapsed.
 */
export function mapSectorToTaxonomy(raw: string | null | undefined): SectorMapping {
  const rawSector = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (rawSector === null) {
    return { sector: UNKNOWN_SECTOR, rawSector: null, mapped: false };
  }
  const needle = rawSector.toLowerCase().replace(/\s+/g, ' ');
  for (const rule of SECTOR_RULES) {
    if (rule.pattern.test(needle)) {
      return { sector: rule.sector, rawSector, mapped: true };
    }
  }
  return { sector: UNKNOWN_SECTOR, rawSector, mapped: false };
}

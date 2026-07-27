/**
 * PD.3 — the closed block vocabulary, as a TypeScript union.
 *
 * These are the 61 `status='active'` keys in `ops.story_blocks`, seeded by
 * `scripts/design/generate-registry-seed.mjs` from `docs/design/block-registry.json`.
 * The 8 `status='legacy'` keys (BLK-QUOTE, BLK-TABLE, BLK-CHART, BLK-SCORE, BLK-YIELD,
 * BLK-COVERAGE, BLK-HOLDERS, BLK-FILING) predate the design handoff and deliberately have
 * **no payload schema** — the design splits the coarse ones (BLK-CHART → 15 shapes), so
 * re-pointing `ops.templates.block_keys` at the new codes is an editorial decision, not a rename.
 *
 * Listing them here (rather than deriving from the JSON at runtime) is what lets `tsc` prove that
 * `BLOCK_PAYLOAD_SCHEMAS` is total — a missing block is a compile error, not a runtime surprise.
 * Drift against the JSON is caught by the test in `__tests__/schemas.test.ts` and by
 * `node scripts/design/generate-block-schemas.mjs --check`.
 *
 * @see docs/architecture/09-signal-to-article.md §5.2
 */

/** A · Inline — units that live inside a sentence. */
export const FAMILY_A_CODES = [
  "BLK-TICKER",
  "BLK-DELTA",
  "BLK-CITE",
  "BLK-TERM",
  "BLK-SPARK",
  "BLK-MARGIN",
] as const;

/** B · Statement — where the desk commits to a view. */
export const FAMILY_B_CODES = [
  "BLK-THESIS",
  "BLK-PULLQUOTE",
  "BLK-BIGNUM",
  "BLK-VERDICT",
  "BLK-TAKE",
  "BLK-FALSIFY",
] as const;

/** C · Tabular — hard-bound to lake objects, every one of them. */
export const FAMILY_C_CODES = [
  "BLK-STATSTRIP",
  "BLK-KEYSTATS",
  "BLK-FINTABLE",
  "BLK-SCENARIO",
  "BLK-RANKROW",
  "BLK-BEATMISS",
  "BLK-EXDATE",
  "BLK-COMPARE",
] as const;

/** D · Charts — one shape per question (D-12). */
export const FAMILY_D_CODES = [
  "BLK-LINE",
  "BLK-AREA",
  "BLK-BARS",
  "BLK-STACK",
  "BLK-WATERFALL",
  "BLK-SCATTER",
  "BLK-DIST",
  "BLK-DUMBBELL",
  "BLK-SLOPE",
  "BLK-RANGE",
  "BLK-HEAT",
  "BLK-INDEXED",
  "BLK-DONUT",
  "BLK-COVER",
  "BLK-CANDLE",
] as const;

/** E · Mechanism & explainer — evergreen, review-dated. */
export const FAMILY_E_CODES = [
  "BLK-TIMELINE",
  "BLK-STEPS",
  "BLK-FLOW",
  "BLK-ANATOMY",
  "BLK-WORKED",
  "BLK-MYTH",
  "BLK-DECISION",
  "BLK-GLOSSARY",
] as const;

/** F · Wire & live state — timestamped, perishable, honest about being stale. */
export const FAMILY_F_CODES = [
  "BLK-TAPEROW",
  "BLK-CHIPROW",
  "BLK-SNAPSHOT",
  "BLK-COUNTDOWN",
  "BLK-HALT",
  "BLK-CORRECTION",
  "BLK-BREADTH",
  "BLK-VENUEHEAD",
] as const;

/** G · Provenance & trust — the audit trail, rendered. Build order says this family first. */
export const FAMILY_G_CODES = [
  "BLK-PROV",
  "BLK-AGENTS",
  "BLK-FRESH",
  "BLK-ESTIMATE",
  "BLK-CONFLICT",
  "BLK-RULE",
] as const;

/** H · Gates & CTAs — where the business model touches the page. */
export const FAMILY_H_CODES = [
  "BLK-CUT",
  "BLK-PAYWALL",
  "BLK-ALERTCTA",
  "BLK-DOWNLOAD",
] as const;

/** All 61 active block codes, in family order. */
export const BLOCK_CODES = [
  ...FAMILY_A_CODES,
  ...FAMILY_B_CODES,
  ...FAMILY_C_CODES,
  ...FAMILY_D_CODES,
  ...FAMILY_E_CODES,
  ...FAMILY_F_CODES,
  ...FAMILY_G_CODES,
  ...FAMILY_H_CODES,
] as const;

/** One of the 61 codes a writer agent may emit. Anything else is a refusal, not a fallback. */
export type BlockCode = (typeof BLOCK_CODES)[number];

/** Family letter, as stored in `ops.story_blocks.family`. */
export type BlockFamily = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

const FAMILY_MEMBERS: Record<BlockFamily, readonly string[]> = {
  A: FAMILY_A_CODES,
  B: FAMILY_B_CODES,
  C: FAMILY_C_CODES,
  D: FAMILY_D_CODES,
  E: FAMILY_E_CODES,
  F: FAMILY_F_CODES,
  G: FAMILY_G_CODES,
  H: FAMILY_H_CODES,
};

/** Which family a code belongs to. */
export function familyOf(code: BlockCode): BlockFamily {
  for (const [family, members] of Object.entries(FAMILY_MEMBERS)) {
    if (members.includes(code)) return family as BlockFamily;
  }
  // Unreachable while `BlockCode` is derived from the same arrays, but a runtime caller may
  // hand us a string that only claims to be a BlockCode.
  throw new Error(`familyOf: ${code} is not one of the ${BLOCK_CODES.length} active block codes`);
}

/** Type guard for untrusted input — an agent's outline, a DB row, a request body. */
export function isBlockCode(value: unknown): value is BlockCode {
  return typeof value === "string" && (BLOCK_CODES as readonly string[]).includes(value);
}

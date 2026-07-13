/**
 * The 2-source agreement rule — PURE decision logic (CONTRACT §7).
 *
 * Separated from the DB so it is exhaustively unit-testable with zero I/O. The
 * cross-check service gathers candidate staging rows for one natural_key, then
 * calls decide() to pick the outcome; all Postgres mutation lives in
 * cross-check.ts.
 *
 * Tolerance (CONTRACT §7): prices ±0.5%; dates exact; enum/text exact. The kind
 * is inferred from the value's JS type — number ⇒ price tolerance; everything
 * else ⇒ exact string compare (dates/enums arrive as ISO strings / enum text).
 */

export interface Candidate {
  /** lake.staging_rows.id — lets cross-check mark exactly these rows consumed. */
  stagingId: number;
  sourceId: number;
  /** registrar=10, exchange=20, press=90 — lower wins (CONTRACT §6.5). */
  sourceRank: number;
  /** The canonical scalar compared across sources. null ⇒ non-scalar payload. */
  numericValue: number | null;
  /** Fallback comparison token for non-numeric facts (date/enum/text). */
  comparableText: string;
  priceSensitive: boolean;
}

export type Decision =
  | { kind: 'PENDING'; reason: 'single_source' | 'price_sensitive_hold'; winner: Candidate }
  | { kind: 'VERIFIED'; winner: Candidate; agreeingSourceIds: number[] }
  | { kind: 'CONFLICT'; winner: Candidate; candidates: Candidate[] };

/** Default price agreement tolerance: ±0.5% (R-04 convention). */
export const PRICE_TOLERANCE = 0.005;

/** Two numeric prints agree if within ±tolerance of the larger magnitude. */
export function pricesAgree(a: number, b: number, tolerance = PRICE_TOLERANCE): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return Math.abs(a - b) === 0;
  return Math.abs(a - b) / scale <= tolerance;
}

/** Do two candidates carry the same fact within the type-appropriate tolerance? */
export function candidatesAgree(a: Candidate, b: Candidate, tolerance = PRICE_TOLERANCE): boolean {
  if (a.numericValue !== null && b.numericValue !== null) {
    return pricesAgree(a.numericValue, b.numericValue, tolerance);
  }
  // Non-numeric (date/enum/text) or mixed numeric/non-numeric ⇒ exact token match.
  return a.comparableText === b.comparableText;
}

/** Independence = distinct source_id. Two rows from the SAME source never
 *  satisfy the 2-source rule, however many times they were emitted. */
function independent(a: Candidate, b: Candidate): boolean {
  return a.sourceId !== b.sourceId;
}

/** Primary source wins: lowest source_rank, ties broken by lowest sourceId
 *  for determinism. */
export function primaryOf(candidates: Candidate[]): Candidate {
  return [...candidates].sort(
    (x, y) => x.sourceRank - y.sourceRank || x.sourceId - y.sourceId,
  )[0];
}

/**
 * Decide the outcome for one natural_key from its live candidate set.
 *
 * - 0 candidates ⇒ caller must not invoke decide() (guard upstream).
 * - single independent source            ⇒ PENDING (single_source).
 * - ≥2 independent sources that AGREE     ⇒ VERIFIED (winner = primary).
 *   …but if the winning fact is price_sensitive ⇒ PENDING (price_sensitive_hold):
 *   VERIFIED requires a HUMAN verifier (33b, enforced by the DB state guard), so
 *   cross-check parks it PENDING and raises a Desk item instead of auto-verifying.
 * - ≥2 independent sources that DISAGREE  ⇒ CONFLICT (primary_wins policy).
 *
 * "Agree" means: there exists a value on which ≥2 independent sources concur.
 * We group candidates into agreement clusters; the largest independent cluster
 * that reaches size ≥2 wins. If no cluster reaches 2 independent sources but ≥2
 * independent sources exist with differing values ⇒ CONFLICT.
 */
export function decide(candidates: Candidate[], tolerance = PRICE_TOLERANCE): Decision {
  if (candidates.length === 0) {
    throw new Error('decide() requires at least one candidate');
  }

  const distinctSources = new Set(candidates.map((c) => c.sourceId));
  if (distinctSources.size < 2) {
    return { kind: 'PENDING', reason: 'single_source', winner: primaryOf(candidates) };
  }

  // Build agreement clusters keyed by the first member; a candidate joins the
  // first cluster whose representative it agrees with.
  const clusters: Candidate[][] = [];
  for (const cand of candidates) {
    const cluster = clusters.find((cl) => candidatesAgree(cl[0], cand, tolerance));
    if (cluster) cluster.push(cand);
    else clusters.push([cand]);
  }

  // A cluster "reaches consensus" when it spans ≥2 independent sources.
  const consensusClusters = clusters
    .map((cl) => ({ cl, sources: new Set(cl.map((c) => c.sourceId)) }))
    .filter((c) => c.sources.size >= 2);

  if (consensusClusters.length > 0) {
    // Largest independent consensus cluster; ties → lowest primary rank.
    consensusClusters.sort(
      (a, b) =>
        b.sources.size - a.sources.size ||
        primaryOf(a.cl).sourceRank - primaryOf(b.cl).sourceRank,
    );
    const winning = consensusClusters[0].cl;
    const winner = primaryOf(winning);
    const agreeingSourceIds = [...new Set(winning.map((c) => c.sourceId))];

    // Any member being price-sensitive holds the whole key for human confirm.
    if (winning.some((c) => c.priceSensitive)) {
      return { kind: 'PENDING', reason: 'price_sensitive_hold', winner };
    }
    return { kind: 'VERIFIED', winner, agreeingSourceIds };
  }

  // ≥2 independent sources but none agree ⇒ conflict; primary source wins.
  const winner = primaryOf(candidates);
  // sanity: at least two independent sources actually disagree
  const anyDisagreement = candidates.some((c) => !candidatesAgree(winner, c, tolerance) && independent(winner, c));
  if (!anyDisagreement) {
    // Degenerate: all agree with the primary but shared source counting failed —
    // treat as single-source PENDING rather than a false conflict.
    return { kind: 'PENDING', reason: 'single_source', winner };
  }
  return { kind: 'CONFLICT', winner, candidates };
}

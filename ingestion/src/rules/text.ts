/**
 * Pure text utilities for the rules engine (P3.2) — sentence splitting, [cN] marker
 * extraction, unit-aware number parsing (R-04), and phrase normalization (R-05).
 * No I/O; every function is a pure transform for golden tests.
 */

/** A sentence carries a number if it has a digit run that is a magnitude, %, or currency.
 *  Exported so the deterministic auto-marker (automark.ts) tokenizes numbers with the
 *  EXACT same pattern R-03's hasNumber uses — one source of truth for "what is a number". */
export const NUMBER_TOKEN =
  /(?<![\w])(?:SAR|AED|QAR|OMR|BHD|KWD|USD|﷼|\$)?\s?-?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|trillion|tn|bn|billion|mn|m|million|k|thousand|SAR|AED|QAR|OMR|BHD|KWD|USD)?/gi;

/** Relative tolerance for "this number matches that number" — 0.5%. R-04's block
 *  threshold, and the SAME threshold the fit stage's numeric-consistency check uses.
 *  Lives here (not in rules.ts) so there is one tolerance, not one per reader. */
export const DRIFT_TOL = 0.005;

/** [c1], [c2], … citation markers. */
const MARKER = /\[c(\d+)\]/gi;

/** Split body into sentences (naive but deterministic — good enough for rule scanning). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** All distinct claim keys ('c1') referenced by [cN] markers in a text. */
export function markersIn(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(text)) !== null) out.add(`c${m[1]}`);
  return [...out];
}

/** Every numeric token in a text, per the ONE definition of "what is a number"
 *  (NUMBER_TOKEN). Exported so any reader that must enumerate numerals — R-03's
 *  hasNumber, the auto-marker, the fit stage's numeric-consistency check — tokenizes
 *  identically. A second regex is how DEF-RULES-R04-REGEX happened. */
export function numberTokens(text: string): string[] {
  NUMBER_TOKEN.lastIndex = 0;
  return (String(text).match(NUMBER_TOKEN) ?? []).map((t) => t.trim()).filter(Boolean);
}

/** A bare year (1990–2099) is not a claim number. The shared exemption — R-03's
 *  hasNumber and the fit stage's numeric check must agree on this or one of them
 *  refuses every dateline. (A quarter tag "Q1" never tokenizes: NUMBER_TOKEN's
 *  `(?<![\w])` lookbehind rejects a digit preceded by a letter.) */
export function isYearToken(token: string): boolean {
  const t = String(token).trim();
  return /^\d{4}$/.test(t) && Number(t) >= 1990 && Number(t) <= 2099;
}

const UNIT_TOKEN = /%|percent|trillion|tn|bn|billion|mn|m|million|k|thousand|SAR|AED|QAR|OMR|BHD|KWD|USD|\u065F|\$/i;

/**
 * Is this numeral a FINANCIAL MAGNITUDE (so it must be lake-backed), or incidental prose?
 *
 * The deliberate false-refusal control for R-04's every-numeral check. A bare integer under
 * 1,000 with no unit ("three of the four", "8 rows", "part 2 of 3") is prose, not a claim;
 * requiring it to resolve to a lake value would block most honest copy, and a BLOCK rule that
 * fires on everything gets switched off. A materiality filter LAYERED ON numberTokens() — NOT a
 * second definition of "what is a number", which is how DEF-RULES-R04-REGEX happened.
 *
 * Lives here rather than in the fit stage so R-04 and PD.8's numeric-consistency check cannot
 * drift apart: they are the same question asked at two points in the pipeline.
 */
export function isMaterialNumeral(token: string): boolean {
  const t = String(token).trim();
  if (isYearToken(t)) return false;
  if (UNIT_TOKEN.test(t)) return true;   // a unit makes it a claim: "11.2%", "QAR 4.43bn"
  if (/[.,]/.test(t)) return true;       // a decimal or thousands separator: "0.25", "1,013,707"
  const mag = parseMagnitude(t);
  return mag !== null && Math.abs(mag) >= 1000;
}

/**
 * True if the sentence contains a numeric CLAIM (R-03's trigger).
 *
 * Delegates to {@link isMaterialNumeral} rather than keeping its own idea of what counts. The two
 * had diverged: this excluded only year tokens, so "Q2 2026 net profit for the quarter ended
 * 30 June 2026" tripped on the `2` in Q2 and the `30` in the date and demanded a citation for a
 * sentence that asserts nothing. Composed block captions are almost entirely period labels, so
 * that blocked the pipeline on every piece the compose stage touched.
 *
 * The line between "a number" and "a claim" now lives in exactly one function, which is what the
 * note at the top of this file already said was true.
 */
export function hasNumber(sentence: string): boolean {
  return numberTokens(sentence).some((t) => /\d/.test(t) && isMaterialNumeral(t));
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  bn: 1e9, billion: 1e9,
  tn: 1e12, trillion: 1e12,
};

/**
 * Parse the FIRST magnitude in a string to an absolute number (unit-aware), or null.
 * "SAR 6.25bn" → 6.25e9; "QAR 1.44 trillion" → 1.44e12; "11,801,234" → 11801234;
 * "5.6%" → 5.6 (percents are not scaled).
 */
export function parseMagnitude(s: string): number | null {
  const str = String(s);
  const m = str.match(
    /(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|trillion|tn|bn|billion|mn|m|million|k|thousand)?/i,
  );
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '%' || unit === 'percent') return base;
  const scale = SCALE[unit] ?? 1;
  return base * scale;
}

/**
 * Does a magnitude written in PROSE correspond to a value frozen from the LAKE?
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────────────────
 * The lake stores a growth rate as a FRACTION (`0.1159`). A writer writes it as a PERCENT
 * ("revenue up 11.6%"), and freezes `quoted_value` as the raw lake number. R-04 then compared
 * 11.6 against 0.1159, found a 99% difference, and blocked. Both real drafts died this way,
 * and the recorded violations show it precisely: {"cited":0.1159, "sentence_mags":[…,11.2,…]}
 * and {"cited":-0.0586, "sentence_mags":[…,5.86,…]}.
 *
 * Every percentage story blocked. Not some — every one, because a fraction can never be within
 * 0.5% of its own percent rendering.
 *
 * ── WHY THIS AND NOT A WIDER TOLERANCE ─────────────────────────────────────────────────
 * Widening DRIFT_TOL to cover a 100x gap would stop R-04 checking anything at all. The two
 * numbers are not APPROXIMATELY equal, they are EXACTLY equal in different units, so the fix
 * belongs in the unit handling. A fraction under 1 and its ×100 rendering are the same fact;
 * anything else still has to match within 0.5%.
 *
 * The residual false-pass this admits: a cited ratio of 0.5 against a prose "50". That is the
 * price of not blocking every percentage in the product, it is bounded to sub-1 cited values,
 * and the writer prompt now also requires quoted_value to be the figure AS WRITTEN — so this is
 * the safety net, not the primary mechanism.
 */
export function magnitudeMatches(proseMag: number, citedValue: number, proseAssertsSign = false): boolean {
  // Direction in prose is carried by WORDS ("fell 5.86%"), not by a minus sign, while the lake
  // carries it in the sign (-0.0586). Comparing those signed blocks honest copy; comparing them
  // unsigned would stop R-04 noticing a genuine direction error. So: compare unsigned UNLESS the
  // prose wrote an explicit '-', in which case the writer has asserted a sign and must match it.
  //
  // This is consistent with the block contract, where `direction` is DERIVED from the resolved
  // value's sign at render time and is never writer-asserted — so the sign is the lake's to state,
  // and prose adjectives are not a claim R-04 can adjudicate.
  const p = proseAssertsSign ? proseMag : Math.abs(proseMag);
  const c = proseAssertsSign ? citedValue : Math.abs(citedValue);
  if (relDiff(p, c) <= DRIFT_TOL) return true;
  // A lake fraction rendered as a percent in prose.
  if (c !== 0 && Math.abs(c) < 1 && relDiff(p, c * 100) <= DRIFT_TOL) return true;
  // The mirror: prose carries the fraction and the citation froze the percent.
  if (p !== 0 && Math.abs(p) < 1 && relDiff(p * 100, c) <= DRIFT_TOL) return true;
  return false;
}

/** Did the writer put an explicit minus on this numeral? (See magnitudeMatches.) */
export function tokenAssertsSign(token: string): boolean {
  return /-\s*\d/.test(String(token));
}

/** Relative difference |a-b|/|b|; b=0 → 0 when a=0 else Infinity. */
export function relDiff(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return Math.abs(a - b) / Math.abs(b);
}

/** Normalize a phrase for banned-phrase matching: lower, strip diacritics + punctuation, collapse ws. */
export function normalizePhrase(s: string): string {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

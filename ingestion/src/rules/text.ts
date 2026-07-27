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

/** True if the sentence contains a numeric/percent/currency token (R-03 trigger). */
export function hasNumber(sentence: string): boolean {
  return numberTokens(sentence).some((t) => !isYearToken(t) && /\d/.test(t));
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

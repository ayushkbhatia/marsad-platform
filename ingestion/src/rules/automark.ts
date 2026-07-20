/**
 * Deterministic post-draft auto-marker (DEF-WRITER-NUMBER-MARKING).
 *
 * The writer occasionally leaves a number without a [cN] marker (especially in the dek),
 * which trips R-03 (number_without_citation) and false-blocks an otherwise-sound piece to a
 * human. This pass repairs ONLY that false-block: for every bare number, if EXACTLY ONE of
 * the draft's already-frozen citations has a quoted value within 0.5% of it, we attach that
 * citation's existing key immediately after the number.
 *
 * SAFETY INVARIANT: the pass only ever attaches an EXISTING citation key whose frozen value
 * matches the number within DRIFT_TOL (0.5%) — it never invents a marker or a source. So it
 * can never create an R-04 number_mismatch and can never manufacture a citation; a genuinely
 * unsourced number (zero matching cites) is LEFT BARE so R-03 still blocks it. Two-or-more
 * matches are ambiguous and also left bare. Idempotent: a number already covered by a marker
 * for its magnitude is skipped, so re-running is a no-op.
 *
 * Pure function; reuses the rules engine's own text utilities so "what is a number" and "how
 * a magnitude parses" stay identical to what R-03/R-04 will re-read afterwards.
 */

import { NUMBER_TOKEN, hasNumber, markersIn, parseMagnitude, relDiff, splitSentences } from './text.js';

/** 0.5% — the same block threshold R-04 uses (DRIFT_TOL). A frozen cite value must land
 *  within this of the number for its key to be attached. */
const DRIFT_TOL = 0.005;

/** One draft citation reduced to what the marker match needs: its key + parsed frozen magnitude. */
export interface AutoMarkCite {
  key: string;          // 'c1', 'c2', …
  mag: number | null;   // parseMagnitude(String(quoted_value)); null = non-numeric cite (a date/label)
}

export interface AutoMarkResult {
  /** The input with matched-and-unambiguous bare numbers now carrying their [cKey]. */
  text: string;
  /** Every marker actually injected, for logging/telemetry. */
  added: { key: string; mag: number }[];
}

/**
 * Attach existing citation keys to bare numbers in `text`. See SAFETY INVARIANT above.
 * Whitespace is normalized the same way the rules engine reads the surface (splitSentences
 * collapses runs of whitespace) — markers land inside single-spaced prose.
 */
export function autoMarkNumbers(text: string, cites: AutoMarkCite[]): AutoMarkResult {
  const added: { key: string; mag: number }[] = [];
  const usable: { key: string; mag: number }[] = cites.filter(
    (c): c is { key: string; mag: number } => typeof c.mag === 'number' && Number.isFinite(c.mag),
  );
  if (usable.length === 0) return { text, added };

  const byKey = new Map<string, number>(usable.map((c) => [c.key, c.mag]));
  const marked = splitSentences(text).map((sentence) => markSentence(sentence, usable, byKey, added));
  // If nothing was injected, return the input untouched — the pass only ever reformats a
  // surface it actually had to mark (never silently reflows a clean draft's whitespace).
  return added.length === 0 ? { text, added } : { text: marked.join(' '), added };
}

/** Mark one sentence in place; pushes any injections to `added`. */
function markSentence(
  sentence: string,
  cites: { key: string; mag: number }[],
  byKey: Map<string, number>,
  added: { key: string; mag: number }[],
): string {
  if (!hasNumber(sentence)) return sentence;

  // A magnitude is "covered" if a marker already present (or one we inject as we go) cites a
  // value within tolerance of it. Seed with the markers the writer already placed.
  const coveredMags: number[] = [];
  for (const key of markersIn(sentence)) {
    const m = byKey.get(key);
    if (typeof m === 'number') coveredMags.push(m);
  }

  // Fresh regex instance from the shared source → no shared lastIndex hazard across calls.
  const re = new RegExp(NUMBER_TOKEN.source, NUMBER_TOKEN.flags);
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const tok = m[0];
    if (tok.length === 0) { re.lastIndex++; continue; } // guard a zero-width match
    const end = m.index + tok.length;
    const t = tok.trim();
    const isYear = /^\d{4}$/.test(t) && Number(t) >= 1990 && Number(t) <= 2099; // R-03/R-04 ignore bare years
    const mag = parseMagnitude(tok);

    let injection = '';
    if (!isYear && mag !== null && !coveredMags.some((c) => relDiff(mag, c) <= DRIFT_TOL)) {
      const matches = cites.filter((c) => relDiff(mag, c.mag) <= DRIFT_TOL);
      if (matches.length === 1) {
        injection = ` [${matches[0].key}]`;
        added.push({ key: matches[0].key, mag });
        coveredMags.push(mag); // now covered → a later identical magnitude in the same sentence is skipped
      }
      // 0 matches → leave bare (R-03 still blocks genuinely unsourced numbers).
      // 2+ matches → ambiguous → leave bare.
    }
    out += sentence.slice(lastIdx, end) + injection;
    lastIdx = end;
  }
  out += sentence.slice(lastIdx);
  return out;
}

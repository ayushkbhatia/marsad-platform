/**
 * R-01..R-10 as pure functions (P3.2, 03 §8.2). Each returns a RuleResult; the engine
 * (engine.ts) sequences them, threads the R-10 headline rewrite, and derives pass /
 * auto-publish eligibility. The two LLM-assisted rules (R-06, R-10) take the injected
 * RuleLlm seam so the deterministic majority stays synchronously testable.
 */

import type { CitationRow, EngineOptions, RuleContext, RuleLlm, RuleResult } from './types.js';
import {
  DRIFT_TOL, hasNumber, isMaterialNumeral, magnitudeMatches, markersIn, normalizePhrase,
  numberTokens, parseMagnitude, relDiff, splitSentences, tokenAssertsSign,
} from './text.js';

/** Beyond this the nearest payload value is not 'drift', it is an unrelated number. See r04. */
const LAKE_DRIFT_MAX = 0.25;

/** R-03 fail-closed default: a type with no ops.materiality_prefilter.citable_states row is
 *  citable only when VERIFIED. Mirrors lake.fn_intake_eligible_state's fallback for an
 *  unknown type — a new object family must be registered before it can be cited. */
const DEFAULT_CITABLE_STATES = ['VERIFIED'];

const CLICKBAIT = /\b(shocking|you won'?t believe|this is why|secret|insane|skyrocket|plunge|crash|explode|breaking)\b/i;

/** Every text surface (headline + dek + blocks) — used by R-05 banned-phrase scan. */
function textSurfaces(ctx: RuleContext): { where: string; body: string }[] {
  return [{ where: 'headline', body: ctx.headline }, ...bodySurfaces(ctx)];
}

/** BODY surfaces only (dek + blocks) — the headline is a distillation and does NOT carry
 *  inline [cN] markers (spec §8.2 "tokenize BODY"); its numbers are checked against
 *  citations by R-04, not required to carry a marker by R-03. */
function bodySurfaces(ctx: RuleContext): { where: string; body: string }[] {
  const out: { where: string; body: string }[] = [];
  if (ctx.dek) out.push({ where: 'dek', body: ctx.dek });
  for (const b of ctx.blocks) out.push({ where: `block:${b.seq}`, body: b.body });
  return out;
}

function citationByKey(ctx: RuleContext): Map<string, CitationRow> {
  return new Map(ctx.citations.map((c) => [c.claim_key, c]));
}

// R-01 — standard disclaimer present (AUTO_FIX: the handler appends it when absent).
export function r01(ctx: RuleContext): RuleResult {
  if (ctx.has_disclaimer_block) {
    return { rule_key: 'R-01', mode: 'AUTO_FIX', outcome: 'passed', detail: {} };
  }
  return { rule_key: 'R-01', mode: 'AUTO_FIX', outcome: 'auto_fixed', detail: { appended: 'standard_disclaimer' } };
}

// R-02 — every ticker tag resolves to a LISTED security (BLOCK).
export function r02(ctx: RuleContext): RuleResult {
  const unresolved = ctx.tickers.filter((t) => !t.resolved_listed).map((t) => t.ticker);
  return unresolved.length > 0
    ? { rule_key: 'R-02', mode: 'BLOCK', outcome: 'blocked', detail: { unresolved } }
    : { rule_key: 'R-02', mode: 'BLOCK', outcome: 'passed', detail: {} };
}

// R-03 — source or silence / cite what you claim (BLOCK).
//
// Two clauses are unchanged since P3.2: every number-bearing sentence carries a [cN], and
// every marker resolves to a citation. The third clause used to be `object_state ===
// 'VERIFIED'`, and it is why the newsroom could never publish.
//
// ── WHY THAT CLAUSE CHANGED (09 §3.2, and it is not a relaxation) ──────────────────────
// Migration 20260727150000 deliberately widened INTAKE to admit PENDING FILING.FINANCIALS,
// because Lane-B researchers write PENDING unconditionally and cross-check cannot promote
// what never entered staging. Nobody updated this rule to match. The result was a system
// that admitted exactly the objects it then refused to let anyone cite: 6 of 6 rule runs
// blocked on `cited_object_not_verified`, both real drafts died, and the conveyor has been
// off since.
//
// The replacement is the PROVENANCE FLOOR: a citation is legal when the cited object is in
// its type's allowed state set, is not superseded, is not in CONFLICT, carries a parse-run
// lineage that SUCCEEDED, and has no open correction. That is a claim about traceability to
// a primary document we still hold the bytes of — which is a stronger guarantee than "two
// scrapers agreed", because it is anchored to the source rather than to a coincidence
// between two secondaries.
//
// What did NOT move: `distinct_lineage_roots >= 2` remains the AUTO-PUBLISH gate in
// engine.ts (Revision #5). A single-rooted piece still publishes — through a human.
export function r03(ctx: RuleContext, opts?: EngineOptions): RuleResult {
  const byKey = citationByKey(ctx);
  const violations: Record<string, unknown>[] = [];
  const statesFor = (objectType?: string | null): string[] =>
    (objectType && opts?.citableStatesByType?.[objectType]) || DEFAULT_CITABLE_STATES;

  for (const surf of bodySurfaces(ctx)) {
    for (const sentence of splitSentences(surf.body)) {
      const markers = markersIn(sentence);
      if (hasNumber(sentence) && markers.length === 0) {
        violations.push({ where: surf.where, kind: 'number_without_citation', sentence: sentence.slice(0, 160) });
        continue;
      }
      for (const key of markers) {
        const cit = byKey.get(key);
        if (!cit) { violations.push({ where: surf.where, kind: 'marker_unresolved', key }); continue; }

        const state = cit.object_state ?? 'missing';
        const allowed = statesFor(cit.object_type);

        // CONFLICT is blocking whatever the allowlist says: two sources disagree about this
        // number, so there is no fact to cite yet. Never make it configurable.
        if (state === 'CONFLICT') {
          violations.push({ where: surf.where, kind: 'cited_object_in_conflict', key, object_type: cit.object_type });
          continue;
        }
        if (!allowed.includes(state)) {
          violations.push({
            where: surf.where, kind: 'cited_object_state_not_citable',
            key, state, object_type: cit.object_type, allowed,
          });
          continue;
        }
        if (cit.superseded) {
          violations.push({ where: surf.where, kind: 'cited_object_superseded', key });
          continue;
        }
        // `undefined` means the assembler did not resolve it; treat only an explicit false as
        // a failure, so an older assembler cannot silently turn this clause off.
        if (cit.parse_run_ok === false) {
          violations.push({ where: surf.where, kind: 'cited_object_lineage_unproven', key });
          continue;
        }
        // Dormant until corrections are object-scoped (see CitationRow.has_open_correction):
        // ops.correction_flags carries content_id, not object_id, so nothing sets this yet.
        if (cit.has_open_correction) {
          violations.push({ where: surf.where, kind: 'cited_object_under_correction', key });
        }
      }
    }
  }
  return violations.length > 0
    ? { rule_key: 'R-03', mode: 'BLOCK', outcome: 'blocked', detail: { violations } }
    : { rule_key: 'R-03', mode: 'BLOCK', outcome: 'passed', detail: {} };
}

// R-04 — numbers match the lake (BLOCK). Each marker's sentence must contain a magnitude
// within 0.5% of the citation's frozen cited_value; and the frozen value must still match
// the live object payload (catches mid-pipeline correction drift).
const MAG_RE = /-?\d[\d,]*(?:\.\d+)?\s*(?:%|trillion|tn|bn|billion|mn|m|million|k|thousand)?/gi;

export function r04(ctx: RuleContext): RuleResult {
  const byKey = citationByKey(ctx);
  const violations: Record<string, unknown>[] = [];

  // Headline: every magnitude must match SOME citation's frozen value within 0.5%
  // (the headline carries no marker, but its numbers must still be lake-backed).
  const citedMags = ctx.citations
    .map((c) => parseMagnitude(typeof c.cited_value === 'object' ? JSON.stringify(c.cited_value) : String(c.cited_value)))
    .filter((n): n is number => n !== null);
  for (const tok of numberTokens(ctx.headline)) {
    const mag = parseMagnitude(tok);
    if (mag === null) continue;
    if (!isMaterialNumeral(tok)) continue; // years and incidental integers are not claims
    if (!citedMags.some((c) => magnitudeMatches(mag, c, tokenAssertsSign(tok)))) {
      violations.push({ where: 'headline', kind: 'headline_number_uncited', value: mag });
    }
  }

  for (const surf of bodySurfaces(ctx)) {
    for (const sentence of splitSentences(surf.body)) {
      for (const key of markersIn(sentence)) {
        const cit = byKey.get(key);
        if (!cit) continue; // R-03 already flagged the unresolved marker
        const citedMag = parseMagnitude(typeof cit.cited_value === 'object' ? JSON.stringify(cit.cited_value) : String(cit.cited_value));
        if (citedMag === null) continue; // non-numeric citation (e.g. a date/label) — nothing to match
        const toks = numberTokens(sentence);
        const mags = toks.map(parseMagnitude).filter((n): n is number => n !== null);
        const near = toks.some((t) => {
          const m = parseMagnitude(t);
          return m !== null && magnitudeMatches(m, citedMag, tokenAssertsSign(t));
        });
        if (!near) {
          violations.push({ where: surf.where, kind: 'number_mismatch', key, cited: citedMag, sentence_mags: mags });
        }
        // Drift vs live payload: if the payload still carries the cited key/value and it moved.
        // GUARDED (partial DEF-RULES-R04-LAKE-DRIFT): findPayloadMagnitude returns whatever value
        // in the payload is numerically NEAREST the cited one, which is not evidence of anything
        // when nothing in the payload is comparable — the recorded live failure matched a fiscal
        // year (2026) against a QAR 4.43bn profit and declared drift, blocking every citation in
        // both real drafts. Drift means "the value MOVED A LITTLE"; a wildly different nearest
        // value means "no corresponding value", which this rule cannot distinguish from a payload
        // that simply does not carry the cited field. Only report inside a plausible band; the
        // real fix is an explicit payload_path recorded at draft time (P4.3).
        if (cit.object_payload && cit.cited_value !== null && typeof cit.cited_value !== 'object') {
          const liveMag = findPayloadMagnitude(cit.object_payload, citedMag);
          if (liveMag !== null) {
            const d = relDiff(liveMag, citedMag);
            if (d > DRIFT_TOL && d <= LAKE_DRIFT_MAX) {
              violations.push({ where: surf.where, kind: 'lake_drift', key, cited: citedMag, live: liveMag });
            }
          }
        }
      }

      // ── the OTHER direction ────────────────────────────────────────────────────────────────
      // Above asks "does each CITATION's value appear in the sentence?". That alone is what let
      // this ship live:
      //   "net profit of QAR 4.43bn [c1], up from QAR 4.22bn a year earlier, revenue rising 11.2% [c1]"
      // c1 = QAR 4.43bn matched, so the sentence passed — and 4.22bn and 11.2% rode along
      // uncorroborated, with 11.2% reaching the headline. Every MATERIAL numeral in a marked
      // sentence must be accounted for by one of that sentence's citations.
      //
      // Scoped to sentences that HAVE a marker: an unmarked numeral is R-03's
      // `number_without_citation`, and reporting it here too would double-block one defect.
      for (const sentence of splitSentences(surf.body)) {
        const keys = markersIn(sentence);
        if (keys.length === 0) continue;
        const sentenceCited = keys
          .map((k) => byKey.get(k))
          .filter((c): c is CitationRow => Boolean(c))
          .map((c) => parseMagnitude(typeof c.cited_value === 'object' ? JSON.stringify(c.cited_value) : String(c.cited_value)))
          .filter((n): n is number => n !== null);
        if (sentenceCited.length === 0) continue; // only non-numeric citations here

        for (const tok of numberTokens(sentence)) {
          if (!isMaterialNumeral(tok)) continue;
          const mag = parseMagnitude(tok);
          if (mag === null) continue;
          if (!sentenceCited.some((c) => magnitudeMatches(mag, c, tokenAssertsSign(tok)))) {
            violations.push({
              where: surf.where, kind: 'number_unaccounted',
              value: mag, token: tok.trim(), keys, sentence_cited: sentenceCited,
            });
          }
        }
      }
    }
  }
  return violations.length > 0
    ? { rule_key: 'R-04', mode: 'BLOCK', outcome: 'blocked', detail: { violations } }
    : { rule_key: 'R-04', mode: 'BLOCK', outcome: 'passed', detail: {} };
}

/** Best-effort: find a magnitude in a flat payload closest to the cited one (drift probe). */
function findPayloadMagnitude(payload: Record<string, unknown>, cited: number): number | null {
  let best: number | null = null;
  for (const v of Object.values(payload)) {
    const m = typeof v === 'number' ? v : parseMagnitude(String(v));
    if (m === null) continue;
    if (best === null || Math.abs(m - cited) < Math.abs(best - cited)) best = m;
  }
  return best;
}

// R-05 — banned phrases (BLOCK). Normalized substring match across every surface.
export function r05(ctx: RuleContext, banned: string[]): RuleResult {
  const hay = textSurfaces(ctx).map((s) => normalizePhrase(s.body)).join('  ');
  const hits = banned.filter((p) => p && hay.includes(normalizePhrase(p)));
  return hits.length > 0
    ? { rule_key: 'R-05', mode: 'BLOCK', outcome: 'blocked', detail: { hits } }
    : { rule_key: 'R-05', mode: 'BLOCK', outcome: 'passed', detail: {} };
}

// R-06 — no advice / stretched metric framed as risk (WARN, NOTE/TAKE only).
export async function r06(ctx: RuleContext, llm?: RuleLlm): Promise<RuleResult> {
  if (ctx.content_type !== 'NOTE' && ctx.content_type !== 'TAKE') {
    return { rule_key: 'R-06', mode: 'WARN', outcome: 'passed', detail: { skipped: 'not a note/take' } };
  }
  const flagged: string[] = [];
  for (const surf of textSurfaces(ctx)) {
    for (const sentence of splitSentences(surf.body)) {
      // deterministic trigger: extreme payout/PE/leverage language
      if (/payout\s*(ratio)?\s*(of\s*)?(1[0-9]\d|[2-9]\d\d)\s*%/i.test(sentence) || /\bp\/?e\s*(ratio\s*)?(of\s*)?(6[1-9]|[7-9]\d|\d{3,})/i.test(sentence)) {
        if (llm?.framingIsRisk) {
          const ok = await llm.framingIsRisk(sentence).catch(() => true);
          if (!ok) flagged.push(sentence.slice(0, 160));
        } else {
          flagged.push(sentence.slice(0, 160));
        }
      }
    }
  }
  return flagged.length > 0
    ? { rule_key: 'R-06', mode: 'WARN', outcome: 'warned', detail: { flagged } }
    : { rule_key: 'R-06', mode: 'WARN', outcome: 'passed', detail: {} };
}

// R-07 — corrections append a visible note (AUTO). Rules-time status only: an OPEN
// correction flag on a cited object blocks re-publish (surfaced; publish path enforces).
export function r07(ctx: RuleContext): RuleResult {
  return ctx.open_correction
    ? { rule_key: 'R-07', mode: 'AUTO', outcome: 'warned', detail: { open_correction: true } }
    : { rule_key: 'R-07', mode: 'AUTO', outcome: 'passed', detail: {} };
}

// R-08 — retraction keeps the URL (AUTO). A publishing invariant, not a submit-time check.
export function r08(): RuleResult {
  return { rule_key: 'R-08', mode: 'AUTO', outcome: 'passed', detail: {} };
}

// R-09 — premium cut after ≥1 data block (WARN, premium only).
export function r09(ctx: RuleContext): RuleResult {
  if (!ctx.is_premium) return { rule_key: 'R-09', mode: 'WARN', outcome: 'passed', detail: { skipped: 'not premium' } };
  const cutIdx = ctx.blocks.findIndex((b) => b.gated);
  if (cutIdx < 0) return { rule_key: 'R-09', mode: 'WARN', outcome: 'passed', detail: { note: 'no paywall cut' } };
  const dataBefore = ctx.blocks.slice(0, cutIdx).some((b) => b.bound_object_id !== null);
  return dataBefore
    ? { rule_key: 'R-09', mode: 'WARN', outcome: 'passed', detail: {} }
    : { rule_key: 'R-09', mode: 'WARN', outcome: 'warned', detail: { reason: 'no data block above the paywall cut' } };
}

// R-10 — headline ceiling (AUTO_FIX → BLOCK on second failure).
export async function r10(headline: string, opts: EngineOptions): Promise<{ result: RuleResult; headline: string }> {
  const max = opts.headlineMaxChars ?? 90;
  const bad = (h: string) => h.length > max || CLICKBAIT.test(h);
  if (!bad(headline)) return { result: { rule_key: 'R-10', mode: 'AUTO_FIX', outcome: 'passed', detail: {} }, headline };

  if (opts.llm?.rewriteHeadline) {
    const rewritten = (await opts.llm.rewriteHeadline(headline, max).catch(() => headline)).trim();
    if (!bad(rewritten)) {
      return { result: { rule_key: 'R-10', mode: 'AUTO_FIX', outcome: 'passed_after_fix', detail: { from: headline, to: rewritten } }, headline: rewritten };
    }
  }
  // Second failure → BLOCK (03 §8.2).
  return { result: { rule_key: 'R-10', mode: 'BLOCK', outcome: 'blocked', detail: { headline, max, reason: headline.length > max ? 'too_long' : 'clickbait' } }, headline };
}

/**
 * R-01..R-10 as pure functions (P3.2, 03 §8.2). Each returns a RuleResult; the engine
 * (engine.ts) sequences them, threads the R-10 headline rewrite, and derives pass /
 * auto-publish eligibility. The two LLM-assisted rules (R-06, R-10) take the injected
 * RuleLlm seam so the deterministic majority stays synchronously testable.
 */

import type { CitationRow, EngineOptions, RuleContext, RuleLlm, RuleResult } from './types.js';
import { hasNumber, markersIn, normalizePhrase, parseMagnitude, relDiff, splitSentences } from './text.js';

const DRIFT_TOL = 0.005; // 0.5% — R-04 block threshold
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

// R-03 — source or silence / cite what you claim (BLOCK). Every number-bearing sentence
// carries a [cN]; every marker resolves to a citation whose object is VERIFIED right now.
// (The ≥2 lineage-roots requirement is an auto-publish gate, computed in the engine — NOT
// a block here, per Revision #5.)
export function r03(ctx: RuleContext): RuleResult {
  const byKey = citationByKey(ctx);
  const violations: Record<string, unknown>[] = [];
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
        if (cit.object_state !== 'VERIFIED') {
          violations.push({ where: surf.where, kind: 'cited_object_not_verified', key, state: cit.object_state ?? 'missing' });
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
const MAG_RE = /-?\d[\d,]*(?:\.\d+)?\s*(?:%|bn|billion|mn|m|million|k|thousand)?/gi;

export function r04(ctx: RuleContext): RuleResult {
  const byKey = citationByKey(ctx);
  const violations: Record<string, unknown>[] = [];

  // Headline: every magnitude must match SOME citation's frozen value within 0.5%
  // (the headline carries no marker, but its numbers must still be lake-backed).
  const citedMags = ctx.citations
    .map((c) => parseMagnitude(typeof c.cited_value === 'object' ? JSON.stringify(c.cited_value) : String(c.cited_value)))
    .filter((n): n is number => n !== null);
  for (const tok of ctx.headline.match(MAG_RE) ?? []) {
    const mag = parseMagnitude(tok);
    if (mag === null) continue;
    if (/^\d{4}$/.test(tok.trim()) && Number(tok) >= 1990 && Number(tok) <= 2099) continue; // a year
    if (!citedMags.some((c) => relDiff(mag, c) <= DRIFT_TOL)) {
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
        const mags = (sentence.match(/-?\d[\d,]*(?:\.\d+)?\s*(?:%|bn|billion|mn|m|million|k|thousand)?/gi) ?? [])
          .map(parseMagnitude)
          .filter((n): n is number => n !== null);
        const near = mags.some((m) => relDiff(m, citedMag) <= DRIFT_TOL);
        if (!near) {
          violations.push({ where: surf.where, kind: 'number_mismatch', key, cited: citedMag, sentence_mags: mags });
        }
        // Drift vs live payload: if the payload still carries the cited key/value and it moved.
        if (cit.object_payload && cit.cited_value !== null && typeof cit.cited_value !== 'object') {
          const liveMag = findPayloadMagnitude(cit.object_payload, citedMag);
          if (liveMag !== null && relDiff(liveMag, citedMag) > DRIFT_TOL) {
            violations.push({ where: surf.where, kind: 'lake_drift', key, cited: citedMag, live: liveMag });
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

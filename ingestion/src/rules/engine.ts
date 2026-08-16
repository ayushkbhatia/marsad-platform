/**
 * Rules engine orchestrator (P3.2, 03 §8). Runs R-01..R-10 in order, threads the R-10
 * headline rewrite, and derives the two verdicts the pipeline needs:
 *   - passed: no rule BLOCKED (→ approval, or auto-publish if eligible)
 *   - autoPublishEligible: passed AND R-03 lineage ≥2 roots AND no open correction
 *     (Revision #5 — a single-root wire is NOT blocked, it just drops to human approval)
 *
 * PURE: the worker's rules handler assembles the RuleContext (DB reads) and persists the
 * results to ops.rule_violations + stamps content_items.rules_passed_version; this function
 * only decides. Same code path for agent + human content.
 */

import type { EngineOptions, EngineResult, RuleContext, RuleResult } from './types.js';
import { r01, r02, r03, r04, r05, r06, r07, r08, r09, r10 } from './rules.js';

const AUTO_WORD_CAP_DEFAULT = 40;

export async function runRules(ctx: RuleContext, opts: EngineOptions): Promise<EngineResult> {
  const results: RuleResult[] = [];

  results.push(r01(ctx));
  results.push(r02(ctx));
  results.push(r03(ctx, opts));
  results.push(r04(ctx));
  results.push(r05(ctx, opts.bannedPhrases));
  results.push(await r06(ctx, opts.llm));
  results.push(r07(ctx));
  results.push(r08());
  results.push(r09(ctx));

  const r10out = await r10(ctx.headline, opts);
  results.push(r10out.result);
  const finalHeadline = r10out.headline;

  const passed = !results.some((r) => r.outcome === 'blocked');

  // Auto-publish eligibility (03 §7.3 + Revision #5), only meaningful for a passing wire:
  //   TPL-01 + word_count ≤ cap + ≥2 distinct lineage roots + no open correction.
  const wordCap = opts.autoWordCap ?? AUTO_WORD_CAP_DEFAULT;
  const autoPublishEligible =
    passed &&
    ctx.template_key === 'TPL-01' &&
    ctx.word_count <= wordCap &&
    ctx.distinct_lineage_roots >= 2 &&
    !ctx.open_correction;

  return { results, passed, autoPublishEligible, finalHeadline };
}

/** Rules whose BLOCK sends the piece back to DRAFT (the retry-loop set). WARN/AUTO never do. */
export function blockingFailures(res: EngineResult): RuleResult[] {
  return res.results.filter((r) => r.mode === 'BLOCK' && r.outcome === 'blocked');
}

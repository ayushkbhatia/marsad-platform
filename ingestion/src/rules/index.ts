/** Rules engine public surface (P3.2). */
export { runRules, blockingFailures } from './engine.js';
export {
  splitSentences, markersIn, hasNumber, isMaterialNumeral,
  numberTokens, isYearToken, parseMagnitude, relDiff,
  normalizePhrase, NUMBER_TOKEN, DRIFT_TOL,
} from './text.js';
export { autoMarkNumbers } from './automark.js';
export type { AutoMarkCite, AutoMarkResult } from './automark.js';
export type {
  RuleContext, CitationRow, BlockRow, RuleResult, EngineOptions, EngineResult, RuleLlm, Outcome,
} from './types.js';

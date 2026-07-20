/** Rules engine public surface (P3.2). */
export { runRules, blockingFailures } from './engine.js';
export {
  splitSentences, markersIn, hasNumber, parseMagnitude, relDiff, normalizePhrase, NUMBER_TOKEN,
} from './text.js';
export { autoMarkNumbers } from './automark.js';
export type { AutoMarkCite, AutoMarkResult } from './automark.js';
export type {
  RuleContext, CitationRow, BlockRow, RuleResult, EngineOptions, EngineResult, RuleLlm, Outcome,
} from './types.js';

/**
 * Package entry point for `marsad-ingestion`.
 *
 * The worker imports EXACTLY ONE symbol from here — createIngestionRuntime — via a dynamic
 * import in worker/src/handlers/runtime-wiring.ts (CONTRACT §1). The rest of the surface
 * (core framework, adapters, lake) is re-exported for direct use by CLI tools (replay) and
 * tests.
 */

export {
  createIngestionRuntime,
  type IngestionRuntime,
  type CreateIngestionRuntimeDeps,
  type RunTaskResult,
  type StagedKey,
} from './runtime.js';

export { ADAPTERS } from './adapters/index.js';
export * from './core/index.js';

// DIVIDEND.EXDATE dated-declaration normalization (03 §6/§7) — the PURE core the
// dividend-declared producer (scripts/researchers/dividend-declared.mjs) imports to turn a
// DIVIDEND filing's extracted facts into a NormalizedDividend + lake-object payload + reader row.
export {
  extractDividend,
  normalizeDivType,
  normalizeCurrency,
  venueCurrency,
  parseIsoDate,
  toDps,
  deriveFiscalRef,
  dividendNaturalKey,
  disclosureRoot,
  buildLineageRoots,
  dividendObjectPayload,
  dividendUpsertRow,
  REGISTRAR_RANK,
  EXCHANGE_RANK,
  AGGREGATOR_RANK,
} from './lake/dividend-declared.js';
export type {
  FilingAiDividend,
  DividendFilingRow,
  LineageRoot,
  LineageResult,
  DividendObjectPayload,
  DividendUpsertRow,
} from './lake/dividend-declared.js';

// P3 newsroom: the provider-agnostic LLM gateway (03 §1), ported worker-side so
// the pipeline handlers reach chatComplete via the package root (the ingestion
// exports map is root-only). Same contract as src/lib/llm/ — the Next app keeps
// its own copy for reader-AI; convergence tracked in BUILD-STATUS §7.
export {
  chatComplete,
  resolveRoleTargets,
  parseModelSpec,
  estimateCostUsd,
  AGENT_ROLES,
  PROVIDER_NAMES,
  LlmConfigError,
  LlmJsonError,
  LlmRequestError,
  LlmUnavailableError,
} from './llm/index.js';
export type {
  AgentRole,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
  LlmRunRow,
  ModelTarget,
  ProviderName,
  RunContext,
} from './llm/index.js';

// P3.2 rules engine (03 §8) — R-01..R-10 as pure functions + the runRules orchestrator.
// The worker's rules handler assembles a RuleContext and calls runRules; same code path
// will serve the Desk "RUN RULES NOW" (P4) via a worker RPC.
export { runRules, blockingFailures, splitSentences, markersIn, parseMagnitude, normalizePhrase, autoMarkNumbers } from './rules/index.js';
// Shared number primitives — the worker's fit stage (PD.8) reuses R-03/R-04's ONE
// definition of "what is a number" and its 0.5% tolerance rather than redeclaring them.
export { numberTokens, isYearToken, relDiff, NUMBER_TOKEN, DRIFT_TOL } from './rules/index.js';
export type {
  RuleContext, CitationRow, BlockRow, RuleResult, EngineOptions, EngineResult, RuleLlm, AutoMarkCite, AutoMarkResult,
} from './rules/index.js';

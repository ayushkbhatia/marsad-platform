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

// PD.3 — the 61 block payload schemas. They live HERE, not in the Next app, because the worker's
// fit stage is the enforcing consumer and worker/tsconfig has rootDir:"src" — it cannot compile
// files outside its own tree, so a relative import across the package boundary is impossible.
// The web app has no runtime consumer, so there is no second copy to drift (unlike src/lib/llm).
export {
  BLOCK_PAYLOAD_SCHEMAS, safeParseBlockPayload,
  BLOCK_BINDING_EXCEPTIONS, BLOCK_BINDING_STRICTER_THAN_REGISTRY,
  CHART_SHAPES, SHAPE_BY_BLOCK, CHART_QUESTION_BY_SHAPE,
} from './blocks/index.js';
export type { BlockCode } from './blocks/codes.js';

// PR.1 — the evidence-brief contract. Same reasoning as the block schemas above: the WORKER's
// research stage is the producing consumer and cannot compile outside its own tree, so the shared
// types live in this package. Steps 1-2 are pure — no SQL, no I/O — so they are importable from
// anywhere and testable with the network down.
export {
  BUNDLE_CONTRACT_VERSION, Freshness, ObjectState, Volatility, RebindKey, FactPeriod, FactFormat,
  BoundFact, BoundRef, UnboundFact, Evidence, EvidenceLeg, EvidenceBrief,
} from './research/envelope.js';
export {
  LEG_KEYS, LEG_STATUSES, LEG_REASONS, TOLERANCE_DAYS, isLegKey,
  STATUSES_ALLOWING_BOUND_FACTS, STATUSES_ALLOWING_ANY_EVIDENCE,
} from './research/types.js';
export type { LegKey, LegStatus, LegReason } from './research/types.js';
export {
  RESOLVABLE_FIELD, FIELD_FORMAT, isResolvableField, formatFor, isLineItemField,
} from './research/lexicon.js';
export { verifyBundle, resolveField, valuesAgree, isStrictUuidV4 } from './research/verify.js';
export type { ObjectSnapshot, ResolveFailure, ResolveFailureCode } from './research/verify.js';
export { assembleBrief, coversAllLegs, EMITTED_LEGS } from './research/assemble.js';
export type { AssembleOptions } from './research/assemble.js';

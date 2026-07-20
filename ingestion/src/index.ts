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

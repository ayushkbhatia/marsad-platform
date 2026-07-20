/**
 * LLM gateway public surface. Callers import from "@/lib/llm" (Next) or via
 * the worker's tsconfig path alias — and use chatComplete only.
 */

export { chatComplete, applyBudgetDemotion } from "./gateway.js";
export { resolveRoleTargets, parseModelSpec, getProviderConfig } from "./providers.js";
export { DEFAULT_MODELS, DEFAULT_FALLBACKS, envKeyForRole } from "./roles.js";
export { PRICE_TABLE, estimateCostUsd } from "./pricing.js";
export { recordLlmRun } from "./accounting.js";
export {
  AGENT_ROLES,
  PROVIDER_NAMES,
  LlmConfigError,
  LlmJsonError,
  LlmRequestError,
  LlmUnavailableError,
} from "./types.js";
export type {
  AgentRole,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
  EnvBag,
  LlmRunRow,
  ModelTarget,
  ProviderConfig,
  ProviderName,
  ResolvedTarget,
  RunContext,
} from "./types.js";

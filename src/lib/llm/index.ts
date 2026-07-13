/**
 * LLM gateway public surface. Callers import from "@/lib/llm" (Next) or via
 * the worker's tsconfig path alias — and use chatComplete only.
 */

export { chatComplete } from "./gateway";
export { resolveRoleTargets, parseModelSpec, getProviderConfig } from "./providers";
export { DEFAULT_MODELS, DEFAULT_FALLBACKS, envKeyForRole } from "./roles";
export { PRICE_TABLE, estimateCostUsd } from "./pricing";
export { recordLlmRun } from "./accounting";
export {
  AGENT_ROLES,
  PROVIDER_NAMES,
  LlmConfigError,
  LlmJsonError,
  LlmRequestError,
  LlmUnavailableError,
} from "./types";
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
} from "./types";

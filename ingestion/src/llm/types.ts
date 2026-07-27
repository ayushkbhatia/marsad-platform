/**
 * LLM gateway shared types.
 *
 * Canonical spec: docs/architecture/03-agent-newsroom.md §1 (+ Revisions), which
 * 06-infra-cost.md §9 defers to. The gateway speaks two wire formats over plain
 * fetch — OpenAI chat-completions (OpenRouter, Ollama, any compatible base URL)
 * and the Anthropic Messages API — translated to/from the common shape below.
 * Zero provider SDKs anywhere.
 */

export type ProviderName = "anthropic" | "openrouter" | "ollama" | "huggingface";

export const PROVIDER_NAMES: readonly ProviderName[] = [
  "anthropic",
  "openrouter",
  "ollama",
  "huggingface",
] as const;

/** Agent roles per 03 §1.3. Pipeline code names a role, never a model/provider. */
export type AgentRole =
  | "classifier" // materiality triage; also serves R-06 rules-assist yes/no checks
  | "writer" // draft generation
  | "editor" // edit pass + template fitting; also serves R-10 headline rewrites
  | "summarizer" // filing/transcript summaries, Wire Brief lead
  | "analyst_take" // TPL-08 premium takes (highest tier)
  | "embedder"; // reserved: resolves to in-process ONNX / OpenRouter, NOT this chat gateway

export const AGENT_ROLES: readonly AgentRole[] = [
  "classifier",
  "writer",
  "editor",
  "summarizer",
  "analyst_take",
  "embedder",
] as const;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Accounting is mandatory — no anonymous spend (03 §1.3). */
export interface RunContext {
  agentId: string; // e.g. "WRITER-2"
  pipelineItemId?: string; // uuid of ops.pipeline_items row, when in-pipeline
  purpose: string; // e.g. "draft:TPL-04:2222-q2-earnings"
}

export interface ChatOptions {
  /** Convenience system prompt; merged with any system-role messages. */
  system?: string;
  /** Default 1024. Always sent — Anthropic requires max_tokens. */
  maxTokens?: number;
  /** Passed through only when set; some providers ignore it. */
  temperature?: number;
  /**
   * JSON mode. `true` → response_format json_object (OpenRouter/Ollama).
   * An object → response_format json_schema. On the Anthropic path
   * response_format does not exist, so a strict "reply ONLY with JSON"
   * system instruction is used instead (03 Revisions, compat caveats).
   * One repair round-trip on parse failure; second failure throws LlmJsonError.
   */
  json?: boolean | Record<string, unknown>;
  /** Per-call override of LLM_TIMEOUT_MS (default 60_000 ms). */
  timeoutMs?: number;
  /**
   * Budget-ladder demotion (03 §1.7, P3.4). When true — the worker sets it from
   * ops.newsroom_budget_state() ≠ 'ok' — the gateway DROPS the premium primary target so the
   * role runs on its cheaper fallback chain. Never strands a role: ignored when the role has
   * no fallback configured. Undefined/false (the 'ok' path) leaves target resolution unchanged.
   */
  budgetDegraded?: boolean;
  runContext: RunContext;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  /** Present when `json` was requested and parsing succeeded. */
  parsed?: unknown;
  provider: ProviderName;
  model: string;
  usage: ChatUsage;
  costUsd: number; // from pricing.ts; 0 for local
  latencyMs: number;
  degraded: boolean; // true when a fallback target served the call
  llmRunId: string; // id of the ops.llm_runs row (generated client-side)
}

/** A parsed `provider:model` spec, e.g. "openrouter:nousresearch/hermes-4-405b". */
export interface ModelTarget {
  provider: ProviderName;
  model: string;
}

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string; // no trailing slash
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

export interface ResolvedTarget extends ModelTarget {
  config: ProviderConfig;
}

/** Env bag type so providers.ts stays a pure, unit-testable function of its input. */
export type EnvBag = Record<string, string | undefined>;

/** Row shape for ops.llm_runs (03 §1.7 DDL, moved to ops per Revision 4). */
export interface LlmRunRow {
  id: string;
  agent_id: string;
  pipeline_item_id: string | null;
  role: string;
  provider: string;
  model: string;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  degraded: boolean;
  error: string | null;
}

// ── Typed errors (03 §1.6) ──────────────────────────────────────────────────

/** Misconfiguration: bad role spec, unknown provider, no configured target. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Non-retryable provider rejection (4xx other than 429 — "it's our bug"). */
export class LlmRequestError extends Error {
  readonly status: number;
  readonly provider: ProviderName;
  readonly model: string;
  readonly body: string;
  constructor(provider: ProviderName, model: string, status: number, body: string) {
    super(`LLM request rejected by ${provider}:${model} (HTTP ${status}): ${body.slice(0, 500)}`);
    this.name = "LlmRequestError";
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.body = body;
  }
}

/** Every target in the role's chain failed. Pipeline schedules a retry (infra). */
export class LlmUnavailableError extends Error {
  readonly role: AgentRole;
  readonly attempts: { provider: ProviderName; model: string; reason: string }[];
  constructor(
    role: AgentRole,
    attempts: { provider: ProviderName; model: string; reason: string }[],
  ) {
    super(
      `All LLM targets exhausted for role "${role}": ` +
        attempts.map((a) => `${a.provider}:${a.model} → ${a.reason}`).join("; "),
    );
    this.name = "LlmUnavailableError";
    this.role = role;
    this.attempts = attempts;
  }
}

/** JSON contract failed after the single repair attempt (quality severity). */
export class LlmJsonError extends Error {
  readonly rawText: string;
  readonly provider: ProviderName;
  readonly model: string;
  constructor(provider: ProviderName, model: string, rawText: string, parseError: string) {
    super(`LLM JSON contract failed after repair attempt on ${provider}:${model}: ${parseError}`);
    this.name = "LlmJsonError";
    this.rawText = rawText;
    this.provider = provider;
    this.model = model;
  }
}

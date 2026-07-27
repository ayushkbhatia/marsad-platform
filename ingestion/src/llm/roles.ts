/**
 * Role → default model map per provider tier (03 §1.5, overridden by §15.2).
 *
 * Launch default posture is Scenario B — open-weights via OpenRouter for every
 * role (06 §7.1, cheapest-possible is locked). The hybrid Hermes/Sonnet posture
 * of 03 §1.5 is the first quality-triggered upgrade (rules-fail > 15% or owner
 * send-back > 30%), applied by editing LLM_ROLE_* env vars — never code.
 *
 * "rules-assist" is not a separate role: R-06 framing checks run as
 * `classifier`, R-10 headline rewrites run as `editor` (03 §8.2).
 */

import type { AgentRole, ProviderName } from "./types.js";

/** Default model per (provider, role) used when LLM_ROLE_<ROLE> is not set. */
export const DEFAULT_MODELS: Record<ProviderName, Record<AgentRole, string>> = {
  openrouter: {
    classifier: "nousresearch/hermes-3-llama-3.1-70b",
    writer: "nousresearch/hermes-4-405b",
    editor: "nousresearch/hermes-3-llama-3.1-70b",
    summarizer: "nousresearch/hermes-3-llama-3.1-70b",
    analyst_take: "nousresearch/hermes-4-405b",
    embedder: "", // embeddings do not route through the chat gateway (06 Revisions #7)
  },
  anthropic: {
    classifier: "claude-haiku-4-5",
    writer: "claude-sonnet-4-6",
    editor: "claude-haiku-4-5",
    summarizer: "claude-haiku-4-5",
    analyst_take: "claude-sonnet-4-6",
    embedder: "", // Anthropic has no embeddings endpoint
  },
  ollama: {
    classifier: "qwen2.5:14b-instruct",
    writer: "llama3.3:70b",
    editor: "qwen2.5:14b-instruct",
    summarizer: "qwen2.5:14b-instruct",
    analyst_take: "llama3.3:70b",
    embedder: "",
  },
  /**
   * HuggingFace Inference Providers (PE.8). Every id here is PROVIDER-PINNED (`model:provider`)
   * and that is not stylistic — it is required.
   *
   * The router's default routing policy is `:fastest`, and `supports_structured_output` varies by
   * (model, provider) for the SAME model: MiniMax-M3 and Kimi-K2.6 are `true` on Together and
   * `false` on Novita / Fireworks / DeepInfra. Our pipeline depends on strict JSON, so an
   * unpinned id would work until the router silently rerouted us to an upstream that cannot honour
   * `response_format` — a failure that looks like a model regression, not a routing change.
   *
   * Prices below are the router's published per-Mtok rates (HF bills at provider rates, no
   * markup) and are mirrored in pricing.ts — update both together or the budget ladder lies.
   */
  huggingface: {
    // Verified live against GET /v1/models/{id} on 2026-07-27 — every pin below is a provider
    // whose `supports_structured_output` is TRUE. The check is not academic: on gpt-oss-20b the
    // FASTEST upstream (groq, 693 tok/s) reports it FALSE, so the router's default `:fastest`
    // policy would route strict-JSON work to the one provider that cannot do it.
    // Re-verify with: node scripts/llm/verify-hf-pins.mjs
    //
    // gpt-oss-20b @ novita: $0.04/$0.15, JSON ✓, 143 tok/s. The cheap workhorse.
    classifier: "openai/gpt-oss-20b:novita",
    // Qwen3-235B @ NOVITA, not deepinfra: same price ($0.09/$0.58 vs $0.09/$0.55) but deepinfra
    // reports supports_structured_output=FALSE and is 2.7x slower (18 vs 48 tok/s).
    writer: "Qwen/Qwen3-235B-A22B-Instruct-2507:novita",
    editor: "openai/gpt-oss-20b:novita",
    summarizer: "openai/gpt-oss-20b:novita",
    analyst_take: "zai-org/GLM-4.6:deepinfra", // JSON ✓, $0.50/$2.00 — sole live provider

    // No /v1/embeddings on the auto-router — it is chat-completions only. Embeddings need a
    // provider-specific route or local ONNX; the gateway throws for this role regardless.
    embedder: "",
  },
};

/**
 * Default fallback chains when LLM_ROLE_<ROLE>_FALLBACK is not set.
 * Per 03 Revisions, chains must span two model families (e.g. Hermes →
 * Llama-3.3 → Haiku) so a family-wide outage or regression cannot stall a role.
 * Targets whose provider has no API key configured are skipped at call time.
 */
export const DEFAULT_FALLBACKS: Record<AgentRole, string[]> = {
  classifier: [
    "openrouter:meta-llama/llama-3.3-70b-instruct",
    "anthropic:claude-haiku-4-5",
  ],
  writer: [
    "openrouter:meta-llama/llama-3.3-70b-instruct",
    "anthropic:claude-sonnet-4-6",
  ],
  editor: [
    "openrouter:meta-llama/llama-3.3-70b-instruct",
    "anthropic:claude-haiku-4-5",
  ],
  summarizer: [
    "openrouter:meta-llama/llama-3.3-70b-instruct",
    "anthropic:claude-haiku-4-5",
  ],
  analyst_take: [
    "anthropic:claude-sonnet-4-6",
    "openrouter:meta-llama/llama-3.3-70b-instruct",
  ],
  embedder: [],
};

/** LLM_ROLE_ANALYST_TAKE, LLM_ROLE_CLASSIFIER, ... */
export function envKeyForRole(role: AgentRole): string {
  return `LLM_ROLE_${role.toUpperCase()}`;
}

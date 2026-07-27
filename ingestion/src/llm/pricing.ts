/**
 * Static $/Mtok price table used for cost accounting (03 §1.7).
 *
 * The owner edits this file when prices move — it is deliberately a dumb table,
 * not an API lookup, so the cost column in ops.llm_runs is deterministic and
 * auditable. Prices are list prices as of 2026-07 (03 §11); OpenRouter cards
 * should be re-verified when models are swapped. Unknown models are charged a
 * PESSIMISTIC fallback (never $0) so the budget ladder cannot read new spend as free.
 */

import type { ChatUsage, ProviderName } from "./types.js";

interface ModelPrice {
  inputPerMtok: number; // USD per 1M input tokens
  outputPerMtok: number; // USD per 1M output tokens
}

/** Keyed by model id as it appears in the provider:model spec. */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  // ── Anthropic list prices (03 §11) ──
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-sonnet-5": { inputPerMtok: 2, outputPerMtok: 10 }, // intro pricing through 2026-08-31
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },

  // ── OpenRouter open-weights (≈ prices; verify current OpenRouter card) ──
  "nousresearch/hermes-3-llama-3.1-70b": { inputPerMtok: 0.12, outputPerMtok: 0.3 },
  "nousresearch/hermes-4-405b": { inputPerMtok: 1.0, outputPerMtok: 1.0 },
  "meta-llama/llama-3.3-70b-instruct": { inputPerMtok: 0.12, outputPerMtok: 0.3 },
  "qwen/qwen-2.5-72b-instruct": { inputPerMtok: 0.13, outputPerMtok: 0.4 },

  // ── HuggingFace Inference Providers (PE.8) ──
  // HF bills at the upstream provider's rate with no markup, so these are the provider's own
  // prices. Keyed WITHOUT the ":provider" pin — normaliseModelId strips it before lookup.
  // Same-model prices differ per provider, so these track the pins chosen in roles.ts.
  "openai/gpt-oss-20b": { inputPerMtok: 0.04, outputPerMtok: 0.15 }, // novita
  "openai/gpt-oss-120b": { inputPerMtok: 0.05, outputPerMtok: 0.25 }, // novita
  "Qwen/Qwen3-235B-A22B-Instruct-2507": { inputPerMtok: 0.09, outputPerMtok: 0.58 }, // novita
  "Qwen/Qwen3-4B-Instruct-2507": { inputPerMtok: 0.01, outputPerMtok: 0.03 }, // nscale
  "zai-org/GLM-4.6": { inputPerMtok: 0.5, outputPerMtok: 2.0 }, // deepinfra
};

/**
 * Fallback rate for a model with no PRICE_TABLE entry.
 *
 * It used to be $0, and that was the dangerous direction: `ops.newsroom_budget_state` sums
 * `cost_usd`, so an unpriced model made the budget ladder read zero spend — i.e. the ladder
 * stopped working at exactly the moment a new model started costing money, and the only signal
 * was a console warning nobody reads. Charging a deliberately PESSIMISTIC rate instead means an
 * unpriced model degrades the ladder toward caution (early demotion to the cheaper chain) rather
 * than toward blindness. Over-counting is recoverable; under-counting is not.
 *
 * Set at roughly Sonnet-tier so it is never an under-estimate for an open-weights model.
 */
const UNPRICED_FALLBACK: ModelPrice = { inputPerMtok: 3, outputPerMtok: 15 };

/**
 * Strip a HuggingFace provider pin so "openai/gpt-oss-20b:novita" prices as "openai/gpt-oss-20b".
 * Scoped to huggingface ON PURPOSE — Ollama model tags legitimately contain a colon
 * ("qwen2.5:14b-instruct"), and stripping there would price the wrong model.
 */
function normaliseModelId(provider: ProviderName, model: string): string {
  if (provider !== "huggingface") return model;
  const idx = model.lastIndexOf(":");
  return idx > 0 ? model.slice(0, idx) : model;
}

const warnedUnknown = new Set<string>();

/**
 * Cost estimate for one call. Local (ollama) is always $0 regardless of model —
 * the API is free; electricity is the owner's problem (03 §11).
 */
export function estimateCostUsd(
  provider: ProviderName,
  model: string,
  usage: ChatUsage,
): number {
  if (provider === "ollama") return 0;
  const id = normaliseModelId(provider, model);
  let price = PRICE_TABLE[id];
  if (!price) {
    if (!warnedUnknown.has(id)) {
      warnedUnknown.add(id);
      console.warn(
        `[llm/pricing] no price entry for "${id}" — charging the PESSIMISTIC fallback ` +
          `($${UNPRICED_FALLBACK.inputPerMtok}/$${UNPRICED_FALLBACK.outputPerMtok} per Mtok) so the ` +
          `budget ladder cannot read this as free spend. Add it to PRICE_TABLE.`,
      );
    }
    price = UNPRICED_FALLBACK;
  }
  const cost =
    (usage.inputTokens / 1_000_000) * price.inputPerMtok +
    (usage.outputTokens / 1_000_000) * price.outputPerMtok;
  // numeric(10,6) in ops.llm_runs — round to 6 dp to match the column.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

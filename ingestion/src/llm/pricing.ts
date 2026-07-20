/**
 * Static $/Mtok price table used for cost accounting (03 §1.7).
 *
 * The owner edits this file when prices move — it is deliberately a dumb table,
 * not an API lookup, so the cost column in ops.llm_runs is deterministic and
 * auditable. Prices are list prices as of 2026-07 (03 §11); OpenRouter cards
 * should be re-verified when models are swapped. Unknown models cost $0 and log
 * a one-time warning so silent spend is at least visible in worker logs.
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
};

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
  const price = PRICE_TABLE[model];
  if (!price) {
    if (!warnedUnknown.has(model)) {
      warnedUnknown.add(model);
      console.warn(
        `[llm/pricing] no price entry for "${model}" — recording cost_usd=0. Add it to PRICE_TABLE.`,
      );
    }
    return 0;
  }
  const cost =
    (usage.inputTokens / 1_000_000) * price.inputPerMtok +
    (usage.outputTokens / 1_000_000) * price.outputPerMtok;
  // numeric(10,6) in ops.llm_runs — round to 6 dp to match the column.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Env parsing → resolved provider/model targets per role (03 §1.4).
 *
 * Every function here is a pure function of an env bag so it is unit-testable
 * without touching process.env. Header assembly is the ONLY provider-conditional
 * code in the module, per the gateway design.
 */

import { DEFAULT_FALLBACKS, DEFAULT_MODELS, envKeyForRole } from "./roles.js";
import {
  type AgentRole,
  type EnvBag,
  LlmConfigError,
  PROVIDER_NAMES,
  type ProviderConfig,
  type ProviderName,
  type ModelTarget,
  type ResolvedTarget,
} from "./types.js";

const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1",
  // HuggingFace Inference Providers — the OpenAI-compatible AUTO-ROUTER. The gateway appends
  // `/chat/completions`, giving `.../v1/chat/completions`, which is correct for this endpoint.
  //
  // ⚠️ NEVER point this at a provider-specific route. Each upstream has its own path (Novita's is
  // `/v3/openai/chat/completions`), so rewriting the base URL to pin a provider silently 404s.
  // Pin with the MODEL string instead — "model:provider", e.g.
  //   LLM_ROLE_SUMMARIZER=huggingface:openai/gpt-oss-20b:novita
  // which works because parseModelSpec splits on the FIRST colon only, so the ":novita" suffix
  // survives into the model id and is passed to the router verbatim.
  huggingface: "https://router.huggingface.co/v1",
};

// Key aliases: 03 §1.4 uses the LLM_-prefixed names; the plain names are the
// conventional forms most tooling expects. Both are accepted; LLM_* wins.
const API_KEY_ENV: Record<ProviderName, string[]> = {
  anthropic: ["LLM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  openrouter: ["LLM_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
  ollama: ["LLM_OLLAMA_API_KEY", "OLLAMA_API_KEY"],
  huggingface: ["LLM_HUGGINGFACE_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN"],
};

const BASE_URL_ENV: Record<ProviderName, string[]> = {
  anthropic: ["LLM_ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL"],
  openrouter: ["LLM_OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL"],
  ollama: ["LLM_OLLAMA_BASE_URL", "OLLAMA_BASE_URL"],
  huggingface: ["LLM_HUGGINGFACE_BASE_URL", "HUGGINGFACE_BASE_URL"],
};

function firstEnv(env: EnvBag, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Parse a `provider:model` spec, e.g. "openrouter:nousresearch/hermes-4-405b".
 * Splits on the FIRST colon only — Ollama model tags contain colons
 * ("ollama:qwen2.5:14b-instruct").
 */
export function parseModelSpec(spec: string): ModelTarget {
  const trimmed = spec.trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0 || idx === trimmed.length - 1) {
    throw new LlmConfigError(
      `Invalid model spec "${spec}" — expected "provider:model" (e.g. "openrouter:nousresearch/hermes-4-405b")`,
    );
  }
  const provider = trimmed.slice(0, idx);
  const model = trimmed.slice(idx + 1);
  if (!isProviderName(provider)) {
    throw new LlmConfigError(
      `Unknown provider "${provider}" in spec "${spec}" — expected one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
  return { provider, model };
}

export function getProviderConfig(name: ProviderName, env: EnvBag): ProviderConfig {
  const baseUrl = (firstEnv(env, BASE_URL_ENV[name]) ?? DEFAULT_BASE_URLS[name]).replace(
    /\/+$/,
    "",
  );
  const apiKey = firstEnv(env, API_KEY_ENV[name]);

  const config: ProviderConfig = { name, baseUrl, apiKey };

  if (name === "openrouter") {
    // OpenRouter attribution headers (03 §1.4); harmless defaults.
    config.extraHeaders = {
      "HTTP-Referer": env.LLM_OPENROUTER_REFERER ?? "https://marsad.com",
      "X-Title": env.LLM_OPENROUTER_TITLE ?? "Marsad",
    };
  }
  if (name === "huggingface" && env.LLM_HUGGINGFACE_BILL_TO) {
    // Bill this call to an org / resource group rather than the token owner. Only sent when
    // configured — an empty X-HF-Bill-To is rejected, so it must not be a "harmless default".
    config.extraHeaders = { "X-HF-Bill-To": env.LLM_HUGGINGFACE_BILL_TO };
  }
  return config;
}

/** Ollama needs no key (any placeholder works); hosted providers do. */
export function isConfigured(config: ProviderConfig): boolean {
  return config.name === "ollama" || Boolean(config.apiKey);
}

/**
 * Resolve the ordered [primary, ...fallbacks] target list for a role.
 *
 * Primary: LLM_ROLE_<ROLE> if set, else LLM_PROVIDER (default "openrouter",
 * Scenario B) with that provider's default model for the role.
 * Fallbacks: LLM_ROLE_<ROLE>_FALLBACK (comma-separated specs) if set, else the
 * two-family defaults from roles.ts. Duplicates of earlier entries are dropped.
 */
export function resolveRoleTargets(
  role: AgentRole,
  env: EnvBag = process.env,
): ResolvedTarget[] {
  const roleKey = envKeyForRole(role);

  let primary: ModelTarget;
  const primarySpec = env[roleKey];
  if (primarySpec) {
    primary = parseModelSpec(primarySpec);
  } else {
    const defaultProvider = env.LLM_PROVIDER ?? "openrouter";
    if (!isProviderName(defaultProvider)) {
      throw new LlmConfigError(
        `LLM_PROVIDER="${defaultProvider}" is not one of: ${PROVIDER_NAMES.join(", ")}`,
      );
    }
    const model = DEFAULT_MODELS[defaultProvider][role];
    if (!model) {
      throw new LlmConfigError(
        `Role "${role}" has no default model for provider "${defaultProvider}" — set ${roleKey} explicitly`,
      );
    }
    primary = { provider: defaultProvider, model };
  }

  const fallbackSpecs = env[`${roleKey}_FALLBACK`]
    ? (env[`${roleKey}_FALLBACK`] as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_FALLBACKS[role];

  const targets: ModelTarget[] = [primary];
  for (const spec of fallbackSpecs) {
    const t = parseModelSpec(spec);
    if (!targets.some((x) => x.provider === t.provider && x.model === t.model)) {
      targets.push(t);
    }
  }

  return targets.map((t) => ({ ...t, config: getProviderConfig(t.provider, env) }));
}

/** Timeout envs with defaults (03 §1.4/§1.6). */
export function getTimeouts(env: EnvBag = process.env): {
  requestTimeoutMs: number;
  ollamaHealthTimeoutMs: number;
} {
  return {
    requestTimeoutMs: parsePositiveInt(env.LLM_TIMEOUT_MS, 60_000),
    ollamaHealthTimeoutMs: parsePositiveInt(env.LLM_OLLAMA_HEALTH_TIMEOUT_MS, 1_500),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The LLM gateway — the provider-swap hard requirement (03 §1, canonical).
 *
 * `chatComplete(role, messages, opts)` is the ONLY entry point. Pipeline code
 * never names a model or a provider; it names a role. Routing, fallback,
 * retry/backoff, JSON contracts, and ops.llm_runs accounting all live here.
 *
 * Wire formats (plain fetch, zero SDKs):
 *   - openrouter / ollama (any OpenAI-compatible base URL):
 *       POST {base}/chat/completions
 *   - anthropic: native Messages API, POST {base}/messages, translated to/from
 *       the common shape (max_tokens always sent — the API requires it; JSON
 *       mode is a prompt contract since response_format does not exist there).
 *
 * Failure ladder (03 §1.6):
 *   1. ollama target unreachable (health probe) → next target in chain
 *   2. 429/5xx/network/timeout → 2 retries with jitter (250ms, 1s), then next target
 *   3. chain exhausted → LlmUnavailableError (pipeline handles retry scheduling)
 *   4. JSON contract failure → one repair round-trip, then LlmJsonError
 *   Other 4xx never retries — it's our bug (LlmRequestError, fail fast).
 */

import { recordLlmRun } from "./accounting.js";
import { estimateCostUsd } from "./pricing.js";
import { getTimeouts, isConfigured, resolveRoleTargets } from "./providers.js";
import {
  type AgentRole,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatUsage,
  type EnvBag,
  LlmConfigError,
  LlmJsonError,
  LlmRequestError,
  LlmUnavailableError,
  type ResolvedTarget,
  type RunContext,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 1024;
const RETRY_DELAYS_MS = [250, 1000]; // 2 retries with jitter (03 §1.6.2)
const ANTHROPIC_VERSION = "2023-06-01";

// ── Public API ──────────────────────────────────────────────────────────────

export async function chatComplete(
  role: AgentRole,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<ChatResult> {
  if (role === "embedder") {
    // Embeddings never route through the chat gateway: no Anthropic embeddings
    // endpoint exists, and the VPS uses in-process ONNX (06 Revisions #7).
    throw new LlmConfigError(
      'Role "embedder" is not served by chatComplete — use the embeddings module (in-process ONNX / OpenRouter embeddings endpoint)',
    );
  }
  if (!opts.runContext?.agentId || !opts.runContext?.purpose) {
    throw new LlmConfigError(
      "runContext.agentId and runContext.purpose are mandatory — no anonymous LLM spend (03 §1.3)",
    );
  }
  if (messages.length === 0 && !opts.system) {
    throw new LlmConfigError("chatComplete called with no messages and no system prompt");
  }

  const env: EnvBag = process.env;
  const targets = applyBudgetDemotion(resolveRoleTargets(role, env), opts.budgetDegraded);
  const { requestTimeoutMs, ollamaHealthTimeoutMs } = getTimeouts(env);
  const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;

  const failures: { provider: ResolvedTarget["provider"]; model: string; reason: string }[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const degraded = i > 0;

    if (!isConfigured(target.config)) {
      failures.push({
        provider: target.provider,
        model: target.model,
        reason: "provider not configured (missing API key)",
      });
      continue;
    }

    // 03 §1.6.1: probe local providers cheaply before burning the full timeout.
    if (target.provider === "ollama") {
      const alive = await probeOllama(
        target.config.baseUrl,
        target.config.apiKey,
        ollamaHealthTimeoutMs,
      );
      if (!alive) {
        failures.push({
          provider: target.provider,
          model: target.model,
          reason: `health probe failed (GET ${target.config.baseUrl}/models within ${ollamaHealthTimeoutMs}ms)`,
        });
        continue;
      }
    }

    try {
      return await callTargetWithRetries(role, target, messages, opts, {
        timeoutMs,
        degraded,
      });
    } catch (err) {
      if (err instanceof LlmJsonError) {
        // Quality failure — spend already recorded inside callTargetOnce; a
        // different provider re-buying the same mistake is what §9.2 forbids.
        throw err;
      }
      if (err instanceof LlmRequestError) {
        // Our bug (4xx ≠ 429): never retried, never falls back.
        await recordFailure(role, target, opts.runContext, degraded, String(err));
        throw err;
      }
      failures.push({
        provider: target.provider,
        model: target.model,
        reason: err instanceof Error ? err.message : String(err),
      });
      await recordFailure(role, target, opts.runContext, degraded, String(err));
    }
  }

  throw new LlmUnavailableError(role, failures);
}

// ── Budget ladder (03 §1.7) ─────────────────────────────────────────────────

/**
 * Apply the budget-ladder demotion to a resolved target chain. When `degraded` is set the
 * premium PRIMARY target is dropped so the role runs on its cheaper fallback chain — but only
 * when a fallback exists, so a role with a single configured target is never stranded.
 * Pure and exported for unit testing (the network path is not).
 */
export function applyBudgetDemotion<T>(targets: T[], degraded: boolean | undefined): T[] {
  return degraded && targets.length > 1 ? targets.slice(1) : targets;
}

// ── Per-target retry loop ───────────────────────────────────────────────────

interface CallSettings {
  timeoutMs: number;
  degraded: boolean;
}

async function callTargetWithRetries(
  role: AgentRole,
  target: ResolvedTarget,
  messages: ChatMessage[],
  opts: ChatOptions,
  settings: CallSettings,
): Promise<ChatResult> {
  let lastError: Error = new Error("unreachable");

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await sleep(base + Math.random() * base * 0.5);
    }
    try {
      return await callTargetOnce(role, target, messages, opts, settings);
    } catch (err) {
      if (err instanceof LlmRequestError || err instanceof LlmJsonError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

async function callTargetOnce(
  role: AgentRole,
  target: ResolvedTarget,
  messages: ChatMessage[],
  opts: ChatOptions,
  settings: CallSettings,
): Promise<ChatResult> {
  const startedAt = Date.now();
  const raw = await transport(target, messages, opts, settings.timeoutMs);

  let parsed: unknown;
  let text = raw.text;
  let usage = raw.usage;

  if (opts.json) {
    const first = tryParseJson(text);
    if (first.ok) {
      parsed = first.value;
    } else {
      // 03 §1.6.4 — exactly one repair round-trip with the parse error appended.
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `Your previous reply was not valid JSON (parse error: ${first.error}). Reply again with ONLY the valid JSON object — no prose, no markdown fences.`,
        },
      ];
      const second = await transport(target, repairMessages, opts, settings.timeoutMs);
      usage = {
        inputTokens: usage.inputTokens + second.usage.inputTokens,
        outputTokens: usage.outputTokens + second.usage.outputTokens,
      };
      const reparse = tryParseJson(second.text);
      if (!reparse.ok) {
        // Record the (double) spend before surfacing the quality error.
        await finalizeRun(role, target, opts.runContext, usage, startedAt, settings.degraded, "json_contract_failed_after_repair");
        throw new LlmJsonError(target.provider, target.model, second.text, reparse.error);
      }
      text = second.text;
      parsed = reparse.value;
    }
  }

  const runId = await finalizeRun(
    role,
    target,
    opts.runContext,
    usage,
    startedAt,
    settings.degraded,
    null,
  );

  return {
    text,
    parsed,
    provider: target.provider,
    model: target.model,
    usage,
    costUsd: estimateCostUsd(target.provider, target.model, usage),
    latencyMs: Date.now() - startedAt,
    degraded: settings.degraded,
    llmRunId: runId,
  };
}

// ── Transports (the only provider-conditional code besides headers) ─────────

interface RawCompletion {
  text: string;
  usage: ChatUsage;
}

async function transport(
  target: ResolvedTarget,
  messages: ChatMessage[],
  opts: ChatOptions,
  timeoutMs: number,
): Promise<RawCompletion> {
  return target.provider === "anthropic"
    ? callAnthropic(target, messages, opts, timeoutMs)
    : callOpenAiCompatible(target, messages, opts, timeoutMs);
}

/** OpenRouter, Ollama, LM Studio, vLLM — anything speaking chat-completions. */
async function callOpenAiCompatible(
  target: ResolvedTarget,
  messages: ChatMessage[],
  opts: ChatOptions,
  timeoutMs: number,
): Promise<RawCompletion> {
  const body = buildOpenAiBody(target.model, messages, opts);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${target.config.apiKey ?? "ollama"}`,
    ...target.config.extraHeaders,
  };

  const json = await fetchJson(
    target,
    `${target.config.baseUrl}/chat/completions`,
    headers,
    body,
    timeoutMs,
  );

  const choice = (json as { choices?: { message?: { content?: string } }[] }).choices?.[0];
  const usage = (json as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }).usage;

  return {
    text: choice?.message?.content ?? "",
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  };
}

/** Anthropic native Messages API, translated to/from the common shape. */
async function callAnthropic(
  target: ResolvedTarget,
  messages: ChatMessage[],
  opts: ChatOptions,
  timeoutMs: number,
): Promise<RawCompletion> {
  const body = buildAnthropicBody(target.model, messages, opts);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": target.config.apiKey ?? "",
    "anthropic-version": ANTHROPIC_VERSION,
  };

  const json = await fetchJson(
    target,
    `${target.config.baseUrl}/messages`,
    headers,
    body,
    timeoutMs,
  );

  const content = (json as { content?: { type: string; text?: string }[] }).content ?? [];
  const usage = (json as {
    usage?: { input_tokens?: number; output_tokens?: number };
  }).usage;

  return {
    text: content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    },
  };
}

// ── Request body builders (exported pure functions for unit tests) ──────────

export function buildOpenAiBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Record<string, unknown> {
  const wireMessages: ChatMessage[] = opts.system
    ? [{ role: "system", content: opts.system }, ...messages]
    : [...messages];

  if (opts.json) {
    // Same prompt contract as the Anthropic path: several OpenAI-compatible
    // backends 400 a response_format=json_* request whose messages never
    // mention JSON, and a 4xx is a hard no-fallback LlmRequestError. Harmless
    // when the backend also honors response_format; keeps JSON-mode behavior
    // provider-invariant.
    const instruction = jsonContractInstruction(opts.json);
    const idx = wireMessages.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      // Replace rather than mutate — caller-provided message objects are shared.
      wireMessages[idx] = {
        role: "system",
        content: `${wireMessages[idx].content}\n\n${instruction}`,
      };
    } else {
      wireMessages.unshift({ role: "system", content: instruction });
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages: wireMessages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.json === true) {
    body.response_format = { type: "json_object" };
  } else if (opts.json && typeof opts.json === "object") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema: opts.json },
    };
  }
  return body;
}

export function buildAnthropicBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Record<string, unknown> {
  // System-role messages fold into the top-level system param.
  const systemParts = [
    ...(opts.system ? [opts.system] : []),
    ...messages.filter((m) => m.role === "system").map((m) => m.content),
  ];
  if (opts.json) {
    // No response_format on the Messages API — the JSON contract is a prompt
    // instruction; the gateway's parse-and-repair loop enforces it.
    systemParts.push(jsonContractInstruction(opts.json));
  }

  const conversational = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const body: Record<string, unknown> = {
    model,
    // max_tokens is REQUIRED by the Messages API.
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages:
      conversational.length > 0
        ? conversational
        : [{ role: "user" as const, content: "Proceed." }], // API requires ≥1 message
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  return body;
}

/** Shared JSON prompt contract — identical wording on every transport. */
function jsonContractInstruction(json: true | Record<string, unknown>): string {
  return typeof json === "object"
    ? `Reply ONLY with a valid JSON object matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(json)}`
    : "Reply ONLY with a valid JSON object — no prose, no markdown fences.";
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

async function fetchJson(
  target: ResolvedTarget,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) {
        // Retryable — plain Error so the retry loop / fallback chain handles it.
        throw new Error(`HTTP ${res.status} from ${target.provider}: ${errBody.slice(0, 300)}`);
      }
      // Other 4xx = our bug; never retried, never falls back (03 §1.6.2).
      throw new LlmRequestError(target.provider, target.model, res.status, errBody);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timeout after ${timeoutMs}ms calling ${target.provider}:${target.model}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOllama(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Same auth as the chat call: plain Ollama ignores the header, but authed
    // OpenAI-compatible servers (vLLM --api-key, tunnel-fronted) would 401 an
    // unauthenticated probe and get skipped forever.
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey ?? "ollama"}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON contract helpers (exported for unit tests) ─────────────────────────

type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export function tryParseJson(text: string): ParseOutcome {
  const candidates = [text.trim(), stripCodeFences(text), extractBracedBlock(text)];
  let lastError = "empty response";
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

function stripCodeFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : "";
}

function extractBracedBlock(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

// ── Accounting glue (bounded-await; never fails the call) ───────────────────

// On Vercel serverless, work started after the response returns is frozen, so
// pure fire-and-forget nondeterministically loses reader-AI accounting rows
// (03 §1.7 "every call writes one row"). A bounded race lets the insert
// usually land without meaningfully delaying the caller; on the long-lived
// worker the insert completes well inside the budget anyway. recordLlmRun
// never rejects, so the race cannot throw.
const ACCOUNTING_FLUSH_BUDGET_MS = 500;

function boundedAccountingWait(insert: Promise<void>): Promise<void> {
  return Promise.race([insert, sleep(ACCOUNTING_FLUSH_BUDGET_MS)]);
}

async function finalizeRun(
  role: AgentRole,
  target: ResolvedTarget,
  ctx: RunContext,
  usage: ChatUsage,
  startedAt: number,
  degraded: boolean,
  error: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await boundedAccountingWait(recordLlmRun({
    id,
    agent_id: ctx.agentId,
    pipeline_item_id: ctx.pipelineItemId ?? null,
    role,
    provider: target.provider,
    model: target.model,
    purpose: ctx.purpose,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: estimateCostUsd(target.provider, target.model, usage),
    latency_ms: Date.now() - startedAt,
    degraded,
    error,
  }));
  return id;
}

function recordFailure(
  role: AgentRole,
  target: ResolvedTarget,
  ctx: RunContext,
  degraded: boolean,
  error: string,
): Promise<void> {
  return boundedAccountingWait(recordLlmRun({
    id: crypto.randomUUID(),
    agent_id: ctx.agentId,
    pipeline_item_id: ctx.pipelineItemId ?? null,
    role,
    provider: target.provider,
    model: target.model,
    purpose: ctx.purpose,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    latency_ms: 0,
    degraded,
    error: error.slice(0, 1000),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

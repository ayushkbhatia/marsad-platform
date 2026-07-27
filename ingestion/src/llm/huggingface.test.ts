/**
 * PE.8 — HuggingFace Inference Providers as a gateway provider.
 *
 * Each test pins one trap that is silent in production if it regresses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProviderConfig, isConfigured, parseModelSpec, resolveRoleTargets } from './providers.js';
import { estimateCostUsd, PRICE_TABLE } from './pricing.js';
import { DEFAULT_MODELS } from './roles.js';
import { PROVIDER_NAMES } from './types.js';

test('huggingface is a registered provider', () => {
  assert.ok(PROVIDER_NAMES.includes('huggingface'));
});

test('base URL is the auto-router /v1 — the gateway appends /chat/completions', () => {
  const c = getProviderConfig('huggingface', {});
  assert.equal(c.baseUrl, 'https://router.huggingface.co/v1');
  // The gateway builds `${baseUrl}/chat/completions`; assert the result is the documented route.
  assert.equal(`${c.baseUrl}/chat/completions`, 'https://router.huggingface.co/v1/chat/completions');
});

test('a provider pin survives parseModelSpec — it splits on the FIRST colon only', () => {
  // This is what makes "pin via the model string" work at all. If parseModelSpec ever split on
  // the last colon, every pinned id would resolve to a nonexistent model.
  const t = parseModelSpec('huggingface:openai/gpt-oss-20b:novita');
  assert.equal(t.provider, 'huggingface');
  assert.equal(t.model, 'openai/gpt-oss-20b:novita');
});

test('every default huggingface model is provider-pinned', () => {
  // supports_structured_output varies by (model, provider) for the SAME model, and the router
  // defaults to :fastest. An unpinned id can be silently rerouted to an upstream that cannot
  // honour response_format — which reads as a model regression, not a routing change.
  for (const [role, model] of Object.entries(DEFAULT_MODELS.huggingface)) {
    if (role === 'embedder') continue; // no /v1/embeddings on the auto-router
    assert.match(model, /:[a-z0-9-]+$/, `${role} must pin a provider, got "${model}"`);
  }
});

test('HF needs a token; ollama does not', () => {
  assert.equal(isConfigured(getProviderConfig('huggingface', {})), false);
  assert.equal(isConfigured(getProviderConfig('huggingface', { HF_TOKEN: 'hf_x' })), true);
});

test('X-HF-Bill-To is sent only when configured (an empty value is rejected upstream)', () => {
  assert.equal(getProviderConfig('huggingface', {}).extraHeaders, undefined);
  assert.deepEqual(
    getProviderConfig('huggingface', { LLM_HUGGINGFACE_BILL_TO: 'marsad' }).extraHeaders,
    { 'X-HF-Bill-To': 'marsad' },
  );
});

test('pricing strips the provider pin, and does NOT strip ollama tags', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const pinned = estimateCostUsd('huggingface', 'openai/gpt-oss-20b:novita', usage);
  const bare = estimateCostUsd('huggingface', 'openai/gpt-oss-20b', usage);
  assert.equal(pinned, bare, 'a pinned id must price as its base model');
  assert.equal(pinned, PRICE_TABLE['openai/gpt-oss-20b'].inputPerMtok + PRICE_TABLE['openai/gpt-oss-20b'].outputPerMtok);
  // ollama is free regardless, but the tag must never be treated as a pin.
  assert.equal(estimateCostUsd('ollama', 'qwen2.5:14b-instruct', usage), 0);
});

test('an UNPRICED model is charged pessimistically, never $0', () => {
  // The old behaviour returned 0, which made ops.newsroom_budget_state read a new model as free
  // spend — the ladder stopped working exactly when it was needed.
  const cost = estimateCostUsd('huggingface', 'some/brand-new-model:together', {
    inputTokens: 1_000_000, outputTokens: 0,
  });
  assert.ok(cost > 0, 'unpriced model must not cost 0');
  assert.equal(cost, 3);
});

test('every pinned default model has a price row', () => {
  for (const [role, model] of Object.entries(DEFAULT_MODELS.huggingface)) {
    if (role === 'embedder') continue;
    const bare = model.slice(0, model.lastIndexOf(':'));
    assert.ok(PRICE_TABLE[bare], `${bare} missing from PRICE_TABLE — the ladder would guess`);
  }
});

test('LLM_PROVIDER=huggingface resolves a role without any LLM_ROLE_* override', () => {
  const [primary] = resolveRoleTargets('summarizer', { LLM_PROVIDER: 'huggingface', HF_TOKEN: 'hf_x' });
  assert.equal(primary.provider, 'huggingface');
  assert.equal(primary.model, 'openai/gpt-oss-20b:novita');
});

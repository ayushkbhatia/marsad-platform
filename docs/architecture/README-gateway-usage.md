# LLM Gateway — usage guide (`src/lib/llm/`)

The provider-swap hard requirement, implemented per `03-agent-newsroom.md` §1
(canonical spec; `06-infra-cost.md` §9 defers to it). Dependencies:
`@supabase/supabase-js` (already installed) for the Next-runtime accounting
RPC, plus `postgres` on the worker only (resolved at runtime outside the
bundler — the Next build does not need it).

## The one entry point

```ts
import { chatComplete } from "@/lib/llm";

const result = await chatComplete(
  "classifier",
  [{ role: "user", content: promptBody }],
  {
    system: CLASSIFIER_SYSTEM_PROMPT,
    maxTokens: 300,
    json: VERDICT_JSON_SCHEMA, // or `true` for schemaless JSON mode
    runContext: {
      agentId: "WRITER-2",                 // mandatory — no anonymous spend
      pipelineItemId: item.id,             // optional uuid correlation
      purpose: "classify:NEWS:7010-halt",  // mandatory
    },
  },
);

result.text;      // raw completion text
result.parsed;    // parsed object when `json` was set
result.degraded;  // true → a fallback target served the call (27a console chip)
result.costUsd;   // from the static price table (pricing.ts)
result.llmRunId;  // id of the ops.llm_runs accounting row
```

Pipeline code names a **role**, never a provider or model. Roles:
`classifier | writer | editor | summarizer | analyst_take` (plus `embedder`,
which the chat gateway rejects — embeddings run in-process ONNX on the VPS or
via an embeddings endpoint, per 06 Revisions #7). "rules-assist" work maps to
existing roles: R-06 framing checks → `classifier`, R-10 rewrites → `editor`.

## Routing (all env, no code)

1. `LLM_ROLE_<ROLE>=provider:model` (e.g. `LLM_ROLE_WRITER=openrouter:nousresearch/hermes-4-405b`).
   Split on the first colon only, so `ollama:qwen2.5:14b-instruct` works.
2. If unset: `LLM_PROVIDER` (default `openrouter`, Scenario B) + the default
   model for that role in `roles.ts`.
3. Fallback chain: `LLM_ROLE_<ROLE>_FALLBACK` (comma-separated specs) or the
   two-model-family defaults in `roles.ts`. Targets whose provider has no API
   key are skipped.

Base URLs / keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
`OLLAMA_BASE_URL` (any OpenAI-compatible server) — plus `LLM_`-prefixed
overrides. See `.env.example` for the full contract.

## Failure ladder (03 §1.6)

| Condition | Behavior |
|---|---|
| Ollama target dead | `GET {base}/models` probe (1.5 s budget) → next target, `degraded: true` |
| 429 / 5xx / timeout / network | 2 retries with jitter (250 ms, 1 s), then next target |
| Other 4xx | `LlmRequestError` — no retry, no fallback (it's our bug) |
| Chain exhausted | `LlmUnavailableError` — worker schedules the business retry (infra severity) |
| JSON doesn't parse | one repair round-trip; second failure → `LlmJsonError` (quality severity) |

## Accounting

Every call (success or final failure) writes one row into `ops.llm_runs` —
inside the gateway, never the caller's job. Inserts never throw; the gateway
bound-awaits them (500 ms race) so rows land even on Vercel serverless, where
pure fire-and-forget work is frozen once the response returns. Cost comes from
the static `$/Mtok` table in `pricing.ts` (owner-edited; $0 for ollama and
unknown models, with a one-time warning for unknowns). The nightly pg_cron
rollup and the `iam.global_switches.llm_budget_usd_month` ($60) degrade ladder
consume these rows; the gateway itself only records.

`ops` is **never** exposed to PostgREST (02 locks the exposure surface to
`public, graphql_public`). The row lands via one of two paths, picked
automatically from the environment (`LlmRunRow` is the stable contract):

1. **Worker** — `SUPABASE_DB_URL` set: direct `INSERT` as the `marsad_worker`
   pg role over the Supavisor session pooler (06 Revisions #1: the worker's
   service-role key is Storage-only). Uses `postgres` (postgres.js, the
   worker's standard driver) and needs `GRANT INSERT ON ops.llm_runs TO
   marsad_worker` in the ops migration.
2. **Next.js server runtime** — `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY`: SECURITY DEFINER RPC
   `public.record_llm_run(p_run jsonb)`, mirroring 02's `public.track()`
   analytics-insert pattern.

The ops migration must ship this RPC (EXECUTE for `service_role` only):

```sql
create or replace function public.record_llm_run(p_run jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into ops.llm_runs
    (id, agent_id, pipeline_item_id, role, provider, model, purpose,
     input_tokens, output_tokens, cost_usd, latency_ms, degraded, error)
  values (
    (p_run->>'id')::uuid,
    p_run->>'agent_id',
    (p_run->>'pipeline_item_id')::uuid,
    p_run->>'role',
    p_run->>'provider',
    p_run->>'model',
    p_run->>'purpose',
    (p_run->>'input_tokens')::int,
    (p_run->>'output_tokens')::int,
    (p_run->>'cost_usd')::numeric,
    (p_run->>'latency_ms')::int,
    (p_run->>'degraded')::boolean,
    p_run->>'error'
  );
$$;

revoke execute on function public.record_llm_run(jsonb) from public, anon, authenticated;
grant execute on function public.record_llm_run(jsonb) to service_role;

grant usage on schema ops to marsad_worker;
grant insert on ops.llm_runs to marsad_worker;
```

Serverless callers need no extra plumbing — the bounded await inside the
gateway is the flush mechanism. If a route must shave the last ~500 ms it can
wrap the whole `chatComplete` call in `after()` from `next/server`, but do not
reintroduce unawaited accounting.

## Wire formats

- `openrouter` / `ollama`: OpenAI `POST {base}/chat/completions`; JSON mode via
  `response_format` (`json_object` / `json_schema`).
- `anthropic`: native Messages API `POST {base}/messages` translated to/from
  the common shape (`max_tokens` always sent; JSON mode is a strict system-prompt
  contract enforced by the gateway's parse-and-repair loop). Native transport
  keeps prompt caching / Batch API reachable later without changing callers.

## Testing seams

Pure, env-bag-driven functions: `parseModelSpec`, `resolveRoleTargets(role, env)`,
`getProviderConfig`, `buildOpenAiBody`, `buildAnthropicBody`, `tryParseJson`,
`estimateCostUsd`. `accounting._resetAccountingClientForTests()` resets the
memoized Supabase client.

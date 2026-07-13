# 03 — Agent Newsroom Pipeline & LLM Gateway

> Domain architecture for the autonomous newsroom: the LLM gateway, the twelve agent
> service accounts, the event-driven lake→wire pipeline, the publishing rules engine,
> provenance, orchestration runtime, and the newsletter/analytics agents.
>
> Companion to `docs/design-analysis.md` (read that first; section references like "27a"
> and "R-03" point at it). Locked constraints honored throughout: scrape-only delayed
> data, all 6 venues day one, cheapest-possible run cost on the existing Supabase +
> Vercel footprint, provider-agnostic LLM layer, English only.
>
> Author: lead architect, newsroom domain. Date: 2026-07-13.

---

## 0. Summary of decisions

| Decision | Choice | Why |
|---|---|---|
| LLM gateway shape | Single fetch-based TypeScript module speaking the **OpenAI chat-completions wire format** to every provider | Anthropic exposes an OpenAI-compatible endpoint, OpenRouter and Ollama are natively OpenAI-compatible → zero code change to swap providers, only env vars |
| Model routing | Per-role env map `LLM_ROLE_<ROLE>=provider:model` with per-role fallback chain | Writer, editor, classifier, summarizer, embedder each independently swappable; mixed fleets (cheap classifier + strong writer) supported |
| Default model tier | **Hybrid**: OpenRouter open-weights (Hermes-class) for classifier/editor/wires, Anthropic Sonnet-tier for long-form + Marsad Takes | ~SAR-negligible: ≈ $25–40/mo at projected volume vs ≈ $130/mo all-Sonnet, with quality where readers pay for it. DEFAULTED — owner may override to all-local ($0) or all-Sonnet |
| Orchestration runtime | **REVISED (see Revisions): pgmq queues + pg_cron schedulers on Supabase, workers as resident pgmq consumers on the platform VPS** (06-infra-cost.md is the placement authority; the VPS exists regardless for Playwright scraping) | $0 *additional* — the VPS is already paid for by ingestion; no Edge Functions (no third runtime, no invocation quotas, no 10-second tick storm), no BullMQ/Redis |
| Retrieval over the lake | **SQL views first, pgvector second.** Structured facts come from typed views; pgvector (HNSW, 384-dim `gte-small` embeddings generated free inside Edge Functions) only for "related context" | Writers cite typed VERIFIED objects, which is a SQL problem, not a semantic-search problem. pgvector adopted, but as garnish, not spine |
| Rules engine | A service (`rules-engine` Edge Function + shared library), versioned rulesets in Postgres, deterministic checks wherever possible, LLM only for R-06 framing and R-10 rewrites | Same endpoint invoked for agent AND human content (25b "RUN RULES NOW" button hits the same function) |
| Auto-publish gate | TPL-01 **and ≤ 40 words** and rules-clean and guardrail toggle ON | Resolves open question #9 conservatively: 40 is the agent exception everywhere in the designs; TPL-01 wires of 41–90 words go to the approval queue. DEFAULTED |
| Dead letters & kill switches | pgmq archive tables + `agent_errors` queue; per-agent `enabled` flag + global `newsroom_flags` checked at the top of every worker | Mirrors 27a error queue and 31a kill switches exactly |

Estimated incremental monthly cost of this domain: **≈ $25–40/mo LLM spend at the default
hybrid tier** (see §11), **$0 infra** beyond the existing Supabase and Vercel plans.
The one flagged future cost outside this domain is email delivery at scale (§10).

---

## 1. The LLM Gateway (the hard requirement)

### 1.1 Design

One module, no SDKs, no provider imports. The gateway speaks the OpenAI
`POST {base_url}/chat/completions` wire format over plain `fetch`, which all three
required backends accept:

| Provider | Base URL (env) | Notes |
|---|---|---|
| Anthropic | `https://api.anthropic.com/v1` | Anthropic's OpenAI SDK-compatibility endpoint accepts `chat/completions` with `Authorization: Bearer <key>`. Good enough for our use (no tool use, no thinking blocks needed in-pipeline). |
| OpenRouter | `https://openrouter.ai/api/v1` | Natively OpenAI-compatible; one key, hundreds of open-weight models (Hermes, Llama, Qwen). |
| Ollama / LM Studio (owner's Mac) | `http://127.0.0.1:11434/v1` (Ollama) or `http://127.0.0.1:1234/v1` (LM Studio) | Both expose OpenAI-compatible servers. From cloud workers this is only reachable through a tunnel (see §1.6). |

Because the wire format is identical, "swap Anthropic ↔ OpenRouter ↔ local" is literally
an env-var edit and a redeploy. No code path branches on provider except header
assembly.

The module is written dependency-free so the identical file runs in **both** runtimes we
have: Next.js (Node) under `src/lib/llm/` and Supabase Edge Functions (Deno) via a
symlinked/shared copy under `supabase/functions/_shared/llm/`.

### 1.2 Files

```
src/lib/llm/
  types.ts        # ChatMessage, ChatRequest, ChatResult, Role, ProviderConfig
  providers.ts    # env parsing → resolved ProviderConfig per role, incl. fallbacks
  gateway.ts      # chatComplete(role, req): the only function callers use
  accounting.ts   # writes llm_runs rows (tokens, cost, latency, provider, model)
  pricing.ts      # static $/Mtok table per known model id, editable, used for cost calc
supabase/functions/_shared/llm/   # same files, imported by Edge Function workers
```

### 1.3 Interface

```ts
// src/lib/llm/types.ts
export type AgentRole =
  | "classifier"   // materiality triage
  | "writer"       // draft generation
  | "editor"       // edit pass + template fitting + R-10 rewrites
  | "summarizer"   // filing/transcript summaries, Wire Brief lead
  | "analyst_take" // TPL-08 premium takes (highest tier)
  | "embedder";    // embeddings (special-cased: may resolve to gte-small local)

export interface ChatRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;          // default 1024
  temperature?: number;        // passed through only when provider supports it
  jsonSchema?: object;         // if set → response_format json_schema (OpenRouter/Ollama)
                               // or "reply ONLY with JSON matching…" prompt fallback
  runContext: {                // accounting — mandatory, no anonymous spend
    agentId: string;           // e.g. "WRITER-2"
    pipelineItemId?: string;
    purpose: string;           // e.g. "draft:TPL-04:2222-q2-earnings"
  };
}

export interface ChatResult {
  text: string;
  parsed?: unknown;            // when jsonSchema was set and parse succeeded
  provider: string; model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;             // from pricing.ts; 0 for local
  latencyMs: number;
  degraded: boolean;           // true when a fallback provider served the call
  llmRunId: string;            // FK into llm_runs
}

export async function chatComplete(role: AgentRole, req: ChatRequest): Promise<ChatResult>;
```

`chatComplete` is the **only** entry point. Pipeline code never names a model or a
provider; it names a role.

### 1.4 Env-driven routing

```bash
# ── Provider registry ─────────────────────────────────────────────
LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
LLM_ANTHROPIC_API_KEY=sk-ant-...
LLM_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LLM_OPENROUTER_API_KEY=sk-or-...
LLM_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1      # or a tunnel URL, see §1.6
LLM_OLLAMA_API_KEY=ollama                            # ignored by Ollama, kept for shape

# ── Role → provider:model map (the model map per agent role) ─────
LLM_ROLE_CLASSIFIER=openrouter:nousresearch/hermes-3-llama-3.1-70b
LLM_ROLE_WRITER=anthropic:claude-sonnet-4-6
LLM_ROLE_EDITOR=openrouter:nousresearch/hermes-3-llama-3.1-70b
LLM_ROLE_SUMMARIZER=openrouter:nousresearch/hermes-3-llama-3.1-70b
LLM_ROLE_ANALYST_TAKE=anthropic:claude-sonnet-4-6
LLM_ROLE_EMBEDDER=supabase:gte-small                 # free, in-Edge-Function (§5)

# ── Per-role fallback chain (comma-separated, tried in order) ────
LLM_ROLE_WRITER_FALLBACK=openrouter:nousresearch/hermes-3-llama-3.1-70b
LLM_ROLE_CLASSIFIER_FALLBACK=anthropic:claude-haiku-4-5
LLM_OLLAMA_HEALTH_TIMEOUT_MS=1500
```

Swapping the entire newsroom to local models is:

```bash
LLM_ROLE_CLASSIFIER=ollama:qwen2.5:14b-instruct
LLM_ROLE_WRITER=ollama:llama3.3:70b
LLM_ROLE_EDITOR=ollama:qwen2.5:14b-instruct
...
```

No other change. `providers.ts` parses `provider:model` strings, resolves the base URL
and key from the registry vars, and returns an ordered `[primary, ...fallbacks]` list per
role. Header assembly is the only provider-conditional code (Bearer key everywhere;
OpenRouter additionally gets `HTTP-Referer`/`X-Title` attribution headers).

### 1.5 Per-role model tiers (default posture)

| Role | Default | Rationale |
|---|---|---|
| `classifier` | Hermes-3 70B (OpenRouter) | ~200-token structured verdicts; open-weights are fine, and half the events are decided by deterministic rules before any LLM call (§6.2) |
| `writer` | Sonnet 4.6 (Anthropic) | Reader-facing prose with citation discipline; strongest cost/quality point. Sonnet 5 intro pricing ($2/$10 through 2026-08-31) makes it a drop-in upgrade candidate |
| `editor` | Hermes-3 70B | Editing against explicit rules is more constrained than drafting; cheap model + deterministic rule checks behind it |
| `summarizer` | Hermes-3 70B | Filing summaries, Wire Brief lead paragraph |
| `analyst_take` | Sonnet 4.6 | TPL-08 is ALWAYS PREMIUM; paying readers see this — do not cheap out |
| `embedder` | `gte-small` in Edge Functions | $0, 384-dim, runs inside Supabase (§5.3) |

DEFAULTED — owner may override any row via env at any time; that is the whole point of
the gateway.

### 1.6 Graceful degradation

The failure ladder inside `chatComplete`:

1. **Local unreachable → fallback chain.** When the resolved provider is `ollama`, the
   gateway first probes `GET {base}/models` with `LLM_OLLAMA_HEALTH_TIMEOUT_MS`
   (default 1500 ms). On timeout/refused, it moves to the role's fallback chain without
   burning the caller's patience on a dead socket. Every degraded call sets
   `degraded: true` and is written to `llm_runs.degraded` so the 27a console can show
   "WRITER-2 running on fallback".
2. **HTTP 429/5xx → bounded retry then next provider.** Two retries with jitter
   (250 ms, 1 s) on the same provider, then the next fallback. 4xx other than 429 does
   not retry (it's our bug).
3. **Chain exhausted → typed `LlmUnavailableError`.** The pipeline worker catches this,
   marks the pipeline item `attempts += 1`, schedules a retry (§9.2), and emits an
   `agent_errors` row (severity `infra`) — which is exactly the 27a error-queue card.
   Nothing is ever published on a degraded guess; the item just waits.
4. **JSON contract failure → one repair attempt.** If `jsonSchema` was requested and the
   reply doesn't parse, the gateway re-asks once with the parse error appended. Second
   failure surfaces as a quality error (`agent_errors` severity `quality`, the 0.61-
   confidence-kickback path).

Local-model reachability from cloud workers: Supabase Edge Functions cannot see
`127.0.0.1` on the owner's Mac. Local mode therefore means either (a) development on
the Mac itself (Next.js dev server + `supabase functions serve`), or (b) production
pointing `LLM_OLLAMA_BASE_URL` at a tunnel (Cloudflare Tunnel free tier or Tailscale
Funnel — both $0). The gateway doesn't care; it's just a base URL. DEFAULTED: no tunnel
is provisioned day one; local = dev-only until the owner asks.

### 1.7 Token & cost accounting

Every call writes one row, no exceptions (the accounting call is inside the gateway, not
the caller's responsibility):

```sql
create table llm_runs (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  agent_id       text not null references agent_accounts(agent_id),
  pipeline_item_id uuid references pipeline_items(id),
  role           text not null,            -- classifier | writer | ...
  provider       text not null,            -- anthropic | openrouter | ollama | supabase
  model          text not null,
  purpose        text not null,
  input_tokens   int  not null,
  output_tokens  int  not null,
  cost_usd       numeric(10,6) not null default 0,
  latency_ms     int  not null,
  degraded       boolean not null default false,
  error          text                       -- null on success
);
create index on llm_runs (created_at);
create index on llm_runs (agent_id, created_at);
```

`pricing.ts` holds a small static `$ per Mtok` table (Anthropic list prices, OpenRouter
per-model prices, `0` for ollama/supabase) that the owner edits when prices move.
A pg_cron rollup (`0 20 * * *` UTC = 00:00 GST) aggregates into
`llm_cost_daily(day, agent_id, role, usd, tokens_in, tokens_out)` which feeds the 27a
fleet strip and a monthly budget alarm: a `newsroom_flags.llm_budget_usd_month` value
(default **$60**, DEFAULTED) past which the pipeline flips writers to the fallback
(cheaper) chain and posts a needs-attention item to the Desk dashboard. Hard stop at
2× budget: pipeline pauses non-wire drafting entirely (wires are the product's pulse and
are cheap).

---

## 2. Agent taxonomy & service accounts

### 2.1 The twelve accounts

One principal model for humans and agents (31a/31b). Agents are rows in the same
identity store, with scoped keys and kill switches. Mapping the design roster to
concrete accounts (the designs name 10 explicitly; the newsletter and analytics agents
complete the 12 — DEFAULTED naming):

| agent_id | Class | Scope string (stored, human-readable) | What it actually does |
|---|---|---|---|
| `DATA-TDWL` | DATA | `lake:write · snapshots:write · never content · never publish` | Tadawul scraper → raw snapshots → typed lake objects (mechanics owned by the market-data domain; the account and its lake writes are defined here) |
| `DATA-GULF` | DATA | same | DFM, ADX, QE, BHB (one account, four venues — matches 31a) |
| `DATA-MSX` | DATA | same | Muscat (separate: worst source quality, own error budget) |
| `DATA-FILINGS` | DATA | `lake:write · filings:parse · never content · never publish` | Disclosure PDFs → extracted text → typed facts (DPS, ex-dates, results) |
| `DATA-NEWS` | DATA | `lake:write · news:ingest · never content · never publish` | Public news/RSS ingestion, halt detection |
| `WRITER-1` | WRITER | `drafts:create · lake:read (verified only) · never publish` | Earnings & results beats (TPL-02/04) |
| `WRITER-2` | WRITER | same | Corporate actions, dividends, IPOs (TPL-01/05/07) |
| `WRITER-3` | WRITER | same | Explainers, deep dives, Takes drafting (TPL-03/06/08) |
| `EDITOR-1` | PUBLISHING | `drafts:edit · rules:invoke · templates:select · publish:wire≤40w · never rules-change` | Design & publishing agent, market-hours shift |
| `EDITOR-2` | PUBLISHING | same | Second editor for parallelism / off-hours |
| `NEWSLETTER-1` | PUBLISHING | `briefs:assemble · content:read · sends:enqueue · never publish-web` | Wire Brief AM/PM assembly (§10.1) |
| `ANALYTICS-1` | DATA | `analytics:read · reports:create · never content · never publish` | Nightly rollups + weekly owner digest (§10.2) |

```sql
create table agent_accounts (
  agent_id     text primary key,               -- 'WRITER-2'
  class        text not null check (class in ('DATA','WRITER','PUBLISHING')),
  display_name text not null,
  scopes       text[] not null,                -- machine-checkable: ['drafts:create','lake:read:verified']
  negative_scopes text[] not null,             -- ['publish','billing','rules:write']
  human_owner  uuid not null references auth.users(id),
  api_key_hash text not null,                  -- scoped Supabase JWT / service key hash
  key_rotated_at timestamptz not null default now(),
  enabled      boolean not null default true,  -- per-agent kill switch (31a)
  status       text not null default 'idle',   -- active | idle | erroring
  current_task text,
  next_run_at  timestamptz,
  created_at   timestamptz not null default now()
);
```

### 2.2 Enforcement, not decoration

Scopes are enforced in three layers:

1. **Postgres RLS.** Each agent authenticates to Supabase with a JWT whose `role` claim
   is `agent` and whose `agent_id` claim is its ID. RLS policies gate by class:
   WRITER JWTs can `select` on `lake_objects` **only where `state = 'VERIFIED'`**
   (this is the "writers cite only VERIFIED objects" rule made physical, not
   procedural), can `insert/update` on `content_items` only where
   `status in ('DRAFT','EDIT')`, and have no grant at all on `subscriptions`,
   `rule_sets`, or anything billing-shaped. DATA JWTs can write `lake_objects` and
   `raw_snapshots` and nothing in `content_items`.
2. **Worker guard.** Every Edge Function worker's first query is
   `select enabled from agent_accounts where agent_id = $1` plus
   `select value from newsroom_flags where key in ('freeze_all','pause_all')`.
   Kill switch flips are effective on the next message, ≤ seconds.
3. **Append-only audit.** A single `audit_log` (owned by the platform/RBAC domain;
   we write to it) receives one row per state transition with
   `actor = agent_id`, identical schema to human actions, including `before_value`
   on any override. Newsroom-specific transitions also go to
   `pipeline_transitions` (§9.1) for the 27a run log.

### 2.3 Guardrail invariants (hard-coded, not configurable)

- No code path exists from any WRITER context to a `publish` mutation. Publishing is
  one function (`publish_content(item_id, actor)`) that raises unless
  (a) actor is human with publish capability, or (b) actor is EDITOR-class **and** the
  item satisfies the auto-publish gate (§7.3).
- `rule_sets` is owner-writable only (RLS: `auth.uid() = owner`).
- Price-sensitive lake objects (`DIVIDEND.*`, `IPO.OFFER.*`) carry
  `requires_human_confirm = true`; the fan-out trigger refuses to propagate them until a
  human confirm row exists (33b behavior). Writers can cite the *previous* confirmed
  value meanwhile; the citation graph flags the piece when the new value lands (R-07).

---

## 3. The data lake surface this pipeline consumes

The lake itself (scrapers, parse SLAs, conflict resolution UI) is the market-data
domain's build; this section pins the contract the newsroom depends on.

```sql
create table lake_objects (
  id            uuid primary key default gen_random_uuid(),
  object_type   text not null,        -- 'DISCLOSURE.DPS', 'FILING.FINANCIALS', 'IPO.COVERAGE', ...
  ticker        text,                 -- null for market-wide objects
  venue         text,                 -- 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB'
  payload       jsonb not null,       -- typed value(s); numeric fields normalized
  summary_en    text,                 -- one-line human/embedding summary
  state         text not null default 'PENDING'
                check (state in ('PENDING','VERIFIED','CONFLICT','SUPERSEDED')),
  source_agent  text not null references agent_accounts(agent_id),
  raw_snapshot_id uuid references raw_snapshots(id),   -- lineage
  requires_human_confirm boolean not null default false,
  confirmed_by  uuid,                 -- human, when required
  revision_of   uuid references lake_objects(id),      -- revision pairs old→new
  content_hash  text not null,        -- sha256 of canonical payload; provenance pin
  verified_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index on lake_objects (ticker, object_type, verified_at desc);
create index on lake_objects (state) where state = 'VERIFIED';

create table lake_citations (
  id              uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references content_items(id),
  lake_object_id  uuid not null references lake_objects(id),
  claim_key       text not null,      -- 'c1','c2'… anchor used in the article body
  cited_value     jsonb not null,     -- the exact value at citation time
  cited_hash      text not null,      -- lake_objects.content_hash at citation time
  created_at      timestamptz not null default now(),
  unique (content_item_id, claim_key)
);
```

Two triggers wire the newsroom in:

```sql
-- (a) New VERIFIED object → enqueue pipeline intake
create or replace function fn_lake_verified_enqueue() returns trigger ... $$
  perform pgmq.send('q_intake', jsonb_build_object(
    'lake_object_id', NEW.id, 'object_type', NEW.object_type,
    'ticker', NEW.ticker, 'venue', NEW.venue));
$$;
create trigger trg_lake_verified after update on lake_objects
  for each row when (OLD.state <> 'VERIFIED' and NEW.state = 'VERIFIED')
  execute function fn_lake_verified_enqueue();

-- (b) Correction (revision pair on a cited object) → R-07 auto-flag
create trigger trg_lake_correction after insert on lake_objects
  for each row when (NEW.revision_of is not null)
  execute function fn_flag_citing_articles();   -- inserts correction_flags rows + Desk queue item
```

`fn_flag_citing_articles` joins `lake_citations` on `revision_of`, and for every LIVE
citing piece inserts into `correction_flags(content_item_id, lake_object_id, old_value,
new_value, status 'OPEN')`. Agents never edit live pieces — the flag is FLAG ONLY; a
human approves the appended correction note (25b corrections policy).

---

## 4. Event-driven pipeline, end to end

```
lake object VERIFIED ─► q_intake ─► [classifier worker]
      │                                   │  not material → archive (logged verdict)
      │                                   ▼  material
      │                              pipeline_items row (QUEUED) ─► q_draft
      │                                   ▼
      │                             [writer worker]  — retrieval (§5) → draft + citations
      │                                   ▼ DRAFT→EDIT           ─► q_edit
      │                             [editor worker]  — edit pass, template select (§7)
      │                                   ▼ EDIT→RULES            ─► q_rules
      │                             [rules worker]   — R-01…R-10 (§6/§8)
      │                              fail(BLOCK) → back to DRAFT (≤2 loops) or → HUMAN
      │                                   ▼ pass
      │                    auto-publish gate? ──yes (TPL-01 ≤40w)──► publish_content() → LIVE
      │                                   │ no
      │                                   ▼
      │                          approval_queue (owner, 3:00 SLA timers)
      │                     approve / approve-for-hh:mm / send back / reassign-to-human
      ▼
   (independently) per-ticker/venue fan-out, freshness badges, alerts — other domains
```

Queues (all pgmq, all in the existing Postgres):

| Queue | Producer | Consumer (Edge Function) | Cadence |
|---|---|---|---|
| `q_intake` | lake trigger | `pipeline-classify` | pg_cron every 10 s market hours, 60 s otherwise |
| `q_draft` | classifier | `pipeline-write` | every 10 s |
| `q_edit` | writer | `pipeline-edit` | every 10 s |
| `q_rules` | editor; also 25b "RUN RULES NOW" | `rules-engine` | every 10 s |
| `q_publish` | approval action / auto-gate | `pipeline-publish` | every 10 s |
| `q_sends` | NEWSLETTER-1, alert engines | (comms domain) | — |

pg_cron sub-minute syntax (`'10 seconds'`) invokes the consumer via `pg_net`
HTTP POST to the Edge Function URL with a shared secret header. Each consumer does a
`pgmq.read('q_x', vt => 120, qty => 5)` batch, processes, `pgmq.delete` on success,
lets visibility timeout requeue on crash. Idempotency: every message carries the
`pipeline_item_id`; workers re-check current stage before acting, so a redelivered
message is a no-op.

Latency budget: designs show lake→live median 14 min for approved pieces and 4 min for
auto wires. With 10-second polls and single LLM calls per stage, an auto wire is
realistically: trigger (instant) + classify (~3 s) + draft (~8 s) + edit (~6 s) + rules
(~2 s) + publish (~1 s) + poll gaps ≈ **60–90 s**, comfortably inside the fixture's
09:08 disclosure → 09:12 live wire.

---

## 5. Retrieval strategy over the lake

### 5.1 Principle

A writer's job is: given the trigger object, assemble *only VERIFIED, only relevant*
facts, and never let the model free-associate a number. That is 90 % a SQL problem.
Embeddings are used for the remaining 10 %: prior-coverage context, related transcript
quotes, "has Marsad written about this before" dedupe.

### 5.2 SQL views (primary)

```sql
-- Everything a writer may cite for a ticker, newest first, typed
create view v_citable_objects as
  select id, object_type, ticker, venue, payload, summary_en, content_hash, verified_at
  from lake_objects where state = 'VERIFIED';

-- Trigger-adjacent bundle: same ticker, same event family, last 400 days
create view v_writer_context as ...;  -- joins dividends history, last results,
                                      -- consensus row, score row, quote (delayed) for the ticker

-- Dedupe guard: pieces on this ticker in the last 48h with their template + trigger object
create view v_recent_coverage as ...;
```

The writer worker composes its prompt from a deterministic query set keyed by the
classifier's `event_type` (e.g. `DPS_CHANGE` pulls: the new object, the prior DPS
object, TTM payout ratio object, next ex-date, current yield COMPUTED object, and the
last two pieces on the ticker). Bounded, typed, cheap — and every fact handed to the
model already carries the `lake_object_id` + `content_hash` it must cite.

### 5.3 pgvector (adopted, scoped)

Evaluation: pgvector on Supabase is available on the existing plan, costs nothing
extra at our scale, and Supabase Edge Functions ship a built-in embedding session
(`new Supabase.ai.Session('gte-small')`, 384-dim) that runs **inside the function at
$0 LLM spend**. At 4.2 M lake objects, embedding everything would be wasteful; we
embed only what semantic search actually serves:

- `lake_objects.summary_en` for object types with prose value
  (`TRANSCRIPT.QUOTE`, `FILING.PROSPECTUS` sections, `NEWS.*`) — not price ticks.
- `content_items` headline + dek (published pieces) for dedupe and related-coverage.

```sql
create extension if not exists vector;
alter table lake_objects add column embedding vector(384);
alter table content_items add column embedding vector(384);
create index on lake_objects using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
create index on content_items using hnsw (embedding vector_cosine_ops);

-- match_lake_context(query_embedding, target_ticker, k) → top-k prose objects
```

Embedding happens in the same worker that verifies/publishes the row (one extra ~10 ms
in-process call). The writer prompt gets at most 5 semantic-context snippets, clearly
labeled `CONTEXT (do not cite numbers from this section)` — semantic hits are color,
never citation sources, which keeps R-03/R-04 tractable.

---

## 6. Materiality classifier

### 6.1 Deterministic pre-filter (free tier of the classifier)

Most triage needs no model. A config table maps object types to outcomes:

| object_type pattern | Verdict |
|---|---|
| `DISCLOSURE.DPS`, `DIVIDEND.EXDATE` (changed value) | material → wire (TPL-01), maybe recap |
| `FILING.FINANCIALS` (period-end results) | material → earnings recap (TPL-04) |
| `IPO.OFFER.*` state change | material → TPL-07 update / wire |
| `IPO.COVERAGE` delta < 0.5× | not material (silent object update) |
| `QUOTE.*`, `COMPUTED.YIELD` recompute | never material on their own |
| `NEWS.*`, `FILING.OTHER`, `TRANSCRIPT.*` | **ambiguous → LLM classifier** |

Roughly half of intake resolves here at $0.

### 6.2 LLM classifier (ambiguous only)

`chatComplete("classifier", …)` with a JSON schema verdict:

```json
{ "material": true, "event_type": "CONTRACT_AWARD",
  "priority": "wire" | "story" | "watch",
  "suggested_template": "TPL-01",
  "affected_tickers": ["2222"],
  "confidence": 0.87,
  "reason_one_line": "..." }
```

`confidence < 0.65` → not dropped, routed to a `watch` bucket surfaced on the Desk
(the 27a low-confidence kickback, applied at intake). Verdicts (including negatives) are
logged to `classifier_verdicts` so the owner can audit what the newsroom chose to
ignore — an autonomous newsroom's silence needs an audit trail too.

---

## 7. Writer → editor → template selection

### 7.1 Writer contract

The writer prompt gives: the trigger object(s) with ids/hashes, the deterministic
context bundle (§5.2), ≤5 semantic snippets, the target template's block requirements,
and the house style rules that are cheaper to obey than to fix (disclaimer excluded —
R-01 auto-fixes; headline limit stated — R-10 auto-fixes). Output contract (JSON):

```json
{ "headline": "...", "dek": "...",
  "blocks": [ {"type":"paragraph","text":"stc raised its interim DPS to SAR 0.55 [c1]…"} ],
  "citations": { "c1": {"lake_object_id":"…","claim":"DPS 0.55"} },
  "tickers": ["7010"], "word_count": 38,
  "self_confidence": 0.9 }
```

**Every sentence containing a number must carry a `[cN]` marker** mapping to a
`lake_object_id` the prompt supplied. The worker materializes `lake_citations` rows
(with `cited_value` and `cited_hash` frozen at draft time) before handing to edit.
A citation key referencing an object not in the supplied set fails the draft
immediately (the model may not invent sources), before rules even run.

### 7.2 Editor pass (EDITOR-1/2)

One `chatComplete("editor", …)` call: tighten prose, enforce template block structure,
never alter any number or citation (the diff is checked mechanically — numeric tokens
and `[cN]` markers must survive byte-identical; a violation kicks back to DRAFT).
Diff stats are stored on the pipeline item for the 27b agent trail.

### 7.3 Template auto-select (deterministic, per 28a–28h)

Evaluated in order by the editor worker in plain code — no LLM:

```
1. TPL-08  if citations include a VERDICT object (fair value + rating)        → force premium
2. TPL-07  if citations include IPO.OFFER facts object
3. TPL-04  if trigger is a results event AND a consensus table object is cited
4. TPL-05  if citations include a SCREENER.SNAPSHOT and body has ordered entities
5. TPL-06  if evergreen flag AND zero price-sensitive citations
6. TPL-02  if exactly one dominant numeric series object cited
7. TPL-03  if ≥70% of citations on one ticker AND word_count > 500
8. TPL-01  if single trigger event AND word_count < 90
else       TPL-03 default, WARN attached ("template fallback")
```

**Auto-publish gate** (the only human-free path):
`template = TPL-01 AND word_count ≤ 40 AND rules all-pass AND
newsroom_flags.auto_publish_wires = true AND no OPEN correction/confirm on any cited
object`. TPL-01 pieces of 41–89 words render in the wire template but queue for
approval. (Resolves open question #9; DEFAULTED — flipping the constant to 90 is a
one-line config change in `rule_sets`.)

Everything else → `approval_queue`:

```sql
create table approval_queue (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references content_items(id),
  pipeline_item_id uuid not null references pipeline_items(id),
  entered_at timestamptz not null default now(),
  sla_deadline timestamptz not null,        -- entered_at + interval '3 minutes' (24a/27b)
  status text not null default 'PENDING'
    check (status in ('PENDING','APPROVED','APPROVED_SCHEDULED','SENT_BACK','REASSIGNED_HUMAN')),
  decided_by uuid, decided_at timestamptz,
  send_back_note text, scheduled_for timestamptz
);
```

A pg_cron sweeper (`* * * * *`) marks near-breach items and pings the owner (push via
comms domain). SLA breach never auto-publishes — it only escalates louder.

---

## 8. Rules engine as a service

### 8.1 Shape

- Shared library `src/lib/rules/` (+ `_shared/rules/` for Deno) — pure functions, one per rule.
- Service endpoint: Edge Function `rules-engine`, consumed by (a) the pipeline `q_rules`
  worker, (b) Desk 25b "RUN RULES NOW" (human drafts — same rules, same versions), and
  (c) the 29b test console (`dry_run: true`).
- Versioned config:

```sql
create table rule_sets (
  version int primary key,                 -- V8, V9…
  active boolean not null default false,   -- exactly one active (partial unique index)
  rules jsonb not null,                    -- per-rule: enabled, mode BLOCK|WARN|AUTO_FIX|AUTO, params
  banned_phrases jsonb not null,           -- EN list; AR key present but empty (locked: EN only)
  beat_miss_thresholds jsonb not null,     -- TPL-04 verdict thresholds (29b)
  created_by uuid not null, created_at timestamptz default now()
);
create table rule_results (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null,
  ruleset_version int not null references rule_sets(version),
  actor text not null,                     -- agent_id or human uuid — violations feed shows both
  results jsonb not null,                  -- [{rule:'R-03', outcome:'PASS'|'WARN'|'BLOCK'|'FIXED', evidence:{…}}]
  passed boolean not null,
  created_at timestamptz not null default now()
);
```

### 8.2 Implementation sketch per rule

| Rule | Mode | Implementation |
|---|---|---|
| **R-01** disclaimer | AUTO-FIX | Deterministic: if the standard disclaimer block is absent, append it. Records `FIXED`. |
| **R-02** ticker tags resolve | BLOCK | `select ticker from instruments where ticker = any($1) and status='LISTED'` — any miss blocks with the offending tag as evidence. |
| **R-03** every claim cited, ≥2 primary sources | BLOCK | Deterministic: tokenize body; any sentence containing a numeric/percent/currency token must contain a `[cN]` marker; every marker must resolve to a `lake_citations` row whose object is VERIFIED **right now** (re-checked at rules time, not draft time). Distinct `source_agent`+`raw_snapshot` lineage count ≥ 2 for the piece (explainers TPL-06 exempt per scope). |
| **R-04** numbers within 0.5 % | BLOCK | Deterministic: for each citation, extract the numeric value(s) adjacent to the marker (unit-aware parser: SAR/AED/%, m/bn multipliers), compare against `cited_value` **and** current object payload; `abs(a-b)/b > 0.005` blocks with both values as evidence. Also catches drift when an object was corrected mid-pipeline. |
| **R-05** banned-claims lexicon | BLOCK | Deterministic: case/diacritic-normalized phrase match against `rule_sets.banned_phrases` (EN now; AR slot reserved). Same function is exported to the ads domain for creative checks. |
| **R-06** stretched metrics framed as risk | WARN (NOTES·TAKES only) | Hybrid: deterministic trigger list (payout>100 %, PE>60, leverage flags present in cited objects) → if triggered, one `chatComplete("classifier")` yes/no: "is this framed as risk, not advice?" WARN attaches the sentence. Never blocks; the owner sees it in 27b. |
| **R-07** corrections append note | AUTO | Not a submit-time check: DB trigger (§3) + publish-service behavior. `rules-engine` reports its standing status on the piece (OPEN correction flags block re-publish until note approved). |
| **R-08** retraction keeps URL | AUTO | Publishing-service invariant: `retract_content()` sets status RETRACTED, injects notice block, never deletes the route; excluded from auto-flow (front-page domain reads the status). |
| **R-09** premium cut after ≥1 data block | WARN (PREMIUM scope) | Deterministic: locate paywall-cut marker in block list; require at least one data-bound block (BLK-KEYSTATS/CHART/…) above it. |
| **R-10** headline ≤90 chars, clickbait-clean | AUTO-FIX | Deterministic length + clickbait lexicon check; on failure one `chatComplete("editor")` rewrite constrained to facts already in the piece, then re-check; second failure downgrades to BLOCK. |

Outcomes: any `BLOCK` → pipeline item back to DRAFT with the evidence appended to the
writer's retry prompt (max 2 rules-fail loops, then `REASSIGNED_HUMAN` — the 27a
"→HUMAN" action). `WARN`s ride along into 27b's checklist. `AUTO/AUTO-FIX` record what
they changed. Pass rates per rule aggregate nightly into `rule_pass_rates_7d` for 29b.

LLM cost of the rules engine is near-zero by design: only R-06 (rare, Takes/Notes only)
and R-10 repairs (rare) ever call a model.

---

## 9. Pipeline state machine, retries, dead letters, kill switches

### 9.1 Persistence

```sql
create table pipeline_items (
  id uuid primary key default gen_random_uuid(),
  trigger_object_id uuid not null references lake_objects(id),
  content_item_id uuid references content_items(id),   -- set once draft exists
  stage text not null default 'QUEUED' check (stage in
    ('QUEUED','CLASSIFYING','DRAFTING','EDITING','RULES','APPROVAL',
     'SCHEDULED','PUBLISHED','NOT_MATERIAL','REJECTED','REASSIGNED_HUMAN','DEAD')),
  template text, event_type text, priority text,
  writer_agent text references agent_accounts(agent_id),
  editor_agent text references agent_accounts(agent_id),
  confidence numeric(3,2),
  attempts int not null default 0,
  rules_fail_loops int not null default 0,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pipeline_transitions (      -- the 27a live run log, append-only
  id bigint generated always as identity primary key,
  pipeline_item_id uuid not null references pipeline_items(id),
  from_stage text, to_stage text not null,
  actor text not null,                   -- agent_id | human uuid | 'SYSTEM'
  detail jsonb,                          -- llm_run_id, diff stats, rule evidence…
  at timestamptz not null default now()
);
```

All stage changes go through one SQL function `fn_transition(item, to_stage, actor,
detail)` which validates legality against a static adjacency map, writes both tables,
and mirrors to `audit_log`. Illegal transitions raise — the state machine is enforced
in the database, not in worker discipline.

### 9.2 Retry & dead-letter policy

- **Infra failures** (LLM unavailable, timeout): exponential backoff 1 min → 5 min →
  15 min via `next_retry_at`; a pg_cron sweeper (`*/1 * * * *`) re-enqueues due items.
  After 5 attempts → stage `DEAD`, pgmq message archived (`pgmq.archive`), and a row in:

```sql
create table agent_errors (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null, pipeline_item_id uuid,
  severity text not null check (severity in ('infra','quality')),
  error_type text not null,      -- 'feed_parse_timeout','low_confidence','rules_fail','llm_unavailable'
  detail jsonb, retry_count int not null default 0,
  state text not null default 'OPEN' check (state in ('OPEN','RESOLVING','MUTED','RESOLVED')),
  muted_until timestamptz, created_at timestamptz default now()
);
```

  which is the 27a error queue verbatim: Desk actions RETRY (reset attempts, re-enqueue),
  MUTE 1H (`muted_until`), RE-RUN (new pipeline item from same trigger), →HUMAN
  (stage `REASSIGNED_HUMAN`).
- **Quality failures** (confidence < 0.65, JSON contract, rules loop exhausted): no
  silent retry — always surface (kickback row) because retrying the same model on the
  same input mostly re-buys the same mistake.
- **DEAD is never deletion**: trigger object, verdict, and partial drafts remain
  queryable; DEAD items appear in a Desk "dropped work" view.

### 9.3 Kill switches

`newsroom_flags` (single-row-per-key config table, owner/EIC-writable, audit-logged):

| key | effect |
|---|---|
| `auto_publish_wires` (bool, default true) | OFF → auto-gate routes everything to approval (27a guardrail toggle) |
| `pause_all` | workers drain nothing; queues accumulate (pause-all) |
| `freeze_all` | break-glass: as pause_all **plus** unpublish nothing / publish nothing even from approval actions; notifies editors (31a) |
| `llm_budget_usd_month` | §1.7 budget ladder |

Per-agent: `agent_accounts.enabled = false` stops that agent's work specifically;
writer pool falls back to remaining writers (round-robin assignment simply skips
disabled accounts).

---

## 10. Newsletter & analytics agents

### 10.1 NEWSLETTER-1 — Wire Brief

Two editions (33c: AM 06:00 GST, PM 16:30 GST; reader copy says 07:30 — the send *time*
is a comms-domain config value, our job is assembly. DEFAULTED: assemble AM at
05:40 GST, PM at 16:10 GST, hand to the send queue 20 min before the configured send).

pg_cron (UTC = GST − 4):

```
'40 1 * * *'   wire-brief-assemble  (edition=AM)   -- 05:40 GST daily
'10 12 * * *'  wire-brief-assemble  (edition=PM)   -- 16:10 GST daily
```

Assembly is mostly deterministic SQL: index snapshot (delayed, labeled), lead story
(top approval-ranked piece since last edition), 3 briefs (recency × read-velocity),
per-user watchlist digest is a **merge-field query, not an LLM task** (triggered
alerts + filings counts per recipient computed in one set-based query). Exactly one
LLM call per edition: `chatComplete("summarizer")` writes the 60-word lead-in from the
selected items (with citations already carried by those items — no new claims allowed;
the R-05 lexicon check runs on the output). The PM edition's "hold slot for pending
piece" behavior: assembly re-runs at send-minus-5 if a flagged slot's piece went LIVE.

Rendered MJML→HTML batches go to `q_sends` for the comms domain's dispatcher.
**Flag, out of scope but material:** at the fixture's 42,180 recipients daily this is
~1.3 M emails/mo — on Amazon SES ≈ $130/mo, on anything fancier much more. At launch
(near-zero recipients) it is $0; the comms architect should pick SES early so the
number scales linearly and boringly.

### 10.2 ANALYTICS-1

- Nightly (`'30 20 * * *'` UTC = 00:30 GST): SQL rollups — pipeline throughput,
  lake→live medians, per-template usage counts, rule pass rates, `llm_cost_daily` — the
  material behind 27a's 7-day strips. Pure SQL, $0.
- Weekly (Sunday 05:00 GST = `'0 1 * * 0'` UTC): one `chatComplete("summarizer")` call
  turns the week's rollups into a 200-word owner digest appended to the AM Wire Brief's
  internal edition. Cost: pennies.

Neither agent can touch reader-facing publishing paths (scopes, §2.1).

---

## 11. LLM cost model

Assumptions (early-production volume, all 6 venues live): ~120 lake intake events/day
survive the deterministic pre-filter or need LLM triage; ~55 material pieces/day
(≈ 40 auto-wires TPL-01, ≈ 12 stories TPL-02/03/04/05/07, ≈ 3 premium Takes/deep
pieces TPL-08 weekly-averaged), matching the 27a fixture's 348 total agent runs/day of
which most are data-agent runs, not LLM runs.

Per-piece token budgets (prompt includes context bundle; caching not assumed —
OpenRouter/local don't share Anthropic's cache):

| Stage | in / out tokens | Wire | Story | Take |
|---|---|---|---|---|
| classify (when LLM needed) | 1,200 / 150 | ✓ | ✓ | ✓ |
| draft | 5,000 / 500 (wire) · 8,000 / 1,200 (story) · 12,000 / 2,500 (take) | ✓ | ✓ | ✓ |
| edit | 4,000 / 400 · 7,000 / 900 · 10,000 / 1,800 | ✓ | ✓ | ✓ |
| rules (R-10 fix, ~15 % of pieces) | 1,500 / 120 | amortized | | |

**Per-article cost by tier** (list prices, July 2026: Sonnet 4.6 $3 in / $15 out per
Mtok; Haiku 4.5 $1/$5; Hermes-3-70B via OpenRouter ≈ $0.12/$0.30 — verify current
OpenRouter card; local = $0 API + owner's electricity):

| Tier | Wire (~10k in / 1k out) | Story (~16k in / 2.3k out) | Take (~23k in / 4.5k out) |
|---|---|---|---|
| **Sonnet-tier (all stages Sonnet)** | ≈ $0.045 | ≈ $0.083 | ≈ $0.137 |
| **Hermes-tier (all OpenRouter)** | ≈ $0.0015 | ≈ $0.0026 | ≈ $0.0041 |
| **Local (Ollama on M-series Mac)** | $0 (≈ 30–90 s/piece on a 70B q4; fine for wires off-peak, marginal for market-hours latency) | $0 | $0 |

**Monthly at 55 pieces/day (30 days):**

| Posture | Est. monthly LLM spend |
|---|---|
| All Sonnet | ≈ $95–135 |
| **Default hybrid** (Hermes classifier/editor/wires + Sonnet story-writer & Takes) | **≈ $25–40** |
| All Hermes | ≈ $4–8 |
| All local | ≈ $0 (latency + Mac-must-be-on operational risk) |
| + embeddings (gte-small in Edge Functions) | $0 |
| + newsletter & analytics summarizer calls | < $1 |

The env-map makes every posture a config change; the budget ladder (§1.7) auto-degrades
toward Hermes if spend runs hot. Prompt caching upside: if the owner locks writer/editor
to Anthropic, adding `cache_control` on the stable system+style prefix cuts the Sonnet
posture roughly 30–40 % (reads at ~0.1×); the gateway leaves room for a
`providerExtras` passthrough for this, but it is **deferred** until the owner actually
picks all-Anthropic (no benefit on OpenRouter/local).

---

## 12. Provenance record per article

Frozen at publish time (approval or auto-gate), immutable thereafter:

```sql
create table provenance_records (
  content_item_id uuid primary key references content_items(id),
  published_at timestamptz not null,
  ruleset_version int not null,
  citations jsonb not null,     -- [{claim_key, lake_object_id, object_type, cited_value,
                                --   cited_hash, object_verified_at, source_agent, raw_snapshot_id}]
  agent_chain jsonb not null,   -- [{stage:'draft', agent:'WRITER-2', llm_run_id, provider, model,
                                --   confidence, started_at, ended_at}, {stage:'edit', …},
                                --   {stage:'rules', results_id}, {stage:'approve', actor, at}]
  rule_results_id uuid not null references rule_results(id),
  verified_vs_lake text not null,   -- '14/14' — citations re-verified at publish instant
  confidence numeric(3,2) not null  -- min of chain confidences
);
```

This single row powers: 27b's per-claim provenance panel and agent trail, TPL-08's
"VERIFIED VS LAKE 14/14" chip (`verified_vs_lake` recomputed against current hashes on
render is the *live* number; the stored one is the at-publish number), R-07 flagging
(via `lake_citations`, which stays the live join), and the public "how we know this"
methodology promise in 20f. Byline chain on the article page renders from
`agent_chain` (WRITER-2 → EDITOR-2 pattern of 28b).

---

## 13. Orchestration runtime — evaluation & recommendation

| Option | Fit | Verdict |
|---|---|---|
| **Vercel cron + serverless functions** | Vercel cron on Hobby allows only daily crons (2 max); Pro allows more but sub-minute polling is impossible, function timeouts (10–60 s default tiers) squeeze multi-call LLM work, and the queue would still have to live somewhere. | Rejected as the engine. **Kept as failsafe heartbeat**: one daily Vercel cron (`0 2 * * *`) hits `/api/newsroom/health`, which verifies pg_cron ran in the last hour and alerts the owner if not — a watchdog outside the watched system, $0. |
| **Supabase: pg_cron + pgmq + Edge Functions** | pgmq + pg_cron are right, but Edge-Functions-as-workers fails on arithmetic (five 10-second tick loops ≈ 0.65–1.34M invocations/mo against quotas, plus ~40K `cron.job_run_details` rows/day of DB bloat) and adds a third runtime the platform doc explicitly forbids. | **Superseded — pgmq + pg_cron retained, Edge Function workers dropped.** |
| **VPS resident pgmq consumers (06's `marsad-worker`)** | The VPS already exists (and is already paid for) to host Playwright scraping — running the pipeline consumers in the same Node process removes the invocation quotas, the tick storm, the Deno `_shared` copy of the gateway, and the third runtime. Consumers use `pgmq.read_with_poll` (1 s), so pipeline latency *improves* vs 10 s ticks. Redis/BullMQ still rejected (§ same reasons as 06 §5). | **Recommended. Chosen.** |

Worker inventory (Supabase Edge Functions):
`pipeline-classify`, `pipeline-write`, `pipeline-edit`, `rules-engine`,
`pipeline-publish`, `wire-brief-assemble`, `newsroom-sweeper` (retries + SLA timers),
`analytics-rollup`. All share `_shared/llm/`, `_shared/rules/`, `_shared/db.ts`.
Each is invoked by pg_cron via `pg_net` with an `X-Newsroom-Secret` header; no public
invocation path.

Cron table (pg_cron, UTC; GST = UTC+4):

```sql
select cron.schedule('intake-tick',    '10 seconds', $$select net.http_post(…pipeline-classify…)$$);
select cron.schedule('draft-tick',     '10 seconds', …pipeline-write…);
select cron.schedule('edit-tick',      '10 seconds', …pipeline-edit…);
select cron.schedule('rules-tick',     '10 seconds', …rules-engine…);
select cron.schedule('publish-tick',   '10 seconds', …pipeline-publish…);
select cron.schedule('sweeper',        '* * * * *',  …newsroom-sweeper…);      -- retries + SLA
select cron.schedule('brief-am',       '40 1 * * *', …wire-brief-assemble AM…);-- 05:40 GST
select cron.schedule('brief-pm',       '10 12 * * *',…wire-brief-assemble PM…);-- 16:10 GST
select cron.schedule('analytics',      '30 20 * * *',…analytics-rollup…);      -- 00:30 GST
select cron.schedule('llm-cost-rollup','0 20 * * *', $$select fn_rollup_llm_costs()$$); -- 00:00 GST
```

Quiet hours (22:00–07:00 GST) do **not** pause the pipeline — pieces still draft and
queue (Sun–Thu markets open at 10:00 GST; overnight disclosures should be ready at
open). Quiet hours throttle *reader notifications*, which is the comms domain's gate on
`q_sends`, with the halt-alert bypass living there.

Off-hours economy (DEFAULTED): the 10-second ticks drop to 60 seconds outside
06:00–19:00 GST Sun–Thu via a guard clause in the tick function reading the venue
calendar — trivially reversible.

---

## 14. Deliberately deferred (cheapest-possible discipline)

- **Arabic**: schema slots exist (`banned_phrases.ar`, `summary_en` naming) but no AR
  columns, prompts, or lexicon entries are built. Locked decision 4.
- **Anthropic prompt caching**: only pays off in an all-Anthropic posture; wired as a
  passthrough, not implemented.
- **Local-LLM tunnel** (Cloudflare/Tailscale) for production Ollama: documented, not
  provisioned.
- **VPS/BullMQ migration path**: documented trigger conditions (§13), zero build now.
- **Streaming/token-by-token UX** in Desk previews: pipeline is batch; drafts appear
  when done. Streaming adds complexity with no reader value.
- **Embedding backfill of the historical 4.2 M-object lake**: only prose-bearing types
  are embedded forward from day one; backfill is a one-off script to run if related-
  context quality disappoints.
- **Multi-writer specialization tuning** (distinct prompts per WRITER-1/2/3 beat):
  day one they share one prompt library keyed by template; per-beat prompt packs are an
  optimization once output volume justifies it.
- **Consensus-estimates ingestion** (open question #10): TPL-04's consensus table
  consumes whatever `ESTIMATE.*` objects the lake holds; sourcing/licensing them is
  explicitly not solved here — until it is, TPL-04 degrades to prior-period comparison
  and the classifier tags results events `story` instead of `wire+recap`.
- **WhatsApp channel, ads adjacency, entitlement rendering**: other domains; the rules
  engine exports the R-05 checker to ads, nothing more.

## 15. DEFAULTED decisions (owner may override)

1. Auto-publish word gate = **40 words** (not 90). §7.3.
2. Default model posture = **Scenario B, open-weights via OpenRouter for every role**
   (aligned with 06 §7.1 — cheapest-possible is locked; the human approval gate covers
   quality for everything above a wire). The hybrid Hermes/Sonnet posture in §1.5 is the
   **first quality-triggered upgrade** (rules-fail > 15% or owner send-back > 30%), not the
   default. Monthly LLM budget alarm **$60**. §1.5, §1.7.
3. Twelve-account roster completed with `NEWSLETTER-1` and `ANALYTICS-1`. §2.1.
4. Wire Brief: **one platform schedule (06 §4.1 is authoritative)** — AM assembled 06:45 GST,
   sent 07:30 GST daily; PM assembled 16:10, sent 16:30 GST on trading days, enabled in a
   later phase. §10.1's 05:40/16:10 assembly times are superseded.
5. Classifier confidence floor 0.65 routes to `watch`, not discard. §6.2.
6. Rules-fail loop limit = 2 before reassignment to human. §8.2.
7. Off-hours economy: consumer poll interval relaxes 1 s → 30 s outside 06:00–19:00 GST
   (replaces the obsolete 10 s → 60 s tick decay). §13.
8. Local Ollama = dev-only until a tunnel is requested; production Scenario C goes through
   Tailscale from the VPS per 06 §9. §1.6.

---

## Revisions (post-review)

Six blocking issues were raised; all are accepted and resolved as follows. Where sections
above conflict with this list, **this list and the cross-referenced owning documents win**.

1. **Runtime contradiction resolved — the pipeline runs on the VPS.** 06-infra-cost.md is the
   placement authority. The worker inventory in §13 ships as **modules of 06's single
   `marsad-worker` Node process** (`worker/src/agents/*.ts`), consuming pgmq with
   `read_with_poll(1s)`. Consequences applied throughout: no Edge Functions, no `pg_net`
   HTTP ticks, no 10-second pg_cron entries, no Deno `_shared/llm` copy (the worker imports
   `src/lib/llm/*` via tsconfig path alias — **§1's gateway spec is the platform-canonical
   LLM gateway**, and 06 §9's env contract is merged into §1.4's richer form: provider
   registry + per-role `LLM_ROLE_*` map + fallback chains). The queue names consolidate to
   06's: **`q_pipeline` carries all newsroom stages** with a `stage` field in the message
   (`classify|draft|edit|rules|publish`); `q_intake/q_draft/q_edit/q_rules/q_publish` are
   logical stages, not separate queues; `q_sends` → `q_email`. Edge-quota and
   `cron.job_run_details` bloat math is moot (no ticks), but a daily
   `cron.job_run_details` purge (>7 days) is added to the platform retention job regardless.
2. **Visibility timeouts fixed for LLM work.** `q_pipeline` reads use **vt = 600 s and
   qty = 1** for LLM stages (matching 06 §5); deterministic stages may batch. A
   stalled-stage sweep (every 5 min) requeues items stuck in CLASSIFYING/DRAFTING/EDITING
   past 2× vt with no live message — the crash-after-delete stranding case is now covered.
   Retry ownership is explicit: **pgmq vt owns transport-level redelivery; the sweeper owns
   business-level retry via `next_retry_at`; a worker that catches an error always archives
   the message first** — the two mechanisms can no longer both resurrect the same work.
3. **Newsletter agent no longer breaches "agents never publish."** The Wire Brief lead-in is
   **extractive-only at v1**: the first sentences of the lead story (already rules-checked
   and owner-approved), assembled deterministically at $0 — no LLM text reaches 42K inboxes
   without having passed the full gate. DEFAULTED — the owner may re-enable the generated
   lead-in later, in which case the assembled brief runs the full rules engine and lands in
   the approval queue with a send-deadline SLA before `q_email`.
4. **Schema contract drift eliminated — 02-data-lake.md owns all table shapes.** Mapping
   applied to every reference above: `lake_objects` → `lake.objects` (states
   PENDING/VERIFIED/CONFLICT/**RETIRED**, `superseded_by` not `revision_of`,
   `price_sensitive` not `requires_human_confirm`); `lake_citations` → `lake.citations`;
   `agent_accounts` → `iam.agent_accounts` (+ `iam.principals`); `newsroom_flags` →
   `iam.global_switches`; `pipeline_items`/`pipeline_transitions` → `ops.pipeline_items` +
   `ops.agent_runs`-backed transitions; `agent_errors` → `ops.agent_errors`; `rule_sets` →
   `ops.rulesets`/`ops.rules`; `rule_results` → `ops.rule_violations`; `llm_runs` →
   `ops.llm_runs` (new table, DDL as §1.7 but in `ops`); `approval_queue` →
   **`ops.pipeline_items` at stage 'approval'** (no separate queue table; SLA fields live on
   the pipeline row; 05's Desk reads the same rows). **The R-07 correction trigger is owned
   by 02** (on `lake.object_revisions`) — §3's `trg_lake_correction` is deleted, and the
   intake trigger is restated against 02: `AFTER UPDATE ... WHEN (OLD.state <> 'VERIFIED'
   AND NEW.state = 'VERIFIED')` **plus** `AFTER INSERT ... WHEN (NEW.state = 'VERIFIED')`
   (revision re-scrapes and backfills insert rows already VERIFIED).
5. **R-03 lineage semantics defined for the auto-publish path.** Source counting for R-03
   walks each citation to its lineage roots (`object → parse_runs → snapshots`); COMPUTED
   objects inherit the roots of their inputs. The rule requires **≥ 2 distinct snapshot
   roots across the piece** — for a single-disclosure dividend wire this is satisfied by the
   filing PDF plus the corporate-actions-page cross-check that 02's verification already
   demands for price-sensitive VERIFIED objects (the 33b registrar/disclosure pattern). If
   only one root exists, the wire is **not blocked but loses auto-publish eligibility** and
   routes to the approval queue — the human-free path degrades to the human path, never to
   silence or a quietly weakened rule.
6. **Approval SLA = 3 hours** (aligned with 05; the design's "3:00" timers read as an
   operable owner SLA, stored in config as `approval_sla_minutes: 180`); §7.3's
   `'3 minutes'` default is superseded. SLA clock pauses during owner quiet hours
   22:00–07:00 GST except for halt wires and price-sensitive confirms (05 Revisions).

Improvements adopted: kill-switch flags re-checked **between every message**, not per
invocation batch; the useless partial index `on lake_objects (state) where state='VERIFIED'`
is dropped (the partial-index predicate already filters — 02's `objects_type_state_idx`
covers the scans); fallback chains must span **two model families** (e.g. Hermes → Llama-3.3
→ Haiku) with a worker-boot env probe of every configured provider:model; Anthropic
OpenAI-compat caveats recorded (max_tokens required — default 1024 covers it;
response_format ignored — prompt-fallback JSON is the anthropic-path behavior; prompt
caching/Batch API unreachable, so the §11 caching upside applies only if a native transport
is later added behind the same `chatComplete` signature); `SCHEDULED → LIVE` actor named:
the worker's publish handler sweeps `content_items.scheduled_at <= now()` each minute and
calls `publish_content` as SYSTEM; the embedder role resolves to **in-process ONNX
(gte-small via fastembed) on the VPS** — `supabase:gte-small` was Edge-only and is dropped;
embedding work is deferred to the AI phase per 04 (FTS-first); watchdog upgraded: the daily
Vercel heartbeat now also asserts **pgmq queue depth and oldest-message age** via
`/api/health` (06 §6) so a dead worker with a live pg_cron cannot back up invisibly;
DEVELOPING-story updates are **out of scope v1** — every new VERIFIED object spawns a new
piece linked by ticker/event; corrections remain flag-only (stated, no longer implicit).

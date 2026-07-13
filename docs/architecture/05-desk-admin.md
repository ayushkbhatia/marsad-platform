# 05 — Marsad Desk: Admin Console, RBAC & Audit

> Domain architecture for the Marsad Desk admin console, the unified principals/RBAC model
> (humans + 12 agent service accounts), the append-only audit log, the owner approval queue,
> versioned config documents, owner auth hardening, self-hosted analytics, and the feed-health /
> incident-banner surface. Companion to `docs/design-analysis.md` (screen catalog §2.6, entity
> model §3, state machines §4, jobs §5, rules §6).
>
> Stack constants: Next.js 15+ App Router (repo currently on `next@16.2.10`), Supabase project
> `yjsncnpbjuueaoeejrqj` (ap-south-1 Postgres), Vercel. All times below are stored UTC; GST =
> UTC+4, so cron expressions are given in UTC with the GST time noted. Cost ceiling is the locked
> constraint: the design below adds **$0/month** of new infrastructure on top of the existing
> Supabase (~$10/mo) + Vercel plans.

---

## 1. Route map — `/desk`

Everything lives under `src/app/desk/`. One shared layout (`src/app/desk/layout.tsx`) renders the
dark **AdminRail** (`src/components/desk/AdminRail.tsx`) on the left and the paper canvas on the
right, and performs the server-side principal check (§7) before rendering anything. Desk is
desktop-only by design; the layout renders a "Desk requires a desktop browser" interstitial below
1024px rather than attempting responsive admin UI.

| Screen | Route | Page file | Notes |
|---|---|---|---|
| 24a Desk dashboard | `/desk` | `src/app/desk/page.tsx` | KPI strip, needs-attention queue, feed health, approval preview, audit tail |
| 24b Navigation manager | `/desk/nav` | `src/app/desk/nav/page.tsx` | Edits the `nav` config doc (§5); live preview imports the real `MarsadNav` component |
| 25a Content library | `/desk/content` | `src/app/desk/content/page.tsx` | 1,842 items, status facets, bulk actions |
| 25b Article editor | `/desk/content/[id]` | `src/app/desk/content/[id]/page.tsx` | Block editor, RUN RULES NOW calls the rules service, revisions |
| 25c Front-page curation | `/desk/frontpage` | `src/app/desk/frontpage/page.tsx` | Edits the `frontpage` config doc; staged → instant publish |
| 26a Analytics overview | `/desk/analytics` | `src/app/desk/analytics/page.tsx` | Rollups + live tail + on-site-now (§8) |
| 26b Content drilldown | `/desk/analytics/[contentId]` | `src/app/desk/analytics/[contentId]/page.tsx` | Hourly curve, scroll funnel, referrers |
| 27a Agents console | `/desk/agents` | `src/app/desk/agents/page.tsx` | Fleet strip, error queue, run log, guardrail toggles |
| 27b Approval review | `/desk/approvals` and `/desk/approvals/[itemId]` | `src/app/desk/approvals/[itemId]/page.tsx` | Queue tabs w/ SLA timers; the one-click approve transaction (§4) |
| 29a Data lake browser | `/desk/lake` | `src/app/desk/lake/page.tsx` | Object ledger, conflict inspector, lineage, coverage board |
| 29b Publishing rules | `/desk/rules` | `src/app/desk/rules/page.tsx` | Edits the `ruleset` config doc; owner-only; test console |
| 30a Subscribers overview | `/desk/subscribers` | `src/app/desk/subscribers/page.tsx` | Funnel, cohorts, dunning card |
| 30b Member detail | `/desk/subscribers/[memberId]` | `src/app/desk/subscribers/[memberId]/page.tsx` | Role-gated comp/refund/cancel; PDPL export/delete |
| 31a Team roster | `/desk/team` | `src/app/desk/team/page.tsx` | Humans + 12 agent accounts, key rotation, kill switches, break-glass |
| 31b Permissions + audit | `/desk/team/permissions` | `src/app/desk/team/permissions/page.tsx` | Capability matrix (read-only render of `permissions_policy` config doc) + audit log browser/export |
| 32a Ads campaigns | `/desk/ads` | `src/app/desk/ads/page.tsx` | Pacing, creative approval (runs R-05) |
| 32b Ad slot inventory | `/desk/ads/slots` | `src/app/desk/ads/slots/page.tsx` | 6 fixed slots, in-situ preview, adjacency rules |
| 33a Market data ops | `/desk/data` | `src/app/desk/data/page.tsx` | Feed cards from heartbeats (§9), halts desk, incident banner composer, calendars |
| 33b Listings & payouts desk | `/desk/data/listings` | `src/app/desk/data/listings/page.tsx` | IPO objects + dividend confirm → fan-out |
| 33c Monetization & comms | `/desk/monetization` | `src/app/desk/monetization/page.tsx` | Owner-only; edits `meters_pricing` + `throttles` config docs; send queue |

Supporting API surface:

- `src/app/api/desk/**` — mutations invoked by desk pages that are not plain Server Actions
  (CSV/audit export streaming, analytics tail polling). Every handler re-verifies the principal;
  we never trust that middleware ran (Next middleware bypasses have shipped as CVEs before).
- `src/app/api/agents/v1/**` — the **agent gateway** (§3.4). Agents never receive Supabase
  credentials; they hold scoped API keys and talk only to these routes.
- `src/app/api/e/route.ts` — public analytics ingestion beacon (§8).

AdminRail nav entries are filtered by capability (§2.3): a Support principal sees Subscribers and
the dashboard only; an Analyst sees content/lake/data surfaces but not billing; only the Owner
sees Rules, Monetization, and Team management actions. The rail also carries the global incident
chip (feed degraded / break-glass active) fed from `venue_feed_status` (§9).

---

## 2. Unified principals model

### 2.1 One table for humans and agents

Humans and the 12 agent service accounts are rows in **one** table so that RBAC, kill switches,
and audit attribution are structurally identical — the core requirement from 31a/31b.

```sql
create type principal_kind as enum ('human', 'agent', 'system');
create type agent_class    as enum ('data', 'writer', 'publishing');
create type human_role     as enum ('owner', 'eic', 'reporter', 'analyst', 'support');

create table principals (
  id             uuid primary key default gen_random_uuid(),
  kind           principal_kind not null,
  display_name   text not null,                    -- 'A. Bhatia' / 'DATA-MSX'
  -- humans
  auth_user_id   uuid unique references auth.users (id),
  role           human_role,                        -- null for agents
  is_reviewer    bool not null default false,       -- Workbench reviewer flag (see below)
  -- agents
  agent_code     text unique,                       -- 'DATA-TDWL', 'WRITER-2', 'EDITOR-1'…
  class          agent_class,                       -- null for humans
  scope_note     text,                              -- display string from 31a
  owner_id       uuid references principals (id),   -- every agent has a human owner
  -- shared operational state
  status         text not null default 'active',    -- active | idle | erroring | suspended
  kill_switch    bool not null default false,       -- per-agent hard stop (31a)
  created_at     timestamptz not null default now(),
  check ((kind = 'human') = (auth_user_id is not null)),
  check ((kind = 'agent') = (agent_code is not null))
);
```

Seed: 1 `system` row (`SYSTEM`, actor for pg_cron jobs and auto-flows), the owner, up to 5 other
humans, and exactly 12 agents: `DATA-TDWL`, `DATA-DFM`, `DATA-ADX`, `DATA-QE`, `DATA-MSX`,
`DATA-BHB` *(the design names DATA-FILINGS/-NEWS/-GULF/-MSX; the data-agent split is owned by the
newsroom domain — this table just holds whatever 12 codes that domain fixes)*, `WRITER-1..3`,
`EDITOR-1..2`, plus a filings/news data agent as that domain defines. The constraint that matters
here: **12 agent rows, 3 classes, each with a human `owner_id` and a key-rotation record.**

**Roles.** Open question 16 (Desk roles vs Workbench "Reviewer") is resolved as: **Reviewer is
not a sixth role; it is the `is_reviewer` flag grantable on `analyst` and `eic` principals**,
unlocking the Workbench reviewer queue (20e) without adding a matrix column. DEFAULTED — owner
may override.

### 2.2 Custom JWT claim

A Supabase **Custom Access Token auth hook** (`supabase/functions/custom-claims/` registered as
the `custom_access_token_hook`) injects `desk_role` and `principal_id` into every human JWT at
mint time by looking up `principals` on `auth_user_id`. RLS policies and the Next middleware read
the claim without an extra query. Readers (no `principals` row) simply get no claim, and every
desk RLS policy fails closed.

### 2.3 Capability matrix (from 31b)

Eleven capabilities, five human roles, three agent classes. The matrix is **data, not code**: it
is the `permissions_policy` config document (§5), currently policy **V6**, rendered read-only on
31b and editable by the owner only. Enforcement reads the live policy through
`src/lib/desk/authz.ts` (`can(principal, capability, ctx?)`).

| # | Capability | Owner | EIC | Reporter | Analyst | Support | DATA | WRITER | PUBLISHING |
|---|---|---|---|---|---|---|---|---|---|
| C01 | `content.draft` — create/edit drafts, notes, datapoints | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ (edit only) |
| C02 | `content.publish` — move content to LIVE/SCHEDULED | ✓ | ✓ | — | — | — | — | — | ⚠ **WIRE ≤40W** |
| C03 | `approvals.decide` — approve/schedule from queue | ✓ | ⚠ send-back & reassign only | — | — | — | — | — | — |
| C04 | `surfaces.config` — nav manager, front-page curation | ✓ | ✓ | — | — | — | — | — | — |
| C05 | `rules.edit` — publishing ruleset versions | ✓ | — | — | — | — | — | — | — |
| C06 | `lake.write` — create/update lake objects | ✓ | — | — | ⚠ datapoints w/ source | — | ✓ | — | — |
| C07 | `market.ops` — conflict resolve, price-sensitive confirms, halts, banners, calendars | ✓ | ✓ | — | ⚠ FLAG ONLY | — | ⚠ FLAG ONLY | — | — |
| C08 | `subscribers.billing` — comp/refund/cancel, PDPL actions | ✓ | — | — | — | ⚠ export **W/ OWNER OK** | — | — | — |
| C09 | `ads.manage` — campaigns, creatives, slots | ✓ | ✓ | — | — | — | — | — | — |
| C10 | `team.manage` — principals, keys, kill switches, policy versions | ✓ | — | — | — | — | — | — | — |
| C11 | `config.monetization` — meters, prices, promos, comms throttles | ✓ | — | — | — | — | — | — | — |

⚠ = conditional (amber) grant; the condition is encoded in the policy JSON
(`{"cap":"content.publish","grant":"conditional","condition":{"template":"TPL-01","max_words":40}}`)
and evaluated by `can()` with a context object, not by scattered `if`s.

**Auto-publish word limit** (open question 9): the agent auto-publish gate is **≤40 words**
(the stricter number, quoted everywhere the guardrail is stated); TPL-01 as a template also
serves human-approved wires up to 90 words. DEFAULTED — owner may override.

### 2.4 Negative scopes for agents — enforced twice

Agent capability is deny-by-default (the matrix above grants agents almost nothing), but the
three hard lines — **never publish (beyond the ≤40-word wire), never billing, never rules** —
get a second, database-level enforcement so that even a bug in the gateway cannot cross them:

1. **Gateway layer** (`src/lib/desk/authz.ts`): `can()` returns false unless explicitly granted;
   `assertNotDenied()` additionally checks a static `AGENT_DENYLIST` =
   `['content.publish*', 'subscribers.*', 'billing.*', 'rules.*', 'team.*', 'config.*', 'ads.*']`
   (publish carve-out only via the TPL-01 conditional path, and only while the
   `auto_publish_wires` flag is on).
2. **Postgres layer**: every request that reaches the database runs inside a transaction where
   the gateway has set `app.principal_id` / `app.principal_kind` via
   `select set_config('app.principal_id', $1, true)` (transaction-local, safe under PgBouncer).
   `BEFORE INSERT OR UPDATE OR DELETE` triggers on `orders`, `subscriptions`, `invoices`,
   `config_docs`, `ad_campaigns`, `ad_slots`, and on the `status` transition to `live` in
   `content_items`, raise an exception when `app.principal_kind = 'agent'` (with the single
   codified TPL-01 exception checked inside the content trigger: template = TPL-01, word count
   ≤ 40, `auto_publish_wires` flag true, agent class = publishing). The trigger function is
   `fn_enforce_agent_negative_scopes()` in `supabase/migrations/`.

### 2.5 Agent API keys — issuance & rotation

Agents authenticate to the gateway with bearer keys; they never hold Supabase service keys.

```sql
create table agent_api_keys (
  id            uuid primary key default gen_random_uuid(),
  principal_id  uuid not null references principals (id),
  key_prefix    text not null,             -- 'mk_a_7f3c' — shown in the roster UI
  key_hash      bytea not null,            -- sha256 of full secret; plaintext never stored
  created_by    uuid not null references principals (id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz not null,      -- issued for 90 days
  revoked_at    timestamptz
);
create unique index on agent_api_keys (key_hash);
```

- **Issue** (`/desk/team`, owner only, C10): server generates `mk_a_<4-char prefix>_<32 bytes
  base62>`, stores the SHA-256, shows the plaintext exactly once. Audit event `TEAM/key.issue`.
- **Verify** (gateway hot path): SHA-256 the presented token, single indexed lookup, check
  `revoked_at is null and expires_at > now()`, then load the principal and check
  `kill_switch = false` and the two global flags (§2.6). `last_used_at` updated at most once per
  5 minutes (cheap write suppression).
- **Rotate**: issuing a new key does **not** revoke the old one; the old key gets
  `expires_at = now() + interval '24 hours'` (grace overlap so the agent runtime can swap env
  vars without downtime). The Desk dashboard needs-attention queue surfaces any key older than
  75 days ("rotation due").
- No self-service: agents cannot mint or rotate their own keys (C10 is owner-only, and the
  gateway exposes no key endpoints).

### 2.6 Kill switches

Three levels, all instant (checked on every gateway request; no cache longer than 10 seconds):

| Switch | Storage | Effect |
|---|---|---|
| Per-agent kill (31a) | `principals.kill_switch` | Gateway returns 423 for that agent; roster shows KILLED |
| Auto-publish toggle (27a guardrails) | `system_flags` key `auto_publish_wires` (default `true`) | TPL-01 wires route to the approval queue instead of publishing; nothing else changes |
| Break-glass freeze-all (31a) | `system_flags` key `global_agent_freeze` (default `false`) | Every agent request 423s; flipping it writes audit event `TEAM/break_glass.on` and enqueues a notification email to all Editor+ humans |

```sql
create table system_flags (
  key        text primary key,        -- 'auto_publish_wires' | 'global_agent_freeze'
  value      jsonb not null,
  updated_by uuid references principals (id),
  updated_at timestamptz not null default now()
);
```

Flag flips are Server Actions gated on C10 (freeze, per-agent kill) / C03 (auto-publish toggle,
so the owner can hit it from 27a), each writing an explicit audit entry with the before value.

---

## 3. Agent gateway

`src/app/api/agents/v1/**` route handlers, thin by design:

```
POST /api/agents/v1/lake/objects          (DATA)      upsert lake objects → PENDING
POST /api/agents/v1/lake/heartbeat        (DATA)      scraper heartbeat (§9)
POST /api/agents/v1/drafts                (WRITER)    create draft citing VERIFIED objects
POST /api/agents/v1/drafts/:id/revise     (WRITER)    respond to send-back note
POST /api/agents/v1/pipeline/:id/advance  (PUBLISHING) edit → rules-run → queue/auto-publish
GET  /api/agents/v1/tasks                 (all)       poll for assigned work incl. send-backs
POST /api/agents/v1/flags                 (all)       FLAG-ONLY corrections/conflicts for humans
```

Shared wrapper `withAgentAuth(handler, requiredCapability)` in
`src/lib/desk/agent-gateway.ts`: verify key → load principal → check kill switches → check
capability + denylist → open a Supabase transaction (service-role client), `set_config` the
principal GUCs → run handler → audit rows are produced by triggers plus explicit semantic
inserts. Every response includes `X-Marsad-Request-Id`, which is also stamped into the audit rows
for cross-correlation.

Rate limiting: a per-principal token bucket in Postgres (`agent_rate_limits` row per agent,
updated with a single `update … returning`; 120 requests/min default). Not Redis — at 12 agents
the extra hop and $10+/mo for a hosted Redis buys nothing. DEFERRED: move to Upstash only if
gateway p95 shows contention.

---

## 4. Approval queue backend (27b, feeds 24a)

### 4.1 Tables

```sql
create table approval_items (
  id             uuid primary key default gen_random_uuid(),
  content_id     uuid not null references content_items (id),
  template_id    text not null,                    -- 'TPL-01'…'TPL-08'
  confidence     numeric(4,3),                     -- from the writing pipeline
  entered_at     timestamptz not null default now(),
  sla_deadline   timestamptz not null,             -- entered_at + live SLA (default 3h)
  state          text not null default 'queued',   -- queued | approved | scheduled
                                                   -- | sent_back | reassigned | superseded
  decided_by     uuid references principals (id),
  decided_at     timestamptz,
  decision_note  text,                             -- required for send-back
  scheduled_for  timestamptz                       -- 'Approve for 12:00'
);
create index on approval_items (state, sla_deadline) where state = 'queued';
```

**SLA duration**: the design shows "3:00" timers. Interpreted as **3 hours** (a 3-minute human
SLA is not operable by a single owner; the 14-minute lake→live median is dominated by the agent
stages). Stored in the `throttles` config doc as `approval_sla_minutes: 180` so the owner can
tighten it. DEFAULTED — owner may override.

Timers are **not** server-side jobs per item. The queue page computes remaining time client-side
from `sla_deadline`; a single pg_cron sweep (`*/5 * * * *`) flags breaches:
items past deadline get an audit event `QUEUE/sla.breach` once (idempotent via a `sla_breached_at`
column) and surface red in 24a's needs-attention queue. No push/pager integration day one
(DEFERRED; the owner lives in the Desk).

### 4.2 One-click approve → publish, as one transaction

A single `security definer` Postgres function so the decision, the content transition, the audit
trail, and the fan-out enqueue cannot partially apply:

```sql
select desk_decide_approval(
  p_item_id      => $1,
  p_decision     => 'approve',        -- approve | approve_scheduled | send_back | reassign
  p_scheduled_for=> null,
  p_note         => null
);
```

Inside the function (all-or-nothing):

1. `select … for update` the approval item; reject if not `queued` (double-click safe).
2. Verify caller: GUC principal must hold C03 with a full (non-amber) grant — i.e. the owner.
   EIC calls succeed only for `send_back`/`reassign`.
3. Re-run the cheap invariants: content still in `APPROVAL` status, rules result still green at
   the current ruleset version (the rules service stamps `content_items.rules_passed_version`;
   if the live ruleset version has moved since, the function rejects with `RULES_STALE` and the
   UI offers RUN RULES NOW — this closes the race between a rules deploy and a pending approval).
4. `approve`: set `content_items.status = 'live'`, `published_at = now()`, append the R-01
   disclaimer flag; `approve_scheduled`: status `scheduled`, `scheduled_at = p_scheduled_for`.
5. Insert fan-out jobs into the `outbox` table (one row each: cache revalidation tag
   `content:<id>` + `frontpage`, push-to-watchers if the editor enabled it, PM Wire Brief slot
   hold). The outbox is drained by the jobs domain; Desk only enqueues.
6. Insert audit rows: `QUEUE/decision` and `PUBLISH/live` with before/after.

The Next Server Action wrapping this RPC then calls `revalidateTag()` for the returned tags.
If Vercel revalidation fails after commit, the reader surface self-heals on its normal ISR
window — publish correctness lives in Postgres, not in Vercel.

### 4.3 Send-back-with-note loop

`send_back` requires a non-empty note. The function sets the item `sent_back`, moves the content
back to `DRAFT`, and inserts an `agent_tasks` row
(`{type:'revise', content_id, note, assigned_agent}`) addressed to the writer agent recorded in
the byline chain. Agents receive it on their next `GET /api/agents/v1/tasks` poll (agents poll
every 60s; no webhooks day one — the agents run on the owner's Mac and inbound webhooks would
require a tunnel. DEFERRED). When the revised draft re-enters the queue it is a **new**
`approval_items` row; the old row keeps its `sent_back` state so 27b can show the loop history.
`reassign` creates a Workbench editorial task for a named human instead.

---

## 5. Versioned config documents

One mechanism for everything the design versions: nav (V11–V14), ruleset (V8/V9), permissions
policy (V5/V6), front page (V39–V41), meters/pricing, throttles.

```sql
create type config_doc_type as enum
  ('nav','ruleset','permissions_policy','frontpage','meters_pricing','throttles');

create table config_docs (
  id            uuid primary key default gen_random_uuid(),
  doc_type      config_doc_type not null,
  version       int not null,                       -- monotonic per doc_type
  body          jsonb not null,
  status        text not null default 'draft',      -- draft | live | superseded
  created_by    uuid not null references principals (id),
  created_at    timestamptz not null default now(),
  activated_by  uuid references principals (id),
  activated_at  timestamptz,
  restored_from int,                                -- set when this version is a rollback copy
  unique (doc_type, version)
);
create unique index one_live_per_type on config_docs (doc_type) where status = 'live';
```

- **Activate** = `desk_activate_config(doc_type, version)` (security definer): supersede the
  current live row, mark the new one live, audit `NAV/publish` / `CONFIG/activate` with both
  version numbers. Editing rights per type come from the capability matrix: `nav`/`frontpage` →
  C04, `ruleset` → C05, `permissions_policy` → C10, `meters_pricing`/`throttles` → C11. The
  partial unique index makes concurrent activation a straight DB conflict, not a race.
- **Rollback** = restore: copies the old body into a **new** version with `restored_from` set
  (history stays linear and append-only; you can always answer "who/when" from the row itself
  plus the audit log).
- **Reads**: `src/lib/desk/config.ts#getLiveConfig(type)` — a `unstable_cache`-wrapped query
  tagged `config:<type>`; activation revalidates the tag. Reader-side consumers (nav rendering,
  meter enforcement, paywall copy) read through the same helper, which resolves open question 4:
  **paywall/pricing copy is config-driven from `meters_pricing` (the 33c document), and any
  screen copy that disagrees is stale copy, not a second source of truth.** DEFAULTED.
- Schema validation: each doc type has a Zod schema in `src/lib/desk/config-schemas.ts`; drafts
  that fail validation cannot be saved, so a bad nav JSON can never go live.
- Monetization semantics ("effective next billing cycle, never retroactive") are enforced by the
  billing domain reading the version that was live at cycle start — `config_docs` keeps every
  version forever precisely so that is a lookup, not an archaeology project.

Front-page scheduled takeovers (25c) are rows in the `frontpage` doc body with
`{starts_at, ends_at | end_event}`; the SYSTEM auto-flow refresh (06:02 GST cron, `02 2 * * *`
UTC) activates a new SYSTEM-authored version, which is why 25c's history shows SYSTEM actors.

---

## 6. Append-only audit log

### 6.1 Table

```sql
create table audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid not null references principals (id),
  actor_kind   principal_kind not null,             -- denormalized for cheap filtering
  category     text not null,                       -- QUEUE|CONTENT|PUBLISH|LAKE|NAV|CONFIG
                                                    -- |BILLING|TEAM|AUTH|ADS|DATA_OPS|ANALYTICS
  action       text not null,                       -- 'decision','key.issue','break_glass.on'…
  entity_type  text,
  entity_id    text,
  before       jsonb,                               -- always populated on overrides (31b rule)
  after        jsonb,
  note         text,
  request_id   text,
  prev_hash    bytea,
  row_hash     bytea not null
);
create index on audit_log using brin (at);
create index on audit_log (actor_id, at desc);
create index on audit_log (entity_type, entity_id, at desc);
```

### 6.2 Append-only enforcement

RLS enabled with **no** update/delete policies, plus — because the service-role key bypasses
RLS — a belt-and-braces trigger:

```sql
create or replace function fn_audit_immutable() returns trigger
language plpgsql as $$ begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_no_mutate before update or delete on audit_log
  for each row execute function fn_audit_immutable();
```

(A determined attacker with the service key can drop the trigger; that is what the hash chain
and anchoring below are for.)

### 6.3 Two write paths, identical schema for humans/agents/SYSTEM

1. **Row-level trigger auditing** — `fn_audit_row()` attached `AFTER INSERT OR UPDATE OR DELETE`
   to the sensitive tables (`config_docs`, `principals`, `agent_api_keys`, `system_flags`,
   `approval_items`, `content_items` status column, `ad_campaigns`, lake conflict resolutions,
   billing action tables). It reads `app.principal_id` / `app.principal_kind` GUCs (set by the
   desk Server-Action wrapper for humans, the agent gateway for agents, and hardcoded to the
   SYSTEM principal inside pg_cron job functions) and records before/after JSON. If the GUC is
   missing the trigger **rejects the write** — an unattributed mutation is a bug, not an audit
   gap.
2. **Semantic events** — application code inserts business-level entries (`QUEUE/decision`,
   `TEAM/break_glass.on`, `BILLING/refund`) via `src/lib/desk/audit.ts#audit()` inside the same
   transaction as the mutation.

Agents thus produce byte-identical audit rows to humans (the 96.8%-by-agents figure on 31b is
just a `group by actor_kind`).

### 6.4 Hash chain — assessment and verdict

**Worth it day one? Yes — because at our volume it costs almost nothing; and honestly scoped: it
is tamper-*evidence*, not tamper-*proofing*.** With a single owner holding the service key, no
in-database scheme prevents tampering; a chain only makes silent tampering detectable, and only
if the chain head is anchored somewhere the database cannot rewrite.

Implementation (~20 lines): a `BEFORE INSERT` trigger takes
`pg_advisory_xact_lock(hashtext('audit_chain'))`, reads the last `row_hash`, and sets
`row_hash = sha256(prev_hash || canonical json of (at, actor_id, category, action, entity_type,
entity_id, before, after))`. At the observed ~48K events/7d (~7K/day, peak a few per second) the
advisory lock is irrelevant contention-wise; if it ever isn't, we switch to per-day chains.

Anchoring, day one: a pg_cron job at 00:05 GST (`5 20 * * *` UTC) writes the day's head hash and
row count into `audit_anchors` **and** enqueues an email to the owner containing the head hash —
the owner's inbox (Gmail, outside our infrastructure) becomes the external anchor at $0.
`desk_verify_audit_chain(from_date, to_date)` recomputes and compares on demand from 31b.
DEFERRED: real external anchoring (e.g., committing anchors to a private GitHub repo) — one
webhook away if ever needed.

### 6.5 Retention & export

7-year retention (31b) ≈ 7K/day × 365 × 7 ≈ **18M rows ≈ 6–9 GB** with JSONB payloads — within
Supabase Pro's 8 GB included storage for years, and the BRIN index keeps time-range scans cheap.
Day one: single unpartitioned table. DEFERRED: native yearly range partitions, to be introduced
when the table crosses ~5M rows (a straight `create table … partition by range` migration with a
backfill; nothing about the API changes). Export: `GET /api/desk/audit/export?from&to&actor`
streams CSV with `Content-Disposition`, owner/EIC only, and — recursively — writes its own audit
entry (`AUDIT/export`).

---

## 7. Desk protection: RLS + middleware + layout

Three layers, innermost is authoritative:

1. **Middleware** (`src/middleware.ts`, matcher `['/desk/:path*', '/api/desk/:path*']`): fast
   rejection — no session cookie or no `desk_role` claim → redirect to `/desk/login`. This is
   UX, not security.
2. **Desk layout** (`src/app/desk/layout.tsx`): server-side `supabase.auth.getUser()` (token
   verified against Auth server, not just decoded), load principal, check `kind='human'`,
   `status='active'`, and **AAL2 for Editor+ (§7.1)**. Renders nothing on failure.
3. **RLS**: every desk-only table (`principals`, `agent_api_keys`, `audit_log`, `config_docs`,
   `approval_items`, `system_flags`, `feed_heartbeats`, `incident_banners`, analytics tables)
   has policies of the shape:

```sql
create policy desk_read on audit_log for select
  using (
    exists (select 1 from principals p
            where p.auth_user_id = (select auth.uid())
              and p.kind = 'human' and p.status = 'active')
  );
```

   Mutations go through security-definer RPCs or service-role Server Actions that run `can()`
   first — so RLS grants desk humans *read*, and *write* paths are all capability-checked code.
   Reader-facing tables the Desk also touches (content, lake) keep their own reader policies;
   desk writes ride the RPC path.

### 7.1 Owner auth hardening — TOTP 2FA

- **Mechanism**: Supabase Auth MFA, TOTP factor (free on all plans). Enrollment UI at
  `/desk/settings/security` using `supabase.auth.mfa.enroll({factorType:'totp'})` → QR + manual
  key → `challenge`/`verify` (matches reader screen 17f, reused component).
- **Enforcement**: policy "2FA required for Editor role and above" (31a) = layout check that
  `getAuthenticatorAssuranceLevel()` returns `currentLevel === 'aal2'` for principals with role
  in (`owner`,`eic`) — others are nudged, not blocked (DEFAULTED — owner may extend to all
  roles). Critical RPCs (`desk_decide_approval`, `desk_activate_config`, key issuance, kill
  switches, break-glass) additionally check `auth.jwt()->>'aal' = 'aal2'` inside Postgres, so a
  stolen AAL1 session cannot reach them even through a bug in the app layer.
- **Recovery**: second TOTP factor enrollment is allowed (two devices). Bespoke single-use
  recovery codes are DEFERRED — Supabase has no native support, and the owner retains
  break-glass recovery via the Supabase dashboard (unenroll factor with the dashboard's own MFA).
  The 10-recovery-code UI shown in 17f ships for *readers* only when that domain builds it.
- Session hygiene: `supabase.auth.admin.signOut(userId, 'global')` behind the "log out all
  devices" button; new-device sign-in alerts ride the existing security-email identity.

---

## 8. Analytics (26a/26b)

### 8.1 Build vs buy — decided on cost

Volume estimate from the design fixture: 96.4K views/7d plus clicks/saves/etc. ≈ **1.5–2M
events/month**.

| Option | Monthly cost at ~2M events | Notes |
|---|---|---|
| GA4 | $0 | Free, but sampled, no SQL, cookie-consent surface area, data leaves region — poor PDPL posture for a platform that promises contextual-only |
| Plausible Cloud | $19–49 (100K→1M pageview tiers) | Nice, but no custom funnel joins to `trial_start`, no per-analyst read→trial attribution without their events API gymnastics |
| PostHog Cloud | ~$0–20 (1M free events, then usage) | Would work; adds a vendor, an SDK, and data residency questions |
| **Own table + nightly rollups (chosen)** | **$0 incremental** | ~2M rows/mo ≈ 400–600 MB/yr raw *before pruning*; we already pay for the Postgres |

**Verdict: self-host.** The Desk's killer queries (paywall_hit → trial funnel, top content by
*trials*, per-analyst read→trial %, no-result search terms) are joins against our own
`content_items`/`subscriptions` — exactly what a third party can't do cheaply. DEFAULTED —
owner may override if event volume 10×es.

### 8.2 Ingestion

```sql
create table analytics_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  event       text not null,          -- page_view|click|share|save|watchlist_add|alert_create
                                      -- |ai_answer|screener_run|paywall_hit|trial_start
  session_id  uuid not null,          -- random per-tab, sessionStorage; not a tracking cookie
  user_ref    uuid,                   -- hashed user id when signed in; null for anon
  tier        text,                   -- anon|free|trial|premium
  content_id  uuid,
  ticker      text,
  path        text,
  referrer    text,
  channel     text,                   -- direct|whatsapp|search|email|social
  geo         text,                   -- country only, from Vercel geo header
  platform    text,                   -- web|mobile-web|email
  props       jsonb
) ;
create index on analytics_events using brin (at);
create index on analytics_events (content_id, at desc);
create index on analytics_events (event, at desc);
```

- **Client**: `src/lib/analytics/client.ts` — queue events in memory, flush via
  `navigator.sendBeacon('/api/e')` every 10 s / on `visibilitychange`, batched JSON array.
  `page_view` also sends a 60-second heartbeat ping (`event:'hb'`, stored 24 h only) that powers
  on-site-now.
- **Server**: `src/app/api/e/route.ts` — validate shape (Zod), cap 50 events/request, drop
  anything with a body > 8 KB, strip IPs (we store country only — PDPL-friendly, no consent
  banner needed for first-party contextual analytics), single multi-row insert with the
  service-role client. `trial_start` and `paywall_hit` are *also* emitted server-side by the
  billing/paywall code paths (client events are lossy; revenue-adjacent counts must not be).
- Bot filtering: UA denylist at the edge + `session_id` cardinality guard in rollups. Nothing
  fancier day one.

### 8.3 Rollups & retention (pg_cron)

| Job | Cron (UTC) | GST | What |
|---|---|---|---|
| `analytics_rollup_daily` | `30 22 * * *` | 02:30 | Upsert `analytics_daily` (date × event × content_id × tier × channel, counts + uniques via `count(distinct session_id)`) and `analytics_content_hourly` (last 90 days kept) |
| `analytics_prune` | `15 23 * * 0` | Sun 03:15 | Delete raw events > 13 months (rollups keep history forever at ~1/1000 the size); delete `hb` rows > 24 h |
| `search_gaps_rollup` | `30 22 * * *` | 02:30 | Aggregate zero-result search terms into `search_gap_terms` for 26a |

26a/26b read only rollup tables plus two live widgets:

- **On-site-now**: `select count(distinct session_id) from analytics_events where event='hb' and
  at > now() - interval '5 minutes'` — served by `/api/desk/analytics/now`, cached 15 s. At our
  volume this is a sub-10 ms BRIN-assisted scan; no Realtime channel, no Redis.
- **Live event tail**: the Desk page polls `/api/desk/analytics/tail?after=<id>` every 5 s for
  the last 50 rows. Supabase Realtime `postgres_changes` on a high-insert table is the expensive
  way to build a ticker nobody is staring at overnight. DEFAULTED — polling.

Storage math with pruning: 13 months × ~2M ≈ 26M raw rows ≈ 5–6 GB worst case; rollups a few
hundred MB. Combined with audit (§6.5) we stay inside the plan's included storage through year
two; the pruning window is the knob if that changes.

---

## 9. Feed health board & incident banners (33a, 24a, reader propagation)

### 9.1 Heartbeats from scraper agents

Every DATA agent scrape cycle POSTs `/api/agents/v1/lake/heartbeat`:

```sql
create table feed_heartbeats (
  id          bigint generated always as identity primary key,
  venue       text not null,          -- TDWL|DFM|ADX|QE|MSX|BHB
  agent_id    uuid not null references principals (id),
  at          timestamptz not null default now(),
  status      text not null,          -- ok | timeout | parse_error | source_changed
  latency_ms  int,
  detail      jsonb                   -- retry count, fallback flag, rows scraped
);
create index on feed_heartbeats (venue, at desc);
```

Kept 48 hours raw (pruned by the weekly job); a daily job (`45 20 * * *` UTC = 00:45 GST) folds
into `feed_health_daily` (venue × date: uptime %, p50/p95 latency, error counts) which backs the
30-day uptime figures on 33a.

### 9.2 Derived venue status

`venue_feed_status` — one row per venue, the single source the FreshnessBadge pipeline reads:

```sql
create table venue_feed_status (
  venue         text primary key,
  state         text not null,        -- live | reconnecting | delayed | offline | halted | auction
  since         timestamptz not null,
  last_ok_at    timestamptz,
  detail        text,                 -- 'TIMEOUT retry 4 · fallback 90s'
  updated_at    timestamptz not null default now()
);
```

A pg_cron sweep every minute (`* * * * *`, function `fn_sweep_feed_status()`) applies the state
machine: no `ok` heartbeat in 2 minutes → `reconnecting`; in 10 minutes → `delayed`; in 60
minutes → `offline`; recovery = 3 consecutive `ok` beats. (`halted`/`auction` are per-ticker
states owned by the market-data domain; this table carries them at venue level only when the
whole venue is in auction/closed, driven by the market-hours calendar.) Under the scrape-only
strategy the *healthy* state is still labeled DELAYED on reader surfaces — `venue_feed_status`
tracks *pipeline* health, and the reader freshness composer combines it with the delay class.
Transitions write `DATA_OPS/feed.state` audit events, which is exactly the MSX incident thread
visible on 24a.

### 9.3 Incident banners

```sql
create table incident_banners (
  id            uuid primary key default gen_random_uuid(),
  message       text not null,
  severity      text not null default 'info',   -- info | degraded  (never 'error'-red: color law)
  surfaces      text[] not null,                -- ['reader.all'] | ['reader.msx','desk']
  venue         text,                           -- optional link to a venue for auto-expiry
  auto_expire_on_recovery bool not null default true,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz,
  created_by    uuid not null references principals (id),
  cleared_at    timestamptz,
  cleared_by    uuid references principals (id)  -- null when cleared by SYSTEM sweep
);
```

Composer lives on 33a (capability C07). The same per-minute sweep clears any banner whose
`venue` has been `live` (pipeline-healthy) for 3 consecutive minutes when
`auto_expire_on_recovery` — attribution SYSTEM, audited. Reader surfaces fetch active banners
through a cached `getActiveBanners(surface)` helper (`unstable_cache`, tag `banners`,
revalidated on composer publish and by the sweep via a lightweight revalidate ping); worst-case
staleness is one ISR window, acceptable for an informational amber banner.

24a's six-venue feed-health strip and the AdminRail incident chip are direct reads of
`venue_feed_status` + open `incident_banners`.

---

## 10. Cron summary (all pg_cron, all attributed to the SYSTEM principal)

| Name | Cron (UTC) | GST | Purpose |
|---|---|---|---|
| `sweep_feed_status` | `* * * * *` | — | Heartbeat → venue state machine; banner auto-expiry |
| `sweep_approval_sla` | `*/5 * * * *` | — | Flag SLA breaches on queued approvals |
| `analytics_rollup_daily` | `30 22 * * *` | 02:30 | Daily + hourly rollups, search gaps |
| `feed_health_daily` | `45 20 * * *` | 00:45 | Fold heartbeats into daily uptime |
| `audit_anchor_daily` | `5 20 * * *` | 00:05 | Hash-chain head → `audit_anchors` + owner email |
| `analytics_prune` | `15 23 * * 0` | Sun 03:15 | Raw event/heartbeat retention |
| `frontpage_autoflow` | `2 2 * * *` | 06:02 | SYSTEM front-page refresh version (25c history) |
| `key_rotation_nudge` | `0 3 * * *` | 07:00 | Surface 75-day-old agent keys in needs-attention |

(Score batch, Wire Brief, dunning, meter resets belong to other domains; listed in
design-analysis §5.)

---

## 11. Module map

```
src/app/desk/…                      route tree per §1 (layout + 19 pages)
src/app/api/desk/…                  export/tail/now endpoints
src/app/api/agents/v1/…             agent gateway routes
src/app/api/e/route.ts              analytics beacon
src/components/desk/AdminRail.tsx   rail + incident chip + capability-filtered nav
src/lib/desk/authz.ts               can(), assertNotDenied(), capability constants
src/lib/desk/audit.ts               audit() semantic-event helper
src/lib/desk/config.ts              getLiveConfig(), activateConfig()
src/lib/desk/config-schemas.ts      Zod schemas per doc_type
src/lib/desk/agent-gateway.ts       withAgentAuth(), key verify, GUC setup
src/lib/desk/api-keys.ts            issue/rotate/revoke
src/lib/analytics/client.ts         beacon batcher + heartbeat
src/lib/analytics/queries.ts        rollup readers for 26a/26b
supabase/migrations/…               all DDL above, incl. triggers
supabase/functions/custom-claims/   custom_access_token_hook (desk_role claim)
```

---

## 12. Cost statement

| Item | Monthly |
|---|---|
| Supabase Pro (existing plan, sunk — $25, not the fictional $10; pg_cron, Auth MFA TOTP included; storage claims re-baselined in Revisions against co-tenant domains) | $25 (existing) |
| Vercel Pro from paid launch (Hobby prohibits commercial use; beacon + Desk are ordinary invocations inside Pro) | $20 (platform line, see 06 §7.2) |
| Analytics vendor | $0 (self-hosted, §8.1) |
| Audit/anchoring/SIEM vendor | $0 (hash chain + owner email anchor) |
| Redis / queue infra | $0 (Postgres outbox + polling) |
| MFA | $0 (TOTP is free; we do not use paid SMS MFA) |
| **Incremental total** | **$0** |

Growth triggers that would change this: raw analytics > ~5 GB (tighten pruning first), agent
fleet ≫ 12 or sub-second task latency required (move polling → queue), audit table > 5M rows
(partition, still $0).

---

## 13. Defaults taken & deliberate deferrals

**DEFAULTED — owner may override**
1. Approval SLA "3:00" read as **3 hours**, configurable via `throttles` config doc.
2. Agent auto-publish gate **≤40 words** (TPL-01 template itself serves ≤90-word human wires).
3. Workbench **Reviewer = flag on Analyst/EIC**, not a sixth role (open question 16).
4. `meters_pricing` config doc (33c) is the **single source of truth** for meters and price
   copy; conflicting screen copy is treated as stale (open questions 1 & 4).
5. Approval authority: **owner-only approve**; EIC limited to send-back/reassign.
6. Analytics **self-hosted**; live tail via 5-second polling, on-site-now via 5-minute heartbeat
   window — no Realtime channels.
7. AAL2 (TOTP) hard-required for **Owner + EIC**; nudged for other roles.
8. Rollback model: restoring an old config version creates a new version (linear history).

**DELIBERATELY DEFERRED (cheapest-possible constraint)**
- External audit anchoring beyond the daily owner email (GitHub/anchor service).
- Audit table partitioning (until ~5M rows).
- Custom MFA recovery codes (second TOTP device + Supabase dashboard recovery instead).
- Push/pager alerting on SLA breach and feed incidents (Desk-visible only).
- Webhooks/queues to agents (60-second task polling instead — agents run on the owner's Mac).
- Redis-backed rate limiting (Postgres token bucket at 12 agents).
- IP allowlisting / mTLS for the agent gateway; WebAuthn hardware keys for the owner.
- SIEM/log shipping; Vercel + Supabase logs suffice at this team size.
- Arabic fields anywhere in these tables (locked decision 4); `config_docs.nav` body reserves a
  `labelAr` key per tab so the 24b UI contract survives a later AR build without a migration.

---

## Revisions (post-review)

Nine blocking issues; all accepted. **02-data-lake.md owns table names** (mapping at the end)
and **06-infra-cost.md owns runtime placement**. Where sections above conflict with this list,
this list wins.

1. **Agent runtime & the negative-scope security model, restated honestly.** Agents run as
   task handlers inside 06's single VPS `marsad-worker` process — not on the owner's Mac (a
   sleeping laptop may not halt a no-employee newsroom), and 03's Edge Function runtime is
   likewise superseded. The Mac-era mechanisms above are revised: **the 60 s task polling and
   the HTTP agent gateway are dropped for pipeline work** (the worker consumes pgmq
   directly); `send_back` tasks are pgmq messages, effective in ~1 s. The security claim is
   downgraded from "even a bug in the gateway cannot cross the hard lines" to what is true:
   the worker's Postgres role **`marsad_worker` has zero grants on `billing.*`, `iam` key
   tables, and config activation paths** — never-billing is a role-grant fact even against
   worker bugs; within the worker, per-agent separation (WRITER vs DATA vs PUBLISHING) is
   **attribution + trigger enforcement** (`app.principal_id`/`app.principal_kind` GUCs +
   `fn_enforce_agent_negative_scopes()` on `content_items` status transitions etc.), which a
   fully compromised worker process could forge — accepted and stated: process-level agent
   isolation is not a v1 property; the blast-radius boundary is the role grant, the kill
   switches, and the append-only audit. The service-role key on the VPS is scoped to Storage
   uploads (01 Revisions). `agent_api_keys` remain for any future out-of-process agent and
   for Desk-visible rotation hygiene, but are not in the pipeline hot path.
2. **The in-database auth checks are now satisfiable.** Critical RPCs
   (`desk_decide_approval`, `desk_activate_config`, key issuance, kill switches) are
   SECURITY DEFINER functions **called over the user's own JWT** (PostgREST/server action
   with the user session): inside, they derive the caller via `auth.uid()` → `iam.principals`
   (never trusting a caller-set GUC), check the capability matrix and
   `auth.jwt()->>'aal' = 'aal2'`, then **set the GUCs themselves** for downstream audit
   triggers. Caller-set GUCs are reserved exclusively for the `marsad_worker` connection
   path. `fn_audit_row()` accordingly: GUC present → use it; GUC absent but `auth.uid()`
   resolves to an active human principal → derive and continue; neither → reject. Owner
   approvals work; worker writes work; unattributed writes still fail.
3. **One freshness state machine.** `venue_feed_status` DDL above is superseded by
   `public.venue_feed_status` (02 §7) with states
   `live|reconnecting|delayed|offline|closed` (+ per-ticker `halted|auction|stale` on
   `public.security_status`). The **single writer is the ingestion sweep**
   (`ingest.sweep_feed_status()`, pg_cron every minute, thresholds relative to source
   cadence per 01 §8 — the 2/10/60-min thresholds and `fn_sweep_feed_status` above are
   deleted, as is 06's VPS `feed_watchdog` loop: the sweep must outlive a dead VPS to mark
   OFFLINE). `feed_heartbeats` is dropped in favor of `ingest.fetch_log` + `ops.job_heartbeats`
   (06 §6); `feed_health_daily` folds from those. Desk and reader read the same table;
   propagation to readers is via the polled pulse payloads (04 §4), Desk via short polling.
4. **One analytics job inventory, one retention policy.** Canonical: `analytics.events`
   (02 §17, monthly partitions), ingested via this doc's `/api/e` beacon (kept — with 02's
   `track()` RPC removed from the anon surface); **hourly rollups** (06 job 14) upserting
   `analytics.daily_*`; **raw retention 13 months** (02 §20 wins; 06's 90-day downsample
   line is corrected to "prune per 02 §20"). This doc's `analytics_rollup_daily`/
   `analytics_prune` collapse into those two platform jobs. The §10 cron table stands only
   for: `sweep_approval_sla`, `audit_anchor_daily`, `frontpage_autoflow`, `key_rotation_nudge`
   — dedup ownership of everything else is 06 §4.1.
5. **Storage/plan honesty.** The 7-year audit (6–9 GB) + 13-month analytics (5–6 GB) math is
   re-baselined against Supabase **Pro (8 GB DB, already paid at $25)** shared with the lake
   (~2.5–3 GB yr-1), OHLCV backfill, and pgvector later — combined pressure makes the disk
   add-on ($0.125/GB/mo) or tighter analytics pruning a **year-2 certainty, budgeted** (~$1–3/mo
   at first, not a surprise). `ops.audit_log` is **yearly-partitioned from day one** (02 §18
   already specifies it — the "single unpartitioned table" default above is superseded), so
   detach-and-archive to Storage keeps hot DB size bounded.
6. **Analytics event volume recomputed.** The 60 s heartbeat at fixture concurrency
   (1,284 on-site) would emit up to ~1.8M hb rows/day — 10–25× the §8.1 estimate. Fixed:
   **heartbeat cadence 5 min** (on-site-now window widens to 10 min), hb rows excluded from
   rollup source and pruned at 24 h as before; beacon flush stays 10 s but batches. At
   fixture load this is ≤ ~0.4M hb/day and launch-scale reality is orders of magnitude less;
   Vercel invocation math re-checked inside Pro allowances.
7. **Key-expiry dead-man switch removed.** Agent keys no longer hard-expire at 90 days:
   in-process agents don't authenticate by key, and any out-of-process key gets a 90-day
   **rotation nudge** (Desk needs-attention + SES email via `q_email`) with no automatic
   401 — expiry without a human in the loop is incompatible with a no-employee platform. The
   security lever remains the instant kill switches + role grants.
8. **PDPL vs immutable audit resolved at write time** (02 §18 Revisions): billing-category
   audit rows store `member_id` + changed field names, never raw PII values; PDPL purge then
   needs no redaction and the hash chain never breaks. ZATCA's 10-year basis covers invoices
   only, which live (denormalized) in `billing.invoices`.
9. **RLS encodes role, not desk membership.** `desk_read` on `audit_log`, `agent_api_keys`,
   and subscriber-adjacent tables requires `desk_role in ('owner','eic')` (audit browser is
   31b owner/EIC-scoped); Support's C08 export path is a SECURITY DEFINER function that
   checks the owner-OK grant; the permissive membership-only pattern above survives only for
   genuinely shared surfaces (feed status, incidents, config reads).

Improvements adopted: the invented `outbox` table is replaced by **`pgmq.send` in the same
transaction** (the outbox IS the queue — 06 §5); the custom-claims hook is a **plain Postgres
function** (`public.custom_access_token_hook`), not an Edge Function — runtime count stays
two; **approval SLA clock pauses 22:00–07:00 GST owner quiet hours** (halt wires and
price-sensitive confirms exempt) and breach events also send an SES email — an overnight
queue no longer breaches silently every night; the audit anchor email rides `q_email`/SES,
and the **$0 GitHub anchor commit ships day one** (a one-file commit of the daily head hash
to the private repo — removes the owner's-inbox-as-infrastructure dependency); the
`approval_items` table is **superseded by `ops.pipeline_items` at stage 'approval'**
(02/03) — its unused `superseded` state dies with it, send-back history preserved via
`ops.agent_runs`/transitions; agent seed codes follow **03 §2.1's roster verbatim**
(DATA-TDWL/-GULF/-MSX/-FILINGS/-NEWS, WRITER-1..3, EDITOR-1..2, NEWSLETTER-1, ANALYTICS-1) —
the venue-per-agent split above is deleted; Desk live tail stays **5 s polling** and 06's
`desk_runlog`/`approval_queue` Realtime channels are reduced to the single optional
`agent-run-log` broadcast (02 §12); `config_docs` maps onto 02's per-domain versioned tables
(`ops.nav_versions`, `ops.front_page_versions`, `ops.rulesets`, `billing.plan_versions`) plus
a small `ops.settings_versions` for `permissions_policy`/`throttles` — one mechanism per 02,
same activate/rollback semantics; **Workbench (1n/1o/20e) is owned by this domain** (04
Revisions): `src/app/workbench/**` on Vercel behind the same principal check, `is_reviewer`
flag gating 20e.

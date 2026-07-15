# 02 — Data Lake & Database Schema

> Domain architecture for the Marsad platform's Postgres (Supabase) layer: raw snapshot store,
> typed data lake with lineage, citation graph, the full relational entity model (~40 tables
> beyond the lake itself), RLS strategy, partitioning/retention, migration sequencing, and cost.
>
> Supabase project: `yjsncnpbjuueaoeejrqj` (ap-south-1). App: Next.js 15 at repo root, Supabase
> clients at `src/lib/supabase/client.ts` (anon, browser) and `src/lib/supabase/server.ts`
> (SSR/service-role). Migrations live in `supabase/migrations/` and are applied with the Supabase
> CLI (`supabase db push`) or the Supabase MCP `apply_migration` tool.
>
> Locked constraints honored throughout: scrape-only delayed market data, all 6 venues day one,
> cheapest-possible run cost, English-only schema (AR attach points noted, not built).
> Source of truth for requirements: `docs/design-analysis.md` (sections 3, 4, 5, 6, 7).

---

## 1. Design principles

1. **One database, many Postgres schemas, one exposure surface.** Everything lives in the single
   Supabase Postgres instance. We use Postgres schemas as security and comprehension boundaries:
   only `public` is exposed through PostgREST/supabase-js to browsers; `lake`, `ops`, `billing`,
   `comms`, and `analytics` are reachable exclusively through the service-role client in Next.js
   server code (route handlers, server actions) and pg_cron jobs. This gives us a hard
   "service-role-only" wall without paying for a second database or an API gateway.

2. **The lake is append-mostly and hash-addressed at the bottom.** Raw scraped bytes are immutable
   and content-addressed (SHA-256). Typed objects above them are versioned rows with explicit
   revision pairs, never destructive updates. Every object can be walked back to the exact bytes
   it was parsed from: `object → parse_run → snapshot(s) → blob`.

3. **The citation graph is a first-class relational edge table, not a graph database.** The user's
   "datapoints in graph format" requirement is delivered as: (a) `lake.citations` edges
   (article ↔ object), (b) `lake.parse_run_snapshots` + FK lineage edges (object ↔ snapshot),
   and (c) a generic `public.datapoints` time-series table (entity, metric, period, value,
   source object) that any surface — charts, screener, AI grounding, exports — can query in any
   shape. Postgres recursive CTEs handle every traversal the product needs (citation fan-out for
   R-07, lineage walks for the conflict inspector) at our scale (single-digit millions of edges).
   A dedicated graph DB (Neo4j Aura starts ~USD 65/mo; AWS Neptune far more) would add a second
   system to operate, a second copy of the data to keep consistent, and zero capability we need.
   **Rejected on cost. DEFAULTED — owner may override** if traversal depth ever exceeds what
   recursive CTEs handle comfortably (it will not at 4.2M objects).

4. **Entitlements are enforced in the database where the data shape allows it, and in server
   routes where it does not.** Premium article bodies are physically separate rows gated by RLS,
   so a free client can never receive gated bytes. Meters, screener row truncation, and AI
   credits are enforced in SECURITY DEFINER functions and server route handlers — never in
   client code. No gated content ships to the client to be blurred (design-analysis open
   question 12: resolved server-side, always).

5. **Humans and agents are one principal model.** `iam.principals` unifies Supabase
   `auth.users` (humans) and the 12 agent service accounts. Every actor FK in the system —
   audit log, lake object provenance, content bylines, pipeline stages, publish log — points at
   `iam.principals.id`, so audit records are structurally identical for humans, agents, and
   SYSTEM, as the designs require (31b).

6. **Cheap by construction.** No second datastore, no search cluster (Postgres FTS + pg_trgm),
   no queue broker (Postgres tables + pg_cron + `FOR UPDATE SKIP LOCKED`), no Redis (Postgres
   `unlogged` tables for hot ephemeral state), blobs in Supabase Storage not in table rows,
   aggressive retention windows on high-volume tables.

### Conventions

- **IDs**: `uuid DEFAULT gen_random_uuid()` for anything user-visible or federated across
  domains (principals, content, subscriptions, lake objects). `bigint GENERATED ALWAYS AS
  IDENTITY` for high-volume internal rows (quotes, analytics events, audit, citations,
  datapoints) — 8 bytes beats 16 and the b-trees stay hot.
- **Time**: `timestamptz` everywhere, stored UTC. Business-time helpers convert to Gulf time
  (`Asia/Dubai`, UTC+4 = GST) and Riyadh (`Asia/Riyadh`, UTC+3 = AST). All cron below is UTC.
- **Enumerations**: `text` + `CHECK` constraints, not native enums — the state vocabularies in
  the design (content status, freshness, alert types) will grow, and `ALTER TYPE ADD VALUE`
  inside transactions is painful. Native enums are used only where the set is genuinely closed
  (`lake_object_state`, `principal_kind`).
- **Money**: `numeric(14,2)` + ISO `currency char(3)`. Prices/quotes: `numeric(18,6)`.
- **Naming**: snake_case, singular schema names, plural table names, `_id` FK suffix,
  `created_at`/`updated_at` with a shared `set_updated_at()` trigger.
- **Arabic attach points** (not built, per lock #4): `securities.name_ar`,
  `ops.nav_tabs.label_ar`, `ops.banned_phrases.lang`, `market.filings.pdf_ar_path` are the four
  places AR columns land later. Each is called out inline as `-- AR-LATER`.

### Postgres schemas

| Schema      | Contents | Exposure |
|-------------|----------|----------|
| `public`    | Market reference and delayed prices, published content, scores, calendars, datapoints, user-owned engagement (watchlists, alerts, notes, screens, AI threads) | PostgREST (anon + authenticated), RLS on every table |
| `lake`      | Raw snapshots, parse runs, typed objects, conflicts, revisions, citations | service-role only |
| `ops`       | Principals-adjacent ops: agents, pipeline, rules, violations, nav config, front-page config, ads, incidents, audit log | service-role only |
| `iam`       | Principals, roles, grants, agent keys | service-role only (RLS-safe views into `public` where needed) |
| `billing`   | Plans, subscriptions, invoices, promo codes, credit ledger, usage meters | service-role only |
| `comms`     | Notification outbox, email templates, sends, suppression, push devices | service-role only |
| `analytics` | Event stream (partitioned), rollups | service-role only (inserts via a single SECURITY DEFINER RPC) |

PostgREST `db-schemas` stays at `public, graphql_public`. The Desk (admin) UI is entirely
Next.js server-rendered with the service-role client, so no private schema is ever exposed to a
browser. Extensions required: `pgcrypto` (hashing, UUIDs), `pg_cron`, `pg_trgm`, `unaccent`,
`pg_partman` (confirmed available on the live project, v5.3.1; its `run_maintenance()` must be
scheduled via pg_cron — no BGW on Supabase — folded into job 12 in §21; the 30-line fallback
function in section 20 remains documented but should not be needed).

---

## 2. Identity: principals, roles, agent service accounts

Created first because nearly every table FKs into it.

```sql
create type iam.principal_kind as enum ('human', 'agent', 'system');

create table iam.principals (
  id           uuid primary key default gen_random_uuid(),
  kind         iam.principal_kind not null,
  auth_user_id uuid unique references auth.users(id) on delete set null, -- humans only; SET NULL so PDPL purge (delete on auth.users) succeeds
  handle       text not null unique,          -- 'owner', 'r.khalifa', 'DATA-TDWL', 'WRITER-2', 'SYSTEM'
  display_name text not null,
  is_active    boolean not null default true, -- kill switch for agents, deactivation for humans
  purged_at    timestamptz,                   -- set by the PDPL purge trigger when auth row deleted
  created_at   timestamptz not null default now(),
  constraint human_has_auth check (kind <> 'human' or auth_user_id is not null or purged_at is not null),
  constraint agent_no_auth  check (kind <> 'agent' or auth_user_id is null)
);
-- An ON DELETE trigger on auth.users stamps purged_at + display_name = 'deleted-user' on the
-- orphaned principal, keeping audit rows pseudonymous and the CHECK satisfiable.
-- Exactly one 'system' row, seeded in migrations; used as actor for cron/auto-flow audit rows.

create table iam.roles (
  key  text primary key,   -- 'owner','eic','reporter','analyst','support','reviewer',
                           -- 'agent_data','agent_writer','agent_publishing','reader'
  description text not null
);

create table iam.role_grants (
  principal_id uuid not null references iam.principals(id) on delete cascade,
  role_key     text not null references iam.roles(key),
  granted_by   uuid not null references iam.principals(id),
  granted_at   timestamptz not null default now(),
  primary key (principal_id, role_key)
);
```

**DEFAULTED — owner may override** (design open question 16): Workbench `reviewer` is modeled as
a plain role in the same matrix, not a separate role system. The 31b permissions matrix becomes
a seed table `iam.capability_grants(role_key, capability, condition)` where `condition` carries
the amber conditional grants as text (`'wire<=40w'`, `'flag_only'`, `'owner_ok'`); enforcement
of conditions happens in the functions that perform the action, with the grant row as config.

```sql
create table iam.agent_accounts (
  principal_id   uuid primary key references iam.principals(id) on delete cascade,
  agent_class    text not null check (agent_class in ('DATA','WRITER','PUBLISHING')),
  scope_string   text not null,               -- display copy: 'drafts:create · lake:read (verified only) · never publish'
  scopes         jsonb not null,              -- machine-checkable: {"allow":["lake:write:market"],"deny":["content:*","publish:*"]}
  owner_principal uuid not null references iam.principals(id),
  key_hash       text,                        -- sha256 of current API key; key itself never stored
  key_rotated_at timestamptz,
  run_enabled    boolean not null default true,  -- per-agent kill switch (31a)
  status         text not null default 'idle' check (status in ('active','idle','erroring','killed')),
  next_run_at    timestamptz,
  created_at     timestamptz not null default now()
);

create table iam.global_switches (             -- break-glass (31a): single-row config
  key text primary key,                        -- 'pause_all_agents','kill_all_output','auto_publish_wires'
  value boolean not null,
  changed_by uuid not null references iam.principals(id),
  changed_at timestamptz not null default now()
);
```

Agents authenticate to our own Next.js/edge endpoints with bearer keys checked against
`key_hash`; they never hold Supabase service-role keys. Human 2FA (Editor+ requirement) is
Supabase Auth MFA — a `check_mfa` claim check in Desk middleware, no schema needed beyond
`role_grants`.

Readers (the 96K accounts) are `auth.users` rows plus a thin profile:

```sql
create table public.user_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  member_no    text unique,                    -- 'M-48213', assigned by sequence trigger
  display_name text,
  currency_pref char(3) not null default 'SAR' check (currency_pref in ('SAR','AED','QAR','OMR','BHD','KWD','USD')),
  market_prefs text[] not null default '{}',   -- venue codes from onboarding
  sector_prefs text[] not null default '{}',
  wire_brief_opt_in boolean not null default false,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- RLS: user reads/updates own row only. Trigger on auth.users insert creates profile +
-- iam.principals(kind='human') row so readers are auditable principals too.
```

---

## 3. Raw snapshot store (immutable, hash-addressed)

Every scrape run produces raw bytes: exchange quote-page HTML, filings index JSON, a filing PDF,
a registrar page. These are the legal/audit bottom of the lineage chain and must be immutable.

**Blob placement decision:** metadata row in Postgres, bytes in Supabase Storage — with a small-
payload inline escape hatch. Rationale: Postgres disk on Supabase is the scarce resource
(8 GB included on Pro, ~USD 0.125/GB/mo beyond); Storage is 100 GB included and ~USD 0.021/GB/mo
beyond, ~6× cheaper, and keeps the DB cache hot. Filing PDFs (hundreds of KB) and HTML pages
(tens of KB) go to Storage gzipped. Tiny scrape payloads (delayed-quote JSON, a few KB) are
inlined in the row — a Storage round-trip per 15-minute quote scrape would cost more in edge
function time than it saves.

```sql
create table lake.snapshots (
  id            bigint generated always as identity primary key,
  sha256        text not null unique,          -- hex digest of UNCOMPRESSED bytes; content address
  source_key    text not null,                 -- 'tdwl.quotes','tdwl.filings.index','msx.filing.pdf', ...
  source_url    text not null,
  venue_code    text references public.venues(code),
  fetched_at    timestamptz not null default now(),
  fetched_by    uuid not null references iam.principals(id),   -- which DATA agent
  http_status   int,
  content_type  text not null,
  byte_size     int not null,
  storage_path  text,                          -- 'raw/{source_key}/{yyyy}/{mm}/{sha256}.gz' in bucket 'lake-raw'
  body_inline   bytea,                         -- gzip bytes iff byte_size <= 32768
  purged_at     timestamptz,                   -- retention purge stamp; metadata row kept forever
  constraint blob_somewhere check (storage_path is not null or body_inline is not null
                                   or purged_at is not null)
);
create index snapshots_source_time_idx on lake.snapshots (source_key, fetched_at desc);
create index snapshots_venue_time_idx  on lake.snapshots (venue_code, fetched_at desc);
```

Properties and policies:

- **Content addressing = free dedupe.** Scrapers hash before insert; `ON CONFLICT (sha256) DO
  NOTHING` means an unchanged exchange page costs one index probe and zero bytes. Quote pages
  change every scrape; filings index pages mostly don't — dedupe pays for itself immediately.
- **Immutability** is enforced with a trigger that rejects `UPDATE`/`DELETE` except from the
  retention job role (`revoke update on lake.snapshots from all` plus a
  `prevent_mutation()` trigger allowing only the purge function).
- **Bucket**: `lake-raw`, private, no public URLs. Desk lineage viewer streams via a
  service-role signed URL with 60 s TTL.
- **Retention** (section 12): quote-scrape snapshots 90 days then purged regardless of content
  type — `source_key like '%:quotes:%'`, matching the store's colon-delimited
  `${venue}:${dataType}:${id}` keys (the boards are JSON on DFM/QE/BHB/MSX, HTML elsewhere; the
  parsed quotes and OHLCV aggregates are the durable record). Filings/prospectus/transcript
  source documents AND raw financial statements kept indefinitely (they are the provenance the
  product sells / must stay re-parseable); generic HTML **and JSON** 1 year. Purge marks
  `storage_path = null, body_inline = null, purged_at = now()` on a metadata row we keep forever
  — lineage chains never dangle. (Column `purged_at timestamptz` included.) Freed `lake-raw`
  paths are enqueued into `ops.storage_purge_queue` (migration `20260715185413`) because
  Postgres cannot delete Storage backing files — a worker consumes the queue via the Storage
  API and stamps `deleted_at` (consumer deferred: BUILD-STATUS §7 DEF-STORAGE-PURGE-WORKER).
  History: the 0013 purge was a silent no-op until 2026-07-15 — it matched dot-delimited
  `'%.quotes%'` keys that never existed, and its fallback only matched `text/html` while quote
  boards are JSON, so zero rows ever purged.

---

## 4. Parse runs and typed lake objects

A **parse run** is one execution of one parser (a DATA agent task) over one or more snapshots,
producing zero or more typed objects. It is the middle link of lineage and the unit of retry in
the agent error queue (27a).

```sql
create table lake.parse_runs (
  id           bigint generated always as identity primary key,
  agent_id     uuid not null references iam.principals(id),
  parser_key   text not null,                  -- 'tdwl_dividend_v3','prospectus_v1','transcript_diarize_v2'
  parser_version text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','partial')),
  objects_created int not null default 0,
  objects_updated int not null default 0,
  error        text,
  retry_of     bigint references lake.parse_runs(id)
);
create index parse_runs_agent_idx on lake.parse_runs (agent_id, started_at desc);

create table lake.parse_run_snapshots (        -- lineage edge: run consumed snapshot
  parse_run_id bigint not null references lake.parse_runs(id) on delete cascade,
  snapshot_id  bigint not null references lake.snapshots(id),
  primary key (parse_run_id, snapshot_id)
);
```

The typed object table is the spine of the whole newsroom:

```sql
create type lake.object_state as enum ('PENDING','VERIFIED','CONFLICT','RETIRED');

create table lake.objects (
  id            uuid primary key default gen_random_uuid(),
  object_type   text not null,                 -- 'DIVIDEND.EXDATE','DISCLOSURE.DPS','FILING.FINANCIALS',
                                               -- 'IPO.COVERAGE','TRANSCRIPT.QUOTE','FILING.PROSPECTUS','COMPUTED.YIELD',...
  natural_key   text not null,                 -- deterministic identity, e.g. 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1'
  security_id   bigint references public.securities(id),
  venue_code    text references public.venues(code),
  payload       jsonb not null,                -- typed value: {"dps":0.55,"ccy":"SAR","ex_date":"2026-07-28",...}
  numeric_value numeric,                       -- fast-path scalar for the datapoint fan-out, nullable
  unit          text,
  effective_date date,                         -- business date the fact refers to
  state         lake.object_state not null default 'PENDING',
  confidence    numeric(4,3),                  -- parser confidence; <0.61 auto-kickback threshold lives in ops config
  revision      int not null default 1,
  parse_run_id  bigint not null references lake.parse_runs(id),
  source_rank   int not null default 100,      -- primary-source-wins ordering (registrar=10, exchange=20, press=90)
  verified_at   timestamptz,
  verified_by   uuid references iam.principals(id),  -- cross-check agent, or human for price-sensitive confirms
  price_sensitive boolean not null default false,    -- true ⇒ VERIFIED requires human principal (33b rule)
  cited_count   int not null default 0,        -- maintained by citation triggers
  superseded_by uuid references lake.objects(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint one_live_per_key unique (natural_key, revision)
);
create index objects_type_state_idx    on lake.objects (object_type, state);
create index objects_security_idx      on lake.objects (security_id, object_type, effective_date desc);
-- UNIQUE (post-review): exactly one live (non-superseded) row per natural key, guaranteeing
-- lake.verified_objects never returns duplicates even under concurrent parse runs/retries.
-- Revision insert is supersede-then-insert in ONE transaction; the loser of a race gets a
-- unique violation and retries by superseding the winner instead.
create unique index objects_natural_key_live_uni on lake.objects (natural_key) where superseded_by is null;
create index objects_pending_idx       on lake.objects (created_at) where state = 'PENDING';
create index objects_payload_gin       on lake.objects using gin (payload jsonb_path_ops);
```

State machine enforcement (mirrors design section 4):

- A `before update` trigger permits only: `PENDING→VERIFIED`, `PENDING→CONFLICT`,
  `CONFLICT→VERIFIED`, `VERIFIED→RETIRED` (supersession), and requires
  `verified_by` to reference a **human** principal when `price_sensitive` — the 33b human-confirm
  gate is a database constraint, not an application convention.
- **Value changes never update in place.** A new revision row is inserted with
  `revision = n+1`; the old row gets `superseded_by` set and state `RETIRED`. The pair is
  recorded:

```sql
create table lake.object_revisions (
  id             bigint generated always as identity primary key,
  natural_key    text not null,
  old_object_id  uuid not null references lake.objects(id),
  new_object_id  uuid not null references lake.objects(id),
  old_value      jsonb not null,
  new_value      jsonb not null,
  reason         text not null check (reason in ('source_update','correction','human_override','conflict_resolution')),
  actor_id       uuid not null references iam.principals(id),
  created_at     timestamptz not null default now()
);
create index object_revisions_key_idx on lake.object_revisions (natural_key, created_at desc);
```

The conflict inspector (29a) needs the competing candidates side by side:

```sql
create table lake.object_conflicts (
  id            bigint generated always as identity primary key,
  natural_key   text not null,
  object_id     uuid not null references lake.objects(id),   -- the row parked in state CONFLICT
  candidates    jsonb not null,   -- [{"value":..., "source_key":..., "snapshot_id":..., "source_rank":10}, ...]
  policy        text not null default 'primary_wins',
  status        text not null default 'open' check (status in ('open','resolved_primary','resolved_override','escalated')),
  resolved_by   uuid references iam.principals(id),
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz not null default now()
);
create index object_conflicts_open_idx on lake.object_conflicts (created_at) where status = 'open';
```

Writers query a hardened view — the only lake surface WRITER agents' tokens can reach:

```sql
create view lake.verified_objects as
  select * from lake.objects where state = 'VERIFIED' and superseded_by is null;
```

---

## 5. Citation graph and R-07 auto-flagging

Citations connect published claims to lake objects. They power the 27b provenance panel
("VERIFIED VS LAKE 14/14"), R-03/R-04 rule evaluation, and the R-07 correction fan-out.

```sql
create table lake.citations (
  id             bigint generated always as identity primary key,
  content_id     uuid not null references public.content_items(id) on delete cascade,
  object_id      uuid not null references lake.objects(id),
  block_key      text,                          -- which BLK-* rendered it, if block-bound
  claim_text     text,                          -- the sentence/cell the number appears in
  quoted_value   text,                          -- exact figure as it appears in copy (R-04 checks ±0.5%)
  cited_by       uuid not null references iam.principals(id),   -- writer agent or human author
  created_at     timestamptz not null default now()
);
create unique index citations_uni on lake.citations (content_id, object_id, coalesce(block_key,''));
create index citations_object_idx  on lake.citations (object_id);
create index citations_content_idx on lake.citations (content_id);

-- cited_count maintenance
create or replace function lake.bump_cited_count() returns trigger ... -- +1/-1 on insert/delete
```

**R-07 flow (corrected object auto-flags citing articles)** — a trigger on
`lake.object_revisions`:

1. Insert into `ops.correction_flags` one row per citing content item across the revision
   chain of the `natural_key` (`join lake.citations c on c.object_id in (old revisions)`)
   where `content_items.status in ('live','updated')` — an already-corrected piece can need a
   second flag — **plus** pending pieces (status in draft/in_review/rules_check/approval/
   scheduled) that cite the object or carry it as a `content_blocks.bound_object_id`, so the
   33b promise "fan-out reaches BLK blocks in pending pieces" holds before publish, not after.
2. Each flag lands in the Desk needs-attention queue; a human (or the publishing agent in
   FLAG-ONLY mode) drafts the visible correction note; approving it appends a
   `content_corrections` row (section 8) — never a silent rewrite (25b policy).

```sql
create table ops.correction_flags (
  id            bigint generated always as identity primary key,
  content_id    uuid not null references public.content_items(id),
  revision_id   bigint not null references lake.object_revisions(id),
  status        text not null default 'open' check (status in ('open','note_drafted','resolved','dismissed')),
  resolved_by   uuid references iam.principals(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index correction_flags_open_idx on ops.correction_flags (created_at) where status = 'open';
```

Traversals the product needs, all plain SQL:

- *Which pieces must I flag?* one join (above) — no graph engine.
- *Full lineage for the Desk inspector:* `object → parse_runs → parse_run_snapshots →
  snapshots`, one three-join query.
- *Citation contract stats on 29a* (`cited_count`, "held from writers, cited = 0"): maintained
  counters + partial indexes.

---

## 6. Datapoints time-series (the "graph format" deliverable)

`public.datapoints` is the single queryable projection of every numeric fact the platform knows,
keyed by entity + metric + period, with provenance to the lake object it came from. The stock
page's "43 analyst-maintained tracked datapoints", chart tabs, screener fields, BLK live embeds,
compare, and AI grounding all read this one table. It is written only by the fan-out trigger on
lake verification and by Workbench datapoint quick-add (which itself creates a lake object
first — no number enters `datapoints` without lineage).

```sql
create table public.datapoint_series (
  id            bigint generated always as identity primary key,
  security_id   bigint references public.securities(id),
  entity_kind   text not null default 'security' check (entity_kind in ('security','index','venue','macro')),
  entity_ref    text,                           -- for non-security series, e.g. 'TASI'
  metric_key    text not null,                  -- 'gas_production_bcfd','dps','fy_eps','payout_ratio'
  display_name  text not null,
  unit          text not null,
  cadence       text not null check (cadence in ('quarterly','annual','monthly','event','daily')),
  maintainer_id uuid references iam.principals(id),   -- named analyst for analyst-maintained series (18b)
  revision_sla_hours int not null default 24,
  is_public     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (entity_kind, coalesce(entity_ref,''), coalesce(security_id,0), metric_key)  -- as unique index in migration
);

create table public.datapoints (
  id              bigint generated always as identity primary key,
  series_id       bigint not null references public.datapoint_series(id) on delete cascade,
  period          text not null,                -- '2026-Q2','FY2025','2026-07-28' — sortable label
  period_end      date not null,
  value           numeric not null,
  prev_value      numeric,                      -- vs-prior delta support (1n quick-add)
  source_object_id uuid not null references lake.objects(id),   -- lineage edge — the graph requirement
  as_of           timestamptz not null default now(),
  superseded_by   bigint references public.datapoints(id),      -- revisions keep history
  unique (series_id, period_end, coalesce(superseded_by,0))     -- as partial unique index: one live value per period
);
create index datapoints_series_idx on public.datapoints (series_id, period_end desc) where superseded_by is null;
```

(Both `unique(...)` notes above ship as partial/expression unique **indexes** in the migration —
noted to keep DDL here readable.)

Why this satisfies "graph format" without a graph database: the datapoint row *is* a node with
two typed edges — `series_id` (what it measures, for what entity) and `source_object_id` (where
it came from). Join outward and you have the full graph: datapoint → object → parse run →
snapshot in one direction; object → citations → articles in the other. Any client can therefore
ask for the data "as a graph" (edges are rows), as a time series (`order by period_end`), as a
matrix (crosstab), or as CSV — it's one relational table with indexed edges. Cost: USD 0.

RLS: series with `is_public = false` (desk-internal models) are invisible to readers; the rest
are world-readable. Freshness/staleness scans (>30 d, 1n) are a nightly query over
`max(as_of) per series`, no extra schema.

---

## 7. Market reference & prices

```sql
create table public.venues (
  code          text primary key,               -- 'TDWL','DFM','ADX','QE','MSX','BHB','BK'
  name          text not null,
  country       char(2) not null,
  timezone      text not null,                  -- 'Asia/Riyadh','Asia/Dubai','Asia/Qatar','Asia/Muscat','Asia/Bahrain'
  currency      char(3) not null,
  mic           text,
  trading_days  int[] not null default '{0,1,2,3,4}',  -- dow, 0=Sun … 4=Thu
  delay_minutes int not null default 15,        -- scrape-only: our freshest tier per venue
  owning_agent  uuid references iam.principals(id),
  is_active     boolean not null default true,
  sort_order    int not null default 100
);
```

**DEFAULTED — owner may override** (open question 6): Kuwait (`BK`) is seeded with
`is_active = false` — the row exists so reader copy, onboarding grids, and indices can reference
it read-only, but no data agent, no securities, no scraping in v1.

```sql
create table public.market_sessions (          -- regular hours, incl. Ramadan variants
  id          bigint generated always as identity primary key,
  venue_code  text not null references public.venues(code),
  session_kind text not null default 'regular' check (session_kind in ('regular','ramadan','half_day')),
  open_local  time not null,                    -- 10:00
  close_local time not null,                    -- 15:00 / 13:00 ramadan
  auction_open_local time,
  effective_from date not null,
  effective_to   date,
  confirmed_by uuid references iam.principals(id),  -- Hijri-dependent rows require human confirm (33a)
  confirmed_at timestamptz
);
create index market_sessions_lookup on public.market_sessions (venue_code, effective_from desc);

create table public.market_holidays (
  id          bigint generated always as identity primary key,
  venue_code  text not null references public.venues(code),
  holiday_date date not null,
  name        text not null,
  is_hijri_estimated boolean not null default false, -- true until human confirms actual date
  confirmed_by uuid references iam.principals(id),
  confirmed_at timestamptz,
  unique (venue_code, holiday_date)
);
```

```sql
create table public.securities (
  id            bigint generated always as identity primary key,
  venue_code    text not null references public.venues(code),
  ticker        text not null,                  -- '2222','QNBK','FAB'
  isin          text,
  name_en       text not null,
  -- AR-LATER: name_ar text
  sector        text not null,                  -- 11-sector taxonomy, FK to public.sectors(key)
  industry      text,
  board_segment text,                           -- 'MAIN','NOMU','IPO-1'
  currency      char(3) not null,
  free_float_pct numeric(6,3),
  shares_outstanding numeric(20,0),
  listing_date  date,
  status        text not null default 'listed' check (status in ('pre_listing','listed','suspended','delisted')),
  score_eligible_from date,                     -- listing_date + 90 trading days (22c rule), set by listing job
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_code, ticker)
);
create index securities_sector_idx on public.securities (sector);
create index securities_name_trgm on public.securities using gin (name_en gin_trgm_ops);  -- search

create table public.sectors ( key text primary key, name text not null, sort_order int );

create table public.indices (
  code        text primary key,                 -- 'TASI','DFMGI','FADGI','QSI','MSX30','BAX'
  venue_code  text not null references public.venues(code),
  name        text not null,
  is_composite boolean not null default true
);

create table public.index_sector_weights (      -- 2b sector band
  index_code  text not null references public.indices(code),
  sector      text not null references public.sectors(key),
  weight_pct  numeric(6,3) not null,
  as_of       date not null,
  primary key (index_code, sector, as_of)
);

create table public.fx_rates (
  pair        text not null,                    -- 'USDSAR','USDAED',...
  rate        numeric(18,8) not null,
  as_of       timestamptz not null,
  is_pegged   boolean not null default false,   -- USDSAR 3.7500
  primary key (pair, as_of)
);
```

### Quotes (delayed, scrape-only) — hot row + partitioned history

Two tables, deliberately: an **unpartitioned hot table with exactly one row per security**
(what every ticker chip, watchlist, heatmap, and screener reads — stays ~812 rows, always in
cache) and a **partitioned append-only history** for intraday sparklines and "updated N min ago"
forensics.

```sql
create table public.quotes_latest (
  security_id  bigint primary key references public.securities(id) on delete cascade,
  last         numeric(18,6),
  change       numeric(18,6),
  change_pct   numeric(9,4),
  open         numeric(18,6),
  high         numeric(18,6),
  low          numeric(18,6),
  volume       numeric(20,0),
  vwap         numeric(18,6),
  week52_high  numeric(18,6),
  week52_low   numeric(18,6),
  as_of        timestamptz not null,            -- exchange timestamp of the delayed print
  captured_at  timestamptz not null,            -- when our scraper saw it
  delay_minutes int not null default 15,        -- rendered by FreshnessBadge as DELAYED
  snapshot_id  bigint references lake.snapshots(id),  -- lineage for the current print
  tick_dir     smallint check (tick_dir in (-1,0,1))
);

create table public.quotes_intraday (
  security_id  bigint not null,
  captured_at  timestamptz not null,
  last         numeric(18,6) not null,
  change_pct   numeric(9,4),
  volume       numeric(20,0),
  snapshot_id  bigint,
  primary key (security_id, captured_at)
) partition by range (captured_at);
-- monthly partitions quotes_intraday_y2026m07 …; retention 3 months (section 12)
```

Volume math: 6 venues × ~15-minute scrape cadence during ~5-hour sessions ≈ 20 prints/day ×
812 securities ≈ **16 K rows/day, ~350 K rows/month, ~40 MB/month with indexes** — comfortably
cheap; 3-month retention caps it near 120 MB. Debut-day 1-minute bars (22c) reuse this table at
1-minute cadence for the debut security only (one listing day ≈ 300 extra rows — noise).

```sql
create table public.ohlcv_daily (
  security_id  bigint not null references public.securities(id),
  trade_date   date not null,
  open numeric(18,6), high numeric(18,6), low numeric(18,6), close numeric(18,6) not null,
  volume numeric(20,0),
  value_traded numeric(20,2),
  primary key (security_id, trade_date)
);
-- 812 × ~250 sessions ≈ 200 K rows/yr ≈ 25 MB/yr. Not partitioned; 10-year backfill still < 300 MB.

create table public.index_levels (
  index_code  text not null references public.indices(code),
  as_of       timestamptz not null,
  level numeric(18,4) not null, change numeric(18,4), change_pct numeric(9,4),
  day_high numeric(18,4), day_low numeric(18,4), value_traded numeric(20,2),
  primary key (index_code, as_of)
);
create table public.index_levels_daily (
  index_code text not null references public.indices(code),
  trade_date date not null,
  open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4) not null,
  primary key (index_code, trade_date)
);
```

`index_levels` (intraday) keeps 90 days then relies on `index_levels_daily`; at 7 indices ×
20 prints/day it is ~4 K rows/month — retention is about hygiene, not cost.

### Freshness & halts (6-state machine)

```sql
create table public.venue_feed_status (         -- one row per venue; the 33a feed cards
  venue_code   text primary key references public.venues(code),
  state        text not null default 'delayed'
               check (state in ('live','reconnecting','delayed','offline','halted','auction')),
  detail       text,                            -- 'LAST SYNC 09:19 · RETRY 4'
  last_sync_at timestamptz,
  retry_count  int not null default 0,
  latency_ms   int,
  updated_at   timestamptz not null default now()
);
-- Under scrape-only, steady state is 'delayed'; 'reconnecting/offline' when scrapes fail;
-- 'auction'/'halted' at venue level for market-wide events. World-readable (badge propagation).

create table public.security_status (           -- ticker-level overrides: HALTED / AUCTION / STALE
  security_id  bigint primary key references public.securities(id),
  state        text not null check (state in ('halted','auction','stale')),
  reason       text,
  resume_at    timestamptz,
  annotated_by uuid references iam.principals(id),   -- desk annotation (33a halts desk)
  linked_wire  uuid references public.content_items(id),
  updated_at   timestamptz not null default now()
);
-- Row present = abnormal state; row absent = normal. Halt alerts bypass quiet hours (section 15).
```

Sector heatmap aggregates and movers are **materialized views** (`public.mv_sector_heatmap`,
`public.mv_movers`) refreshed by the post-scrape job — `REFRESH MATERIALIZED VIEW CONCURRENTLY`
every 15 minutes during sessions costs milliseconds at 812 rows and saves every reader the
aggregation.

---

## 8. Fundamentals, filings, events

### Financial statements

```sql
create table public.financial_statements (
  id            bigint generated always as identity primary key,
  security_id   bigint not null references public.securities(id),
  statement_type text not null check (statement_type in ('income','balance','cashflow')),
  basis         text not null default 'consolidated' check (basis in ('consolidated','standalone')),
  period_kind   text not null check (period_kind in ('quarter','annual','ttm')),
  fiscal_period text not null,                  -- '2026-Q2','FY2025','TTM'
  period_end    date not null,
  currency      char(3) not null,
  is_estimate   boolean not null default false, -- desk estimate rows: 'JUN ''26E' (3b)
  line_items    jsonb not null,                 -- {"revenue": 121.6e9, "gross_profit": ..., "eps": 1.62, ...}
  segments      jsonb,                          -- segment views (3b SEGMENTS tab)
  source_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),   -- lineage
  audited       boolean,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (security_id, statement_type, basis, fiscal_period, is_estimate)
);
create index fin_stmt_lookup on public.financial_statements (security_id, statement_type, period_end desc);
```

Line items are `jsonb`, not one-column-per-metric: GCC issuers span banks (NIM, deposits),
insurers, and industrials — a fixed wide table would be 70% NULLs and need migrations per new
metric. The screener does not scan this table; it scans `key_ratios` (below), which is flat.

```sql
create table public.key_ratios (               -- one row per security, recomputed nightly; the screener's scan target
  security_id  bigint primary key references public.securities(id) on delete cascade,
  market_cap   numeric(20,2), pe numeric(10,3), pb numeric(10,3), eps_ttm numeric(12,4),
  book_value_ps numeric(12,4), dividend_yield numeric(7,4), payout_ratio numeric(7,4),
  roe numeric(7,4), roce numeric(7,4), nim numeric(7,4),
  net_debt_ebitda numeric(8,3), ev_ebitda numeric(10,3), ps numeric(10,3),
  computed_at  timestamptz not null default now(),
  source_object_id uuid references lake.objects(id)    -- COMPUTED.* lake object per recompute batch
);
```

### Filings

```sql
create table public.filings (
  id            bigint generated always as identity primary key,
  security_id   bigint references public.securities(id),   -- null for market-wide notices
  venue_code    text not null references public.venues(code),
  source_ref    text not null,                  -- 'TADAWUL CG-1-2026-4471'
  form_code     text,                           -- 'CG-1','M-2','FS-1','FS-4','CG-7'
  filing_type   text not null check (filing_type in
                ('DIVIDEND','CAPEX','RESULTS','RATING','GOVERNANCE','OPS','CONTRACT','PROSPECTUS','OTHER')),
  title         text not null,
  filed_at      timestamptz not null,
  full_text     text,                           -- machine-extracted EN text (TOAST-compressed)
  extracted_facts jsonb,                        -- type-specific grid: {"dps":0.55,"ex_date":"2026-07-28",...}
  is_market_moving boolean not null default false,
  pdf_en_path   text,                           -- Storage bucket 'filings'
  -- AR-LATER: pdf_ar_path text
  pdf_pages     int,
  ai_summary    text,
  ai_summary_model text,                        -- provenance for the LLM gateway (provider-agnostic)
  parse_run_id  bigint references lake.parse_runs(id),
  search_tsv    tsvector generated always as
                (setweight(to_tsvector('english', coalesce(title,'')),'A') ||
                 setweight(to_tsvector('english', left(coalesce(full_text,''), 200000)),'B')) stored,
  created_at    timestamptz not null default now(),
  unique (venue_code, source_ref)
);
create index filings_security_time on public.filings (security_id, filed_at desc);
create index filings_venue_time    on public.filings (venue_code, filed_at desc);
create index filings_tsv           on public.filings using gin (search_tsv);
```

Filing PDFs go to Storage bucket `filings` (public-read via CDN — they are public documents;
free egress pressure is low because readers mostly view extracted text). Full text stays in the
table: it is the phrase-alert scan target and FTS corpus; at ~25 K filings/yr × ~15 KB average
it adds ~400 MB/yr — acceptable, and the biggest single DB consumer, so it is the first
candidate for a 5-year text-retention window later (metadata kept forever).

### Transcripts

```sql
create table public.transcripts (
  id            bigint generated always as identity primary key,
  security_id   bigint not null references public.securities(id),
  earnings_event_id bigint references public.earnings_events(id),
  call_datetime timestamptz not null,
  duration_seconds int,
  status        text not null default 'upcoming'
                check (status in ('upcoming','audio_ingested','transcribed','desk_reviewed','summary_ready')),
  audio_path    text,                            -- Storage bucket 'transcripts'
  chapters      jsonb,                           -- [{"t":0,"title":"Opening remarks"},...]
  ai_summary    jsonb,                           -- bullets with novelty flags ("first buyback mention in 4 quarters")
  ai_summary_model text,
  parse_run_id  bigint references lake.parse_runs(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.transcript_segments (
  id            bigint generated always as identity primary key,
  transcript_id bigint not null references public.transcripts(id) on delete cascade,
  seq           int not null,
  start_ms      int not null,
  speaker_name  text,
  speaker_role  text,                            -- 'CEO','CFO','Analyst — Marsad'
  body          text not null,
  search_tsv    tsvector generated always as (to_tsvector('english', body)) stored,
  unique (transcript_id, seq)
);
create index transcript_segments_tsv on public.transcript_segments using gin (search_tsv);
```

TRANSCRIPT.QUOTE lake objects reference `(transcript_id, seq)` inside their payload so BLK-QUOTE
citations resolve to an exact diarized segment.

### Earnings: events, estimates, surprises

```sql
create table public.earnings_events (
  id            bigint generated always as identity primary key,
  security_id   bigint not null references public.securities(id),
  fiscal_period text not null,                  -- '2026-Q2'
  report_date   date not null,
  date_state    text not null default 'estimated' check (date_state in ('confirmed','estimated')),
  session       text check (session in ('pre','post')),
  eps_consensus numeric(12,4),
  eps_marsad    numeric(12,4),
  eps_prior     numeric(12,4),
  eps_actual    numeric(12,4),
  revenue_consensus numeric(20,2), revenue_actual numeric(20,2),
  verdict       text check (verdict in ('BEAT','IN_LINE','MISS','HELD')),   -- thresholds configured in ops.rulesets
  surprise_pct  numeric(9,4),
  next_session_reaction_pct numeric(9,4),
  rvc_table     jsonb,                           -- line-item vs consensus with polarity (8b)
  segment_breakdown jsonb,
  desk_take     text,
  house_rank    int,                             -- 'closest of 14'
  results_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (security_id, fiscal_period)
);
create index earnings_calendar_idx on public.earnings_events (report_date, security_id);

create table public.estimates (                 -- point-in-time estimate observations (8c revision series)
  id            bigint generated always as identity primary key,
  security_id   bigint not null references public.securities(id),
  metric        text not null,                  -- 'FY26_EPS'
  source        text not null check (source in ('consensus','marsad')),
  value         numeric(14,4) not null,
  n_analysts    int,                            -- breadth; thin-coverage flag when <= 2
  as_of         date not null,
  source_object_id uuid references lake.objects(id),
  unique (security_id, metric, source, as_of)
);
create index estimates_series_idx on public.estimates (security_id, metric, source, as_of desc);
```

Surprise scorecards (8d) and revision leaders/laggards are nightly materialized views over
`earnings_events` and `estimates` — no extra base tables. **Open question 10 (consensus
sourcing) is deliberately left open in data terms**: `estimates.source_object_id` lineage will
carry whatever scrape source is chosen; no vendor-specific columns exist. DEFAULTED — consensus
rows may simply be sparse (MSX 41% gap acknowledged in the design) until a source is picked.

### Dividends

```sql
create table public.dividends (
  id            bigint generated always as identity primary key,
  security_id   bigint not null references public.securities(id),
  div_type      text not null check (div_type in ('FINAL','INTERIM','SPECIAL')),
  fiscal_ref    text,                           -- 'FY2025','2026-INT1'
  dps           numeric(12,6) not null,
  currency      char(3) not null,
  ex_date       date,
  record_date   date,
  pay_date      date,
  yield_at_announce numeric(7,4),
  payout_ratio  numeric(7,4),                   -- >1.00 renders cut-risk flag (23a) — presentation rule, not schema
  verification  text not null default 'disclosure' check (verification in ('registrar','disclosure')),
  state         text not null default 'pending_confirm' check (state in ('pending_confirm','live','cancelled')),
  confirmed_by  uuid references iam.principals(id),   -- human confirm gate (33b) — enforced by trigger with lake row
  confirmed_at  timestamptz,
  source_object_id uuid not null references lake.objects(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (security_id, div_type, coalesce(fiscal_ref,''), coalesce(ex_date, '9999-12-31'))  -- as unique index
);
create index dividends_exdate_idx on public.dividends (ex_date) where state = 'live';
```

**Single-write fan-out** is a property of this design rather than a mechanism to build: the
dividend calendar (23a), stock page dividend card, BLK-EXDATE blocks, and ex-date alert engine
all *read this one row* (or the lake object behind it). Human confirm flips
`state → 'live'` in one UPDATE inside `billing`-grade transaction, a trigger enqueues ex-date
reminder alert candidates and notifies `pg_notify('fanout','dividend:<id>')` for any listening
revalidation hooks (Next.js ISR revalidate calls). Nothing is copied anywhere.

### IPOs

```sql
create table public.ipo_offers (
  id            bigint generated always as identity primary key,
  security_id   bigint references public.securities(id),   -- null until ticker assigned
  company_name  text not null,
  venue_code    text not null references public.venues(code),
  stage         text not null check (stage in
                ('intention','draft_prospectus','filing','bookbuilding','retail_open','allocation','listed')),
  price_range_low numeric(18,6), price_range_high numeric(18,6), final_price numeric(18,6),
  offer_size_pct numeric(6,3), shares_offered numeric(20,0), raise_amount numeric(20,2),
  implied_mcap numeric(20,2), implied_pe numeric(10,3), implied_yield numeric(7,4),
  retail_tranche_pct numeric(6,3), min_lot int,
  dividend_policy text, use_of_proceeds jsonb, brokers jsonb, refunds_by date,
  retail_open_at timestamptz, retail_close_at timestamptz, expected_listing date,
  maintainer_agent uuid references iam.principals(id),
  object_state  text not null default 'draft' check (object_state in ('agent_current','needs_review','draft')),
  prospectus_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.ipo_timeline_events (       -- 5-stage timeline with coverage multiples (22b)
  id           bigint generated always as identity primary key,
  ipo_id       bigint not null references public.ipo_offers(id) on delete cascade,
  stage        text not null,
  starts_at    timestamptz, ends_at timestamptz,
  coverage_inst numeric(8,3), coverage_retail numeric(8,3),   -- 4.6× / 3.1×
  is_price_sensitive boolean not null default false,
  source_object_id uuid references lake.objects(id),
  updated_at   timestamptz not null default now()
);

create table public.listing_debuts (
  ipo_id       bigint primary key references public.ipo_offers(id),
  security_id  bigint not null references public.securities(id),
  debut_date   date not null,
  offer_price  numeric(18,6) not null,
  open_price numeric(18,6), auction_price numeric(18,6), auction_volume numeric(20,0),
  vwap numeric(18,6), free_float_traded_pct numeric(6,3),
  allocation_recap jsonb                          -- retail % of applied, coverages, refund date
);
```

Price-sensitive IPO changes (price range, dates) follow the same trigger-enforced human-confirm
gate as dividends: an update touching a price-sensitive column while `object_state =
'agent_current'` flips it to `needs_review` and the change is staged in the lake object, not
applied, until a human principal confirms (33b).

### Ownership

```sql
create table public.holders (
  id           bigint generated always as identity primary key,
  name         text not null,
  holder_type  text not null check (holder_type in ('sovereign','institution','family_office','fund','individual')),
  country      char(2),
  established  int,
  disclosed_value_usd numeric(20,2),
  aum_self_reported boolean not null default false,
  created_at   timestamptz not null default now()
);

create table public.holder_positions (           -- quarterly snapshots from >5% disclosures
  id           bigint generated always as identity primary key,
  holder_id    bigint not null references public.holders(id),
  security_id  bigint not null references public.securities(id),
  as_of        date not null,
  stake_pct    numeric(7,4) not null,
  qoq_change_pp numeric(7,4),
  source_filing_id bigint references public.filings(id),
  source_object_id uuid references lake.objects(id),
  unique (holder_id, security_id, as_of)
);
create index holder_positions_sec_idx on public.holder_positions (security_id, as_of desc);

create table public.ownership_snapshots (        -- 3d shareholding matrix by category + FOL
  security_id  bigint not null references public.securities(id),
  as_of        date not null,
  categories   jsonb not null,                   -- {"government":..., "institutions":..., "foreign":1.19,...}
  foreign_ownership_pct numeric(7,4),
  is_fol_record boolean not null default false,
  source_object_id uuid references lake.objects(id),
  primary key (security_id, as_of)
);
```

---

## 9. Marsad Score

```sql
create table public.scores (                     -- current score, one row per security
  security_id   bigint primary key references public.securities(id) on delete cascade,
  score         smallint not null check (score between 0 and 100),
  rating        text not null check (rating in ('BUY','OVERWEIGHT','HOLD','UNDERWEIGHT','SELL')),
  weekly_delta  smallint,
  grade_value text, grade_growth text, grade_profitability text, grade_momentum text, grade_revisions text,
                                                  -- 'A'…'D' with +/-; CHECK via regexp '^[A-D][+-]?$'
  sector_percentile smallint, sector_peer_count int,
  computed_at   timestamptz not null,             -- 04:00 GST batch stamp
  next_compute_at timestamptz,
  source_object_id uuid references lake.objects(id)  -- COMPUTED.SCORE object per batch for lineage
);
-- Securities not score-eligible (within 90 trading days of listing) simply have no row: the UI
-- 'PENDING' state (22c) = absence + securities.score_eligible_from in the future.

create table public.score_history (
  security_id  bigint not null references public.securities(id),
  computed_on  date not null,
  score smallint not null, rating text not null,
  grades jsonb not null,                          -- {"value":"B+","growth":"A-",...}
  sector_percentile smallint,
  primary key (security_id, computed_on)
);
-- 812 rows/day ≈ 300 K rows/yr ≈ 30 MB/yr. Plain table, no partitioning needed for years.

create table public.score_events (               -- score-change feed for front page 2b + alerts
  id           bigint generated always as identity primary key,
  security_id  bigint not null references public.securities(id),
  event_kind   text not null check (event_kind in ('score_change','rating_change','grade_change')),
  old_value text, new_value text,
  detail jsonb,                                   -- {"factor":"revisions","from":"B","to":"B+"}
  occurred_at  timestamptz not null default now()
);
create index score_events_time_idx on public.score_events (occurred_at desc);

create table public.marsad_select (              -- premium 5-name monthly module
  rebalance_month date not null,                 -- first of month
  rank smallint not null check (rank between 1 and 5),
  security_id bigint not null references public.securities(id),
  note text,
  primary key (rebalance_month, rank)
);
```

**DEFAULTED — owner may override** (open question 8): the platform rating vocabulary is the
5-notch set above; `STRONG_BUY` is allowed only in `analyst_calls.rating` (human analysts),
matching the observation that Strong Buy appears solely in analyst contexts.

---

## 10. Content, templates, blocks, editorial

```sql
create table public.content_items (
  id            uuid primary key default gen_random_uuid(),
  content_type  text not null check (content_type in ('WIRE','ARTICLE','EXPLAINER','NOTE','TAKE','NEWSLETTER')),
  slug          text unique,
  section       text,
  kicker text, dek text,
  headline      text not null check (char_length(headline) <= 90),   -- R-10 hard floor at the DB
  status        text not null default 'draft' check (status in
                ('draft','in_review','rules_check','approval','scheduled','live','updated','sent','retracted')),
  template_key  text references ops.templates(key),
  author_id     uuid not null references iam.principals(id),          -- human or agent — one model
  byline_chain  jsonb not null default '[]',     -- [{"role":"drafted_by","principal":"WRITER-2"},...]
  is_premium    boolean not null default false,
  premium_cut_after_block int,                    -- gate position; body rows carry `gated` (below)
  read_minutes  smallint,
  evergreen     boolean not null default false,
  review_cadence_days int,                        -- explainers: quarterly desk review
  reading_level text,
  due_at timestamptz, scheduled_at timestamptz, published_at timestamptz,
  social_card   jsonb,                            -- {"title": "...", "image_path": "..."} 1200×630
  rating_attachment jsonb,                        -- {"security_id":..., "rating":"OVERWEIGHT","pt":112}
  retraction_notice text,                         -- URL stays live (R-08)
  word_count    int,
  search_tsv    tsvector generated always as
                (to_tsvector('english', coalesce(headline,'') || ' ' || coalesce(dek,''))) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index content_status_idx  on public.content_items (status, coalesce(scheduled_at, published_at));
create index content_section_idx on public.content_items (section, published_at desc) where status in ('live','updated');
create index content_tsv         on public.content_items using gin (search_tsv);

create table public.content_tickers (            -- multi-ticker tagging; R-02 resolvable-instrument check is the FK
  content_id  uuid not null references public.content_items(id) on delete cascade,
  security_id bigint not null references public.securities(id),
  is_primary  boolean not null default false,
  primary key (content_id, security_id)
);

create table public.content_blocks (             -- body as ordered blocks; THE premium gate
  id          bigint generated always as identity primary key,
  content_id  uuid not null references public.content_items(id) on delete cascade,
  seq         int not null,
  block_kind  text not null,                     -- 'paragraph','heading','pull_quote','exhibit','data_table',
                                                 -- or a BLK-* key: 'BLK-TICKER','BLK-EXDATE','BLK-VERDICT',...
  body        jsonb not null,                    -- text blocks: {"text": "..."}; BLK blocks: binding params
  bound_object_id uuid references lake.objects(id),  -- live block bindings re-render as objects update
  gated       boolean not null default false,    -- true = premium-only rows; RLS hides from free/anon
  unique (content_id, seq)
);
create index content_blocks_gated_idx on public.content_blocks (content_id, seq);
```

**This is the entitlement enforcement point for articles.** The editor's draggable "PREMIUM CUT"
sets `gated = true` on every block after the cut (and `premium_cut_after_block` for the editor
UI). RLS on `content_blocks` (section 11) means an anon/free session's query physically cannot
return gated rows — the paywall fade is rendered from metadata (`word_count`, block count), not
from delivered-and-hidden text. Block-level gates inside free pages (TPL-07's premium Marsad
Take) are just `gated = true` rows mid-sequence.

```sql
create table public.content_corrections (        -- R-07 visible notes; append-only
  id          bigint generated always as identity primary key,
  content_id  uuid not null references public.content_items(id),
  note        text not null,
  correction_flag_id bigint references ops.correction_flags(id),
  appended_by uuid not null references iam.principals(id),
  appended_at timestamptz not null default now()
);

create table public.content_revisions (          -- full body snapshots per save (25b revisions)
  id          bigint generated always as identity primary key,
  content_id  uuid not null references public.content_items(id) on delete cascade,
  snapshot    jsonb not null,                     -- item fields + ordered blocks
  saved_by    uuid not null references iam.principals(id),
  saved_at    timestamptz not null default now()
);

create table public.content_attachments (        -- members-only model files (XLSX)
  id bigint generated always as identity primary key,
  content_id uuid not null references public.content_items(id) on delete cascade,
  storage_path text not null,                     -- bucket 'attachments' (private; signed URLs, premium-checked server-side)
  filename text not null, byte_size int not null,
  members_only boolean not null default true
);
```

### Templates & story blocks (registry, mostly seed data)

```sql
create table ops.templates (
  key           text primary key,                -- 'TPL-01' … 'TPL-08'
  name          text not null,
  served_types  text[] not null,
  auto_select_rule text not null,                -- human-readable; evaluated in the publishing agent
  block_keys    text[] not null,
  auto_publish_eligible boolean not null default false,   -- true only for TPL-01
  always_premium boolean not null default false,          -- true only for TPL-08
  max_words     int                               -- TPL-01: 40 (see DEFAULT below)
);

create table ops.story_blocks (
  key           text primary key,                -- 'BLK-TICKER','BLK-DELTA','BLK-EXDATE', … (14 rows)
  name          text not null,
  lake_object_type text,                          -- binding contract: which object type feeds it
  consuming_templates text[] not null,
  renderer_component text not null                -- React component name in src/components/blocks/
);
```

**DEFAULTED — owner may override** (open question 9): the auto-publish gate is **≤ 40 words**
(`ops.templates.max_words = 40` for TPL-01 combined with `iam.global_switches.auto_publish_wires`).
TPL-01 still *serves* human-approved wires up to 90 words; only the ≤40-word single-event case
skips approval. Enforced in the publish function, word count recomputed server-side.

### Front page & navigation (versioned configs)

```sql
create table ops.front_page_versions (
  id          bigint generated always as identity primary key,
  version_no  int not null unique,               -- V39, V40, V41 …
  config      jsonb not null,                    -- slots (PINNED/AUTO + occupant + pin_expires_at),
                                                 -- wire rail order, module toggles, scheduled takeovers
  is_live     boolean not null default false,
  actor_id    uuid not null references iam.principals(id),   -- human or SYSTEM auto-flow
  created_at  timestamptz not null default now()
);
create unique index front_page_one_live on ops.front_page_versions (is_live) where is_live;

create table ops.nav_versions (
  id          bigint generated always as identity primary key,
  version_no  int not null unique,               -- V11 … V14
  tabs        jsonb not null,                    -- [{"key":"markets","label_en":"Markets","label_ar":null, -- AR-LATER
                                                 --   "visible":true,"premium":false,"new_pill":false}]
  mobile_slots jsonb not null,                   -- 5-slot bar + More sheet
  is_live     boolean not null default false,
  actor_id    uuid not null references iam.principals(id),
  created_at  timestamptz not null default now()
);
create unique index nav_one_live on ops.nav_versions (is_live) where is_live;
```

Whole-document versioning (jsonb per version, one live pointer) instead of row-level versioning:
these configs are read as a unit, edited as a unit, restored as a unit, and are tiny. The live
row is mirrored into a world-readable view `public.nav_config_live` for the reader shell.

### Analysts

```sql
create table public.analysts (
  principal_id  uuid primary key references iam.principals(id),
  title text, credential text, bio text,
  is_external   boolean not null default false,  -- accepted 20d applicants
  revenue_share_pct numeric(5,2),                -- mechanics undefined in designs (open question 13); column reserved
  joined_at     timestamptz not null default now()
);

create table public.analyst_calls (              -- IMMUTABLE track record
  id            bigint generated always as identity primary key,
  analyst_id    uuid not null references public.analysts(principal_id),
  security_id   bigint not null references public.securities(id),
  rating        text not null check (rating in ('STRONG_BUY','BUY','OVERWEIGHT','HOLD','UNDERWEIGHT','SELL')),
  price_target  numeric(18,6),
  published_at  timestamptz not null default now(),
  price_at_publication numeric(18,6) not null,   -- venue price snapshot — the anti-retroactivity anchor
  index_level_at_publication numeric(18,4) not null,
  content_id    uuid references public.content_items(id),
  closed_at     timestamptz,
  close_price numeric(18,6), close_index_level numeric(18,4),
  call_return_pct numeric(9,4), vs_index_pct numeric(9,4),
  review_due_at timestamptz                       -- published_at + 90 days
);
-- Trigger: UPDATE allowed only to the close_* / review columns; rating/PT/prices frozen forever.
create index analyst_calls_open_idx on public.analyst_calls (analyst_id) where closed_at is null;

create table public.analyst_applications (
  id bigint generated always as identity primary key,
  name text not null, email text not null, credentials text, coverage_focus text,
  sample_thesis text not null check (char_length(sample_thesis) <= 4000),
  status text not null default 'submitted' check (status in ('submitted','in_review','accepted','rejected')),
  reviewed_by uuid references iam.principals(id),
  submitted_at timestamptz not null default now(), decided_at timestamptz
);
```

Leaderboard stats (win rate, avg call return) are a nightly materialized view over
`analyst_calls` — never stored on the profile, so they cannot be edited retroactively either.

---

## 11. Rules engine (R-01…R-10, versioned, service not validation)

The rules service is a Next.js server module (`src/lib/rules/engine.ts`) invoked at submit and
publish for **all** content, agent- or human-authored, and by the 29b test console. Schema:

```sql
create table ops.rulesets (
  version_no  int primary key,                   -- V8, V9 …
  deployed_by uuid not null references iam.principals(id),   -- owner-only, enforced in function
  deployed_at timestamptz not null default now(),
  is_live     boolean not null default false,
  config      jsonb not null                      -- global knobs: beat/miss thresholds, numeric tolerance 0.5%
);
create unique index rulesets_one_live on ops.rulesets (is_live) where is_live;

create table ops.rules (
  ruleset_version int not null references ops.rulesets(version_no),
  rule_key    text not null,                     -- 'R-01' … 'R-10'
  title       text not null,
  body        text not null,
  scope       text not null default 'ALL' check (scope in ('ALL','NOTES_TAKES','PREMIUM')),
  enforcement text not null check (enforcement in ('BLOCK','WARN','AUTO_FIX','AUTO')),
  enabled     boolean not null default true,
  params      jsonb not null default '{}',
  primary key (ruleset_version, rule_key)
);

create table ops.banned_phrases (                -- R-05 lexicon; also screens ad creatives
  id bigint generated always as identity primary key,
  phrase text not null,
  lang   char(2) not null default 'en',          -- AR-LATER: 'ar' rows
  added_by uuid not null references iam.principals(id),
  added_at timestamptz not null default now(),
  unique (phrase, lang)
);

create table ops.rule_violations (               -- 29b violations feed; agents AND humans
  id bigint generated always as identity primary key,
  content_id uuid references public.content_items(id),
  ad_creative_id bigint references ops.ad_creatives(id),   -- R-05 on ads
  ruleset_version int not null,
  rule_key text not null,
  outcome text not null check (outcome in ('blocked','warned','auto_fixed','passed_after_fix')),
  detail jsonb,                                   -- offending phrase / number vs object delta / cut position
  actor_id uuid not null references iam.principals(id),
  occurred_at timestamptz not null default now(),
  foreign key (ruleset_version, rule_key) references ops.rules(ruleset_version, rule_key)
);
create index rule_violations_time on ops.rule_violations (occurred_at desc);
-- 7-day pass rates on 29b: aggregate query over this table, no extra storage.
```

Two rules are additionally enforced at the schema layer as backstops: R-10 headline length is a
CHECK constraint; R-02 ticker resolution is the `content_tickers` FK. R-03/R-04 evaluation joins
`lake.citations` against draft blocks; R-07/R-08 are the triggers in sections 5 and 10.

---

## 12. Agent runs, pipeline, errors

```sql
create table ops.agent_runs (                    -- every execution of every agent (27a run counts, live log source)
  id           bigint generated always as identity primary key,
  agent_id     uuid not null references iam.principals(id),
  task_key     text not null,                    -- 'scrape:tdwl.quotes','draft:earnings_recap','rules:evaluate'
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','killed')),
  parse_run_id bigint references lake.parse_runs(id),
  stats        jsonb not null default '{}',      -- rows scraped, objects written, tokens used, model id
  error        text
);
create index agent_runs_agent_time on ops.agent_runs (agent_id, started_at desc);
-- Retention: 90 days then delete (aggregates roll into ops.agent_daily_stats).

create table ops.pipeline_items (                -- newsroom conveyor: DRAFT→EDIT→RULES→APPROVAL→LIVE
  id           bigint generated always as identity primary key,
  content_id   uuid not null references public.content_items(id) on delete cascade,
  stage        text not null default 'queued' check (stage in
               ('queued','draft','edit','rules','approval','published','sent_back','reassigned_human')),
  writer_agent uuid references iam.principals(id),
  editor_agent uuid references iam.principals(id),
  confidence   numeric(4,3),
  queued_at    timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  approval_sla interval not null default '3 minutes',      -- 27b SLA timer basis
  approval_decision text check (approval_decision in
               ('publish_now','publish_at','send_back','reassign_human')),
  decided_by   uuid references iam.principals(id),
  decided_at   timestamptz,
  send_back_note text
);
create index pipeline_open_idx on ops.pipeline_items (stage, queued_at)
  where stage not in ('published','reassigned_human');

create table ops.agent_errors (                  -- 27a error queue
  id          bigint generated always as identity primary key,
  agent_id    uuid not null references iam.principals(id),
  agent_run_id bigint references ops.agent_runs(id),
  severity    text not null check (severity in ('infra','quality')),
  error_type  text not null,                     -- 'feed_parse_timeout','low_confidence','rules_fail'
  detail      jsonb,
  retry_count int not null default 0,
  status      text not null default 'open' check (status in ('open','retrying','muted','resolved','escalated_human')),
  muted_until timestamptz,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index agent_errors_open on ops.agent_errors (created_at) where status in ('open','retrying');
```

The 27a "live run log" is not a table of its own: it is a `pg_notify` stream emitted by
`agent_runs` insert/update triggers, tailed by the Desk over Supabase Realtime
(broadcast channel `agent-run-log`), with `agent_runs` as the replayable history. Zero extra
storage; the audit log (section 18) remains the durable record.

---

## 13. Plans, subscriptions, invoices (ZATCA), meters, credits

Stripe is the system of record for payment state; Postgres is the system of record for
entitlements and the ZATCA archive. Webhooks (`/api/webhooks/stripe`, service role) upsert here.

```sql
create table billing.plan_versions (             -- 33c monetization config, versioned, next-cycle-only
  id           bigint generated always as identity primary key,
  version_no   int not null unique,
  effective_from date not null,
  plans        jsonb not null,
  -- {"free":   {"price_sar":0,
  --             "meters": {"premium_reads_mo":2,"scores_mo":3,"ai_answers_mo":5,"ai_credits_mo":20},
  --             "limits": {"watchlists":1,"watchlist_names":10,"alerts_stock":10,"alerts_screen":2,
  --                        "alerts_phrase":2,"saved_screens":5}},
  --  "premium_monthly": {"price_sar":119, ...}, "premium_annual": {"price_sar":1228.20, "vat_incl":true, ...},
  --  "enterprise": {"from_sar":24000}}
  changed_by   uuid not null references iam.principals(id),   -- owner-only
  created_at   timestamptz not null default now()
);
```

**DEFAULTED — owner may override** (open question 1): the 33c admin config **is** the meter
source of truth; marketing copy reads from it. Both meter families exist: the monthly free-tier
meters (premium reads / scores / AI answers) *and* the AI credit balance; the "3 premium
reads" on older paywall copy is treated as stale copy against 33c's "2".

```sql
create table billing.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,  -- nullable: survives PDPL purge as an anonymous revenue record
  plan_key      text not null check (plan_key in ('free','premium_monthly','premium_annual','enterprise')),
  status        text not null check (status in ('trialing','active','past_due','paused','canceled')),
  stripe_customer_id text, stripe_subscription_id text unique,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  dunning_state text check (dunning_state in ('retry_1','retry_2','final','paused')),
  next_retry_at timestamptz,
  promo_code_id bigint references billing.promo_codes(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index one_active_sub_per_user on billing.subscriptions (user_id)
  where status in ('trialing','active','past_due','paused');

create table billing.invoices (                  -- ZATCA archive: NEVER hard-deleted, 10-year retention
  id            uuid primary key default gen_random_uuid(),
  order_no      text not null unique,            -- 'MP-2026-08114'
  user_id       uuid not null,                   -- NOT an FK cascade — survives PDPL account purge
  subscription_id uuid references billing.subscriptions(id),
  stripe_invoice_id text unique,
  issued_at     timestamptz not null,
  line_items    jsonb not null,
  subtotal_sar  numeric(14,2) not null,
  vat_rate      numeric(5,4) not null default 0.15,
  vat_amount_sar numeric(14,2) not null,
  total_sar     numeric(14,2) not null,
  currency      char(3) not null default 'SAR',
  seller_trn    text not null,                   -- Marsad TRN, on every invoice
  buyer_vat_id  text,                            -- optional capture at checkout
  buyer_name    text, buyer_country char(2),     -- denormalized for post-purge integrity
  payment_method text,                           -- 'mada','visa','applepay',...
  status        text not null check (status in ('scheduled','paid','failed','refunded','credit_note')),
  pdf_path      text,                            -- Storage bucket 'invoices' (private)
  zatca_payload jsonb,                           -- reserved: Phase-2 e-invoicing XML/QR fields when required
  created_at    timestamptz not null default now()
);
create index invoices_user_idx on billing.invoices (user_id, issued_at desc);

create table billing.payment_attempts (          -- dunning trail (30a card: retries 21/24 Jul)
  id bigint generated always as identity primary key,
  invoice_id uuid not null references billing.invoices(id),
  attempted_at timestamptz not null default now(),
  outcome text not null check (outcome in ('succeeded','declined','error')),
  decline_code text,                             -- 'CARD_DECLINED', mada guidance mapping
  attempt_no int not null
);

create table billing.promo_codes (
  id bigint generated always as identity primary key,
  code text not null unique,
  discount jsonb not null,                       -- {"pct":25} or {"months_free":1}
  activation_event text,                         -- event-conditioned starts (33c)
  max_redemptions int, redeemed_count int not null default 0,
  valid_from timestamptz, valid_to timestamptz,
  created_by uuid not null references iam.principals(id)
);
```

### Usage meters and AI credits

```sql
create table billing.usage_meters (              -- monthly free-tier counters
  user_id     uuid not null references auth.users(id) on delete cascade,
  meter_key   text not null,                     -- 'premium_reads','scores','ai_answers'
  period_month date not null,                    -- Gulf-calendar first-of-month
  used        int not null default 0,
  primary key (user_id, meter_key, period_month)
);

create table billing.credit_ledger (             -- AI credits: append-only ledger, balance = SUM
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  delta       int not null,                      -- +500 monthly grant, -14 answer, -40 thesis, +100 top-up, 0 refusal
  reason      text not null check (reason in
              ('monthly_grant','rollover','answer','deep_answer','thesis','topup','refund','expiry')),
  ref_id      uuid,                              -- ai_threads message id / Stripe payment intent
  expires_at  timestamptz,                       -- premium grants roll 1 month; expiry job writes negative rows
  created_at  timestamptz not null default now()
);
create index credit_ledger_user_idx on billing.credit_ledger (user_id, created_at desc);
```

Metering is enforced by two SECURITY DEFINER functions callable from route handlers only:
`billing.consume_meter(p_user, p_meter) returns boolean` (atomic upsert-and-check against the
live `plan_versions` limits) and `billing.spend_credits(p_user, p_cost, p_reason, p_ref)
returns int` (locks the user's ledger tail, rejects if balance < cost — refusals call it with
cost 0 so the "0 CREDITS CHARGED" event still logs). Clients never write these tables.

---

## 14. Engagement: watchlists, alerts, notebook, screens, AI threads

All user-owned; every table here carries the same RLS shape (`user_id = auth.uid()`), all
quota enforcement is in SECURITY DEFINER create-functions reading `billing.plan_versions`.

```sql
create table public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  column_prefs jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create table public.watchlist_members (
  watchlist_id uuid not null references public.watchlists(id) on delete cascade,
  security_id  bigint not null references public.securities(id) on delete cascade,
  added_at timestamptz not null default now(),
  note text,
  primary key (watchlist_id, security_id)
);

create table public.alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  alert_type    text not null check (alert_type in
                ('price_cross','score_change','filing_event','ratio','screen_match','phrase',
                 'ex_date_reminder','index_drawdown','transcript_arrival','ipo_books_open',
                 'holder_disclosure','series_update')),
  quota_bucket  text not null check (quota_bucket in ('stock','screen','phrase')),
  scope         jsonb not null,                  -- {"security_id":...} | {"screen_id":...} | {"venue":"MSX"} | {"phrase":"..."}
  condition     jsonb not null,                  -- {"op":">=","price":30} | {"phrase":"buyback"} | {}
  channels      text[] not null default '{push}',-- 'push','email','whatsapp' (whatsapp = premium; infra deferred)
  state         text not null default 'armed' check (state in ('armed','triggered','paused')),
  last_fired_at timestamptz,
  created_at    timestamptz not null default now()
);
create index alerts_user_idx on public.alerts (user_id) where state <> 'paused';
create index alerts_type_idx on public.alerts (alert_type) where state = 'armed';

create table public.alert_triggers (             -- 5a live trigger log
  id bigint generated always as identity primary key,
  alert_id uuid not null references public.alerts(id) on delete cascade,
  fired_at timestamptz not null default now(),
  context jsonb not null,                        -- value at fire, enrichment refs
  suppressed_by_quiet_hours boolean not null default false,
  delivered_channels text[]
);
create index alert_triggers_alert_idx on public.alert_triggers (alert_id, fired_at desc);
```

**DEFAULTED — owner may override** (open question 7, quota taxonomy): three buckets only.
`phrase` → phrase alerts (free 2 / premium 50); `screen` → screen-match (2 / 75); everything
else — price, score, filing, ratio, ex-date, index drawdown, transcript, IPO, holder, series —
consumes the `stock` bucket (10 / 800). `quota_bucket` is set by the create-function from
`alert_type`, stored so quota queries are one indexed count.

```sql
create table public.notes (                      -- Notebook (20a)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  security_id bigint references public.securities(id),
  title text, body text not null,
  pinned boolean not null default false,
  clip_source_url text,
  clip_price_snapshot jsonb,                     -- {"last":27.15,"as_of":"2026-07-12T09:41+04"} captured at clip time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_user_idx on public.notes (user_id, updated_at desc);

create table public.saved_screens (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,   -- null for desk/curated screens
  owner_analyst_id uuid references public.analysts(principal_id),
  name text not null,
  criteria jsonb not null,                       -- AST: [{"field":"pb","op":"<","value":1.0}, ...] AND-chain
  visibility text not null default 'private' check (visibility in ('private','community','analyst','curated')),
  forked_from uuid references public.saved_screens(id),
  follower_count int not null default 0, fork_count int not null default 0,
  match_count int, last_run_at timestamptz,
  backtest jsonb,                                -- {"period":"3Y","vs":"TASI","return":0.41,"hit_rate":0.73}
  created_at timestamptz not null default now()
);
create index screens_visibility_idx on public.saved_screens (visibility) where visibility <> 'private';

create table public.screen_runs (                -- nightly re-run + membership diff (match alerts)
  id bigint generated always as identity primary key,
  screen_id uuid not null references public.saved_screens(id) on delete cascade,
  run_at timestamptz not null default now(),
  match_count int not null,
  entered bigint[] not null default '{}',        -- security_ids entering the screen
  exited  bigint[] not null default '{}'
);
-- Retention: 90 days.

create table public.ai_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope jsonb not null,                          -- {"kind":"all_gcc"} | {"kind":"watchlist","id":...} | {"kind":"security","id":...}
  mode text not null default 'general' check (mode in ('general','deep')),
  title text,
  created_at timestamptz not null default now()
);
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','refusal')),
  body jsonb not null,                           -- prose + generated tables
  citations jsonb,                               -- [{"object_id":..., "doc":"FY25 AR","page":41,"quote":"..."}]
  credits_charged int not null default 0,
  model_used text,                               -- provider-agnostic gateway stamps actual model id
  grounding_cutoff timestamptz,
  feedback text check (feedback in ('helpful','flagged')),
  created_at timestamptz not null default now()
);

create table public.ai_theses (                  -- standing per-company thesis (10d)
  security_id bigint primary key references public.securities(id),
  headline text, bull jsonb, bear jsonb,
  fair_value_band jsonb,                         -- {"scenarios":[{"name":"low_oil","fv":23.50},...],"last":27.15}
  catalysts jsonb, invalidation jsonb,
  generated_at timestamptz not null, model_used text,
  regen_trigger text,                            -- 'material_filing' | 'on_demand'
  citations jsonb not null
);

create table public.follows (                    -- analysts, screens, venues, holders
  user_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('analyst','screen','venue','holder','security')),
  target_ref text not null,                      -- uuid/bigint/code as text; validated by trigger per kind
  created_at timestamptz not null default now(),
  primary key (user_id, target_kind, target_ref)
);
```

AI answer content (RAG chunks, embeddings) belongs to the AI domain document; if pgvector is
adopted the embedding tables live in a `vectors` schema in this same database (pgvector is free
on Supabase) — noted here only so no one budgets a vector DB.

---

## 15. Ads

```sql
create table ops.ad_slots (
  key text primary key,                          -- 6 fixed named slots
  placement text not null,
  frequency_rule text,                           -- '3/reader/day' rendered from config
  audience text not null default 'free',         -- premium never sees ads
  status text not null default 'house' check (status in ('sold','booked','house'))
);

create table ops.ad_campaigns (
  id bigint generated always as identity primary key,
  sponsor text not null,
  flight_start date not null, flight_end date not null,
  value_sar numeric(14,2),
  status text not null default 'draft' check (status in ('draft','in_review','approved','live','ended')),
  approved_by uuid references iam.principals(id),
  conflict_tickers bigint[] not null default '{}',   -- broker market-making conflicts: never render on these
  created_at timestamptz not null default now()
);

create table ops.ad_creatives (
  id bigint generated always as identity primary key,
  campaign_id bigint not null references ops.ad_campaigns(id) on delete cascade,
  slot_key text not null references ops.ad_slots(key),
  asset_path text not null, headline text, body text,
  r05_checked_at timestamptz,                    -- creatives pass the banned-phrase rule too
  status text not null default 'in_review' check (status in ('in_review','approved','rejected'))
);
```

Adjacency bans (never beside halts/retractions/death wires/Takes) and the 3-impressions/day cap
are enforced in the ad-serving route handler (context is known at render time); impressions are
`analytics.events` rows (`event_type = 'ad_impression'`), so pacing on 32a is a rollup query,
not a table. Revenue-mix ≤15% is a Desk dashboard check against `billing.invoices` — policy,
not schema.

---

## 16. Comms: notification outbox, email, suppression

One outbox pattern for every channel. Nothing sends synchronously; everything is a row first
(auditability, quiet hours, throttles, retries), drained by a pg_cron-triggered edge function.

```sql
create table comms.notifications (               -- the outbox AND the user-visible inbox mirror (16b/15g)
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null,                   -- 'price_alert','earnings','phrase_match','wire_brief','security',...
  title         text not null,
  body          text,
  deep_link     text,
  channel       text not null check (channel in ('push','email','whatsapp','inapp')),
  priority      text not null default 'normal' check (priority in ('critical','normal','digest')),
                                                  -- critical (halts) bypasses quiet hours
  status        text not null default 'queued' check
                (status in ('queued','held_quiet_hours','sent','failed','suppressed','skipped_cap')),
  scheduled_for timestamptz not null default now(),
  sent_at       timestamptz,
  read_at       timestamptz,                     -- inbox read-state
  alert_id      uuid references public.alerts(id),
  dedupe_key    text,
  created_at    timestamptz not null default now()
);
create index notif_queue_idx on comms.notifications (scheduled_for) where status in ('queued','held_quiet_hours');
create index notif_inbox_idx on comms.notifications (user_id, created_at desc);
create unique index notif_dedupe on comms.notifications (dedupe_key) where dedupe_key is not null;
-- Retention: 12 months.

create table comms.email_templates (
  key text primary key,                          -- 'wire_brief_am','price_alert','receipt','otp','dunning_1',...
  sender_identity text not null,                 -- 'brief@','alerts@','billing@','security@','accounts@'
  subject_tpl text not null,
  mjml_path text not null,                       -- template source lives in repo: src/emails/
  trigger_kind text not null check (trigger_kind in ('scheduled','event','lifecycle'))
);

create table comms.email_sends (                 -- per-batch stats for the 33c send queue / deliverability
  id bigint generated always as identity primary key,
  template_key text not null references comms.email_templates(key),
  batch_date date not null,
  recipients int not null default 0, delivered int, opened int, bounced int,
  status text not null default 'assembling' check (status in ('assembling','scheduled','sending','sent')),
  created_at timestamptz not null default now()
);

create table comms.suppression_list (
  email text primary key,
  reason text not null check (reason in ('bounce','complaint','manual','unsubscribed')),
  added_at timestamptz not null default now()
);

create table comms.push_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('webpush','fcm','apns')),
  token text not null unique,
  last_seen_at timestamptz not null default now()
);
```

Dispatcher rules implemented in the drain function (`supabase/functions/notify-drain`, invoked
every minute by pg_cron via `net.http_post`): quiet hours 22:00–07:00 GST hold `normal`/`digest`
rows (`status='held_quiet_hours'`, released 07:00); `critical` (halt alerts) always pass; max
4 push/reader/day counted against today's `sent` push rows; suppression list checked on every
email row. WhatsApp channel: **deferred** — the enum value exists, rows would queue, no sender
is built (design open question 14; requires WhatsApp Business API contract).

Email provider: Resend free tier (3 K emails/mo) for transactional in v1; Wire Brief at 42 K
recipients is a scale problem for a later phase — the schema (batched `email_sends`) does not
change, only the drain function's provider call. **DEFAULTED** and called out as a cost gate:
at real newsletter volume budget ~USD 20–90/mo (Resend/SES tiers; SES ≈ USD 0.10/1000 = ~USD
130/mo at 42 K daily — SES is the cheap path when that day comes).

---

## 17. Analytics events (partitioned)

```sql
create table analytics.events (
  id          bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  event_type  text not null,                     -- 'page_view','click','share','save','watchlist_add','alert_create',
                                                 -- 'ai_answer','screener_run','paywall_hit','trial_start','ad_impression'
  user_id     uuid,                              -- null for anonymous
  anon_id     text,                              -- first-party cookie id
  session_id  text,
  content_id  uuid,
  security_id bigint,
  props       jsonb not null default '{}',       -- channel, geo, platform, tier, referrer
  primary key (occurred_at, id)
) partition by range (occurred_at);
-- Monthly partitions analytics.events_y2026m07 …
create index events_type_time on analytics.events (event_type, occurred_at desc);
create index events_content   on analytics.events (content_id, occurred_at desc) where content_id is not null;
```

Ingest path: a single `public.track(p_events jsonb)` SECURITY DEFINER RPC that validates event
types and inserts batched arrays (the client buffers and flushes every 5 s / 20 events). No
third-party analytics vendor: 26a/26b are queries over this table plus two rollups
(`analytics.daily_content_stats`, `analytics.daily_kpis`) refreshed hourly. Live tails
("on-site now") use Supabase Realtime presence, not the events table.

Retention: raw partitions 13 months (year-over-year comparisons), then dropped; rollups kept
forever (tiny). Volume guardrail: at 100 K events/day (≈ current design-fixture traffic),
~110 bytes/row ⇒ ~340 MB/year of raw partitions. At 1 M events/day this becomes the largest
table in the database and the first thing to move to sampling — flagged as an explicit scale
gate, not built for now.

---

## 18. Audit log (append-only, 7-year)

```sql
create table ops.audit_log (
  id          bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  actor_id    uuid not null references iam.principals(id),   -- human, agent, or SYSTEM — identical rows (31b)
  category    text not null check (category in
              ('QUEUE','CONTENT','PUBLISH','LAKE','NAV','BILLING','IAM','RULES','ADS','DATA_OPS','SUPPORT')),
  action      text not null,                     -- 'approve_publish','confirm_dividend','rotate_key','freeze_all',...
  object_ref  text,                              -- 'content:uuid','lake:uuid','invoice:MP-2026-08114'
  before_value jsonb,                            -- REQUIRED on overrides (agent value being replaced)
  detail      jsonb not null default '{}',
  primary key (occurred_at, id)
) partition by range (occurred_at);
-- Yearly partitions (7-day volume in the fixture is 48 K rows ⇒ ~2.5 M rows/yr ≈ 300 MB/yr worst case;
-- yearly partitions × 7-year retention; drop y2026 partition in 2034).
create index audit_actor_idx on ops.audit_log (actor_id, occurred_at desc);
create index audit_category_idx on ops.audit_log (category, occurred_at desc);
```

Append-only enforcement: `revoke update, delete on ops.audit_log from public, service_role;` is
not possible for the superuser-adjacent service role, so a `prevent_mutation()` trigger raises
on UPDATE/DELETE unconditionally; partition drops (retention) are performed by the maintenance
function which detaches rather than deletes row-wise. Writes go through one function,
`ops.audit(p_actor, p_category, p_action, p_object, p_before, p_detail)`, called from server
code and from the state-transition triggers (lake verification, content publish, dividend
confirm, nav deploy, kill switches) so the trail cannot be forgotten by an application bug.

PDPL note (corrected post-review so the purge actually executes): the 30-day job DELETEs the
`auth.users` row. FKs are shaped so this succeeds: user-owned engagement tables cascade;
`iam.principals.auth_user_id` and `billing.subscriptions.user_id` are `ON DELETE SET NULL`
(the purge trigger stamps `principals.purged_at` and overwrites `display_name` to
`'deleted-user'`); `billing.invoices.user_id` is deliberately not an FK and survives (ZATCA
10-year retention, buyer fields already denormalized). Audit rows keep the pseudonymous
principal id, and billing-category audit payloads are pseudonymized **at write time** (member
id + changed field names, never raw PII values) so the append-only hash chain never has to be
broken to satisfy a deletion request.

---

## 19. RLS strategy (consolidated)

Every table in `public` has RLS enabled, no exceptions. Private schemas (`lake`, `ops`, `iam`,
`billing`, `comms`, `analytics`) are not in PostgREST's exposed schema list *and* have RLS
enabled with no policies as belt-and-braces — even a misconfigured exposure returns zero rows
to non-service roles.

**Tier resolution.** A Supabase **custom access token hook** stamps `plan_tier`
(`'free' | 'premium' | 'enterprise'`) into the JWT from `billing.subscriptions` at token mint.
RLS reads it via a tiny helper:

```sql
create function public.jwt_tier() returns text language sql stable
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'plan_tier', 'free') $$;
```

Claim staleness is bounded by access-token life (1 h) and we force-refresh the session in the
post-checkout return page and on dunning pause, so upgrades feel instant and downgrades lag at
most an hour — acceptable, cheap (no per-row subquery into billing).

Policy families:

1. **World-readable reference & delayed market data** (`venues`, `sectors`, `securities`,
   `indices`, `index_levels*`, `quotes_latest`, `quotes_intraday`, `ohlcv_daily`, `fx_rates`,
   `market_sessions`, `market_holidays`, `venue_feed_status`, `security_status`, `filings`,
   `transcripts(+segments)`, `earnings_events`, `estimates`, `dividends` (state='live' only),
   `ipo_offers`, `datapoint_series`(is_public)/`datapoints`, `holders`, `holder_positions`,
   `ownership_snapshots`, `analysts`, `analyst_calls`, `nav_config_live` view):
   `using (true)` for `select` to `anon, authenticated`; all writes service-role only (no
   insert/update/delete policies exist at all). Delayed-only exposure is inherent — the tables
   *contain* only delayed scraped data; there is no realtime tier to leak.
2. **Published content**: `content_items` selectable when `status in ('live','updated','retracted')`
   (retracted stays reachable per R-08); `content_blocks` selectable when parent is published
   AND (`not gated` OR `public.jwt_tier() <> 'free'`). This is the server-side article cut.
   Drafts and pipeline states are invisible to PostgREST entirely (no policy matches).
3. **Premium-only surfaces**: `scores`, `score_history`, `score_events`, `marsad_select`,
   `ai_theses`: `select using (public.jwt_tier() in ('premium','enterprise'))`. The free tier's
   "3 scores/month" peek is served by a route handler using the service role after
   `billing.consume_meter()` succeeds — deliberately *not* expressible in RLS, so the meter
   lives in exactly one place.
4. **User-owned**: `user_profiles`, `watchlists(+members via join policy)`, `alerts`,
   `alert_triggers` (via alert join), `notes`, `saved_screens` (owner OR
   `visibility <> 'private'`), `screen_runs` (via screen), `ai_threads`, `ai_messages` (via
   thread), `follows`: `using (user_id = auth.uid())`, `with check` the same. Inserts that
   consume quota (`alerts`, `saved_screens`, watchlist names) are *revoked* from the
   `authenticated` role and go through SECURITY DEFINER functions (`public.create_alert(...)`,
   `public.create_saved_screen(...)`) that check plan limits atomically — RLS protects reads,
   functions protect quotas.
5. **Nobody-but-server**: everything else. Notably `comms.notifications` gets a `public`
   read-only *view* (`public.my_notifications`) filtered to `auth.uid()` for the inbox panel,
   rather than exposing the outbox table.

Entitlement enforcement points that are **not** RLS (server route handlers with service role,
because they need counting/truncation/config): free-read meter on articles; screener result
truncation to 3 rows + blurred count for free tier (query runs fully, response truncated
server-side; criteria never leave the server unfiltered); AI credit spend; alert/screen/
watchlist quotas; signed URLs for members-only attachments and invoice PDFs; ad frequency caps.

Supabase Realtime (post-review): **no publication on `public.quotes_latest`** — data is
15-min delayed by locked decision, so pushing 812 rows × ~20 updates/day to every heatmap and
watchlist subscriber buys zero freshness while burning Pro's 5M-message/500-connection
allowances; readers poll/ISR at the scrape cadence (04 §4). Realtime is retained only for the
Desk `agent-run-log` broadcast channel (tiny fan-out). `venue_feed_status`/`security_status`
propagate through the same polled pulse payloads.

---

## 20. Partitioning & retention summary

| Table | Partitioning | Retention (raw) | Steady-state size |
|---|---|---|---|
| `lake.snapshots` (metadata) | none (bigint PK, lean rows) | metadata forever; blobs: quotes 90 d (any content type), generic HTML/JSON 1 y, filings/prospectus/transcripts/financials forever | ~150 MB/yr rows; blobs in Storage |
| `public.quotes_intraday` | monthly range | 3 months, then dropped (OHLCV daily is durable) | ≤ 120 MB |
| `public.index_levels` | none | 90-day delete job | < 10 MB |
| `analytics.events` | monthly range | 13 months; rollups forever | ~340 MB/yr at 100 K ev/day |
| `ops.audit_log` | yearly range | 7 years (detach+archive to Storage as CSV.gz, then drop) | ~300 MB/yr ceiling |
| `ops.agent_runs` | none | 90 days | < 50 MB |
| `public.screen_runs` | none | 90 days | < 20 MB |
| `comms.notifications` | none | 12 months | ~100 MB/yr |
| `lake.objects` | none initially | forever (the product) | ~1 KB/object ⇒ 1 GB at 1 M objects |
| `billing.invoices` | none | 10 years minimum (ZATCA) | trivial |

Partition maintenance: `pg_partman` if the plan's image has it (`create extension pg_partman`),
else a 30-line `ops.ensure_partitions()` function creating next-month partitions, run weekly by
pg_cron (`0 1 * * 0`). Retention job `ops.apply_retention()` runs daily (`30 1 * * *`) and only
detaches/drops whole partitions or runs indexed deletes on the small tables — plus the
snapshot-blob purge (§3), which nulls blob pointers and enqueues freed `lake-raw` paths into
`ops.storage_purge_queue` for Storage-API deletion by a worker.

`lake.objects` partitioning is deliberately deferred: the 4.2 M-object figure in the designs is
the mature-product fixture; year-one reality is a few hundred thousand rows. Partitioning by
`object_type` later is a metadata-only migration if needed. **Deliberately deferred.**

---

## 21. Scheduled jobs (pg_cron, all times UTC; GST = UTC+4)

pg_cron runs SQL directly for set-based work and calls edge functions via `pg_net` for anything
needing HTTP/LLM/scraping. Scrapers themselves are the agent runtime's concern (owner-Mac
agents / edge functions — see the agents architecture doc); the DB-side schedule:

| # | Cron (UTC) | Job | Mechanism |
|---|---|---|---|
| 1 | `0 0 * * *` | 04:00 GST Marsad Score batch: recompute 812 scores → `scores`, `score_history`, `score_events`, COMPUTED.SCORE lake objects | edge fn `score-batch` |
| 2 | `30 3 * * *` | 07:30 GST Wire Brief AM assemble+send (33c AM 06:00 assembly step at `0 2 * * *`) — **DEFAULTED**: assemble 06:00, send 07:30, resolving open question 5 as "assembly vs send times" | edge fn `wire-brief` |
| 3 | `30 12 * * 0-4` | 16:30 GST Wire Brief PM (trading days Sun–Thu) | edge fn `wire-brief` |
| 4 | `0 8 * * *` | 12:00 GST dunning retry batch (SYSTEM actor; writes `payment_attempts`, audit rows) | edge fn `dunning` |
| 5 | `5 20 * * *` | 00:05 GST guard job: if Gulf date = 1st → meter resets, credit grants + rollover expiry rows, Marsad Select rebalance reminder task | SQL fn `billing.monthly_reset()` |
| 6 | `0 22 * * *` | 02:00 GST nightly: `key_ratios` recompute, saved-screen re-runs + membership diffs → match alerts, screen catalog counts, estimate revision aggregation, dividend-vs-registrar verification queue, datapoint staleness scan (>30 d), rating review-due flags (90 d), analyst leaderboard MV refresh | SQL + edge fn `nightly` |
| 7 | `2 2 * * *` | 06:02 GST front-page AM auto-flow refresh (SYSTEM actor version row) | SQL fn |
| 8 | `0 2 * * *` | 06:00 GST daily: ex-date reminders (ex_date = Gulf today + 2 → outbox), trial T-3 emails, evergreen quarterly review flags, IPO milestone comms due today | SQL fn |
| 9 | `* * * * *` | outbox drain: release quiet-hours holds at 07:00 GST, dispatch queued notifications (batches of 500) | pg_net → edge fn `notify-drain` |
| 10 | `15 * * * *` | hourly analytics rollups (`daily_content_stats`, `daily_kpis` upserts) | SQL fn |
| 11 | `*/15 1-11 * * 0-4` | during-session housekeeping: refresh `mv_sector_heatmap`, `mv_movers`; venue feed-status staleness sweep (mark `reconnecting/offline` when `last_sync_at` ages) | SQL fn |
| 12 | `0 1 * * 0` | partition pre-create (`ensure_partitions`) | SQL fn |
| 13 | `30 1 * * *` | retention (`apply_retention`), snapshot blob purge | SQL fn |
| 14 | `0 21 * * *` | 01:00 GST PDPL purge: delete `auth.users` rows whose deletion grace expired (cascades everywhere except invoices/audit) | SQL fn |

Event-driven (not cron): score recompute on earnings verdict (trigger on `earnings_events`
verdict set → enqueue), first-score job scheduled per listing (`securities.score_eligible_from`
checked inside job 1), concall reminders (rows in `comms.notifications.scheduled_for`),
scheduled publishes (`content_items.scheduled_at` swept by job 9's drain), filings parse SLA
(T+9 min) measured as `parse_runs.started_at - filings.filed_at` on the ops dashboard.

---

## 22. Migration plan

Migrations in `supabase/migrations/`, timestamp-prefixed, applied in order by `supabase db push`
(local) and CI (GitHub → Supabase branch → merge). Sequencing is dependency-driven:

1. `0001_extensions.sql` — pgcrypto, pg_trgm, unaccent, pg_cron, pg_net (+pg_partman if avail);
   create schemas `iam, lake, ops, billing, comms, analytics`; shared helpers
   (`set_updated_at()`, `prevent_mutation()`, `public.jwt_tier()`).
2. `0002_iam.sql` — principals, roles, role_grants, agent_accounts, global_switches,
   capability_grants; signup trigger; seed SYSTEM + 12 agents + role matrix.
3. `0003_market_reference.sql` — venues, sectors, securities, indices, index_sector_weights,
   fx_rates, market_sessions, market_holidays; seed 6 venues (+BK inactive), 11 sectors,
   2026–2027 holiday calendar (Hijri rows unconfirmed).
4. `0004_lake.sql` — snapshots, parse_runs, parse_run_snapshots, objects, revisions, conflicts,
   verified_objects view; state-machine + immutability triggers; Storage bucket `lake-raw`.
5. `0005_prices.sql` — quotes_latest, quotes_intraday (+first 3 partitions), ohlcv_daily,
   index_levels(+daily), venue_feed_status, security_status, heatmap/movers MVs.
6. `0006_fundamentals.sql` — financial_statements, key_ratios, filings, transcripts(+segments),
   earnings_events, estimates, dividends, ipo_offers(+timeline, debuts), holders(+positions),
   ownership_snapshots; buckets `filings`, `transcripts`.
7. `0007_datapoints_scores.sql` — datapoint_series, datapoints, scores, score_history,
   score_events, marsad_select; lake→datapoint fan-out trigger.
8. `0008_content.sql` — content_items, content_tickers, content_blocks, corrections, revisions,
   attachments, templates, story_blocks (seed TPL/BLK registries), front_page_versions,
   nav_versions (+live views), analysts, analyst_calls (+immutability trigger), applications.
9. `0009_rules_pipeline.sql` — rulesets, rules, banned_phrases, rule_violations (seed V9),
   agent_runs, pipeline_items, agent_errors, correction_flags, R-07 trigger.
10. `0010_billing.sql` — plan_versions (seed 33c config as V1), subscriptions, invoices,
    payment_attempts, promo_codes, usage_meters, credit_ledger, consume_meter/spend_credits;
    bucket `invoices`.
11. `0011_engagement.sql` — watchlists(+members), alerts(+triggers), notes, saved_screens
    (+runs), ai_threads(+messages), ai_theses, follows; create_alert/create_saved_screen fns.
12. `0012_ads_comms.sql` — ad_slots (seed 6), ad_campaigns, ad_creatives; notifications,
    email_templates (seed), email_sends, suppression_list, push_devices.
13. `0013_analytics_audit.sql` — analytics.events (+partitions), rollup tables, `track()` RPC;
    ops.audit_log (+partition), `ops.audit()` fn, mutation-prevention triggers.
14. `0014_rls.sql` — every policy, role revokes, realtime publications. RLS last so earlier
    seed steps run clean; the database is not exposed to traffic until 0014 is applied
    (enforced by doing initial deploy as one push).
15. `0015_cron.sql` — all `cron.schedule(...)` calls from section 21.
16. `0016_seed_dev.sql` — dev/staging only: the SUN 12 JUL 2026 09:41 GST design fixture
    (stc DPS 0.50→0.55 chain, MSX incident) as integration-test data. Never applied to prod.

Ordering rule for the future: additive migrations only; renames/drops go through a
create-backfill-swap sequence; every migration reversible or explicitly marked not.

Forward references note (documentation vs. migration order): DDL in this document sometimes
shows an FK to a table defined in a later section (e.g. `lake.snapshots.venue_code →
public.venues`); the migration sequence above is the authoritative creation order, and the
FKs that genuinely cross migrations (snapshots→venues and objects→securities, both resolvable
inside `0004` since `0003` precedes it; `ops.rule_violations.ad_creative_id → ops.ad_creatives`,
added as `alter table … add constraint` in `0012` after ads tables exist) are wired with
explicit `alter table` statements rather than inline column FKs.

---

## 23. Storage estimates & Supabase tier implications

Year-one realistic volumes (6 venues, ~900 securities incl. inactive, modest traffic):

| Component | Estimate basis | Year-1 size |
|---|---|---|
| Reference + fundamentals + content + engagement | hundreds of K rows total | < 300 MB |
| `filings.full_text` + facts | 25 K filings × ~17 KB avg | ~450 MB |
| `quotes_intraday` (3-mo window) + `quotes_latest` | 350 K rows/mo window | ~120 MB |
| `ohlcv_daily` incl. 10-y backfill | ~2.2 M rows | ~280 MB |
| `lake.objects` + revisions + citations + parse_runs | ~500 K objects yr-1 | ~600 MB |
| `lake.snapshots` metadata | ~1 M rows/yr | ~150 MB |
| `analytics.events` (13-mo window) | 100 K ev/day | ~400 MB |
| `ops.audit_log` | 2.5 M rows/yr | ~300 MB |
| transcripts + segments | ~600 calls/yr | ~100 MB |
| **Postgres total, end of year 1** | | **~2.5–3 GB** |
| Storage: filing PDFs | 25 K × 400 KB | ~10 GB/yr |
| Storage: raw HTML/JSON blobs (post-purge window) | | ~3–5 GB steady |
| Storage: transcript audio | 600 × 25 MB | ~15 GB/yr (first candidate to re-fetch-not-store) |
| **Supabase Storage total, end of year 1** | | **~25–30 GB** |

**Tier implications.** These numbers do not fit the current ~USD 10/mo footing once real
ingestion starts: the Free/legacy tier caps (500 MB DB, 1–5 GB storage) are exceeded within the
first weeks of scraping filings. The correct home is **Supabase Pro at USD 25/mo** (8 GB
database, 100 GB storage, 250 GB egress, Micro compute, pg_cron/pg_net included, daily backups)
— year one fits inside Pro with ~3× headroom on DB and ~3× on Storage, with no compute add-on
needed at this traffic (Micro handles the write rates above trivially; the heaviest query, the
screener over 812 `key_ratios` rows, is microseconds). Postgres growth beyond 8 GB is
USD 0.125/GB/mo — at our retention policy that is years away.

**Monthly infra estimate (this domain, corrected post-review):** Supabase Pro USD 25 +
Storage overage USD 0 (yr 1) + **Vercel Pro USD 20 from paid launch** (Hobby prohibits
commercial use — a paid-subscription product cannot legally sit on Hobby, so Pro is baseline,
not contingency) + transactional email via SES ~USD 1–5 (platform-standard sender per 06;
Resend's 3K/mo free tier is exhausted by transactional volume alone at ~1–2K active users)
→ **~USD 50–55/mo** at launch for this domain's share, before LLM inference (separate domain)
and before Wire-Brief-at-scale email (~USD 130/mo at 42 K daily sends — revenue-scale problem,
gated accordingly). The platform-wide table lives in 06 §7.2 (single source of truth).

Cost levers deliberately built in: quote snapshots inline+90-day purge (biggest blob stream
never touches Storage); 3-month intraday quote retention; 13-month analytics retention;
transcript audio marked re-fetchable; no vector DB, no search cluster, no queue broker, no
graph DB, no second Postgres.

---

## 24. Deferred items & defaults ledger

Explicitly **deferred** (not built, schema leaves a clean attach point):

1. Arabic columns/UI — four `-- AR-LATER` attach points marked (securities, nav, lexicon,
   filings PDFs).
2. Kuwait (BK) ingestion — venue row seeded inactive; no agent, no securities.
3. WhatsApp delivery — channel enum value reserved; no sender infra.
4. Consensus-estimates vendor — `estimates` is source-agnostic; rows sparse until sourcing
   decided (open question 10).
5. Enterprise/Terminal API keys & rate limiting — not in v1 schema.
6. `lake.objects` partitioning — metadata-only migration when volume demands.
7. Newsletter-scale email provider — schema ready, provider swap in drain function.
8. Community-screen moderation queue (open question 15) — `saved_screens.visibility` supports
   it; queue table added when community publishing opens.
9. Analyst revenue-share mechanics (open question 13) — single reserved column, no payout
   tables.
10. Dedicated search infrastructure — Postgres FTS + pg_trgm serve federated search at v1
    scale; revisit only if p95 latency demands it.

**DEFAULTED — owner may override** (pragmatic choices where the designs were ambiguous):

| # | Question | Default taken |
|---|---|---|
| D1 | Free-meter definitions (OQ 1) | 33c admin config is source of truth (2 premium reads / 3 scores / 5 AI answers / 20 credits); marketing copy reads from `billing.plan_versions` |
| D2 | Auto-publish boundary (OQ 9) | ≤ 40 words auto-publishes; TPL-01 serves ≤ 90-word wires with approval |
| D3 | Alert quota taxonomy (OQ 7) | 3 buckets: phrase / screen / everything-else→stock |
| D4 | Rating vocabulary (OQ 8) | Platform 5-notch; STRONG_BUY human-analyst-only |
| D5 | Wire Brief times (OQ 5) | 06:00 GST assembly, 07:30 GST send; PM 16:30 |
| D6 | Venue scope (OQ 6) | 6 active venues; BK read-only placeholder |
| D7 | Graph store | Relational edges + recursive CTEs; no graph DB |
| D8 | Blob placement | Storage for >32 KB, inline gzip below; 90-day quote-blob purge |
| D9 | Tier claim in JWT | Custom access token hook; ≤1 h staleness accepted |
| D10 | Reviewer role (OQ 16) | One role matrix; `reviewer` is a role key, conditions as config |

---

---

## Revisions (post-review)

All five blocking issues confirmed and fixed in place; the material improvements are adopted
below. **This document remains the source of truth for all table names and DDL** — 03/04/05
have been revised to reference these names.

**Blocking fixes applied above:**

1. **PDPL purge now executes** (§2, §13, §18): `iam.principals.auth_user_id` → `ON DELETE SET
   NULL` + `purged_at` + relaxed `human_has_auth` CHECK; `billing.subscriptions.user_id`
   nullable `ON DELETE SET NULL`; §18 rewritten — the 30-day deletion job (§21 job 14) can now
   run without FK violations, and billing audit payloads are pseudonymized at write time so the
   audit hash chain never conflicts with a deletion request.
2. **Snapshot purge no longer violates its own CHECK** (§3): `purged_at` is a real column and
   `blob_somewhere` accepts the purged state.
3. **R-07 fan-out covers 'updated' and pending pieces** (§5): the flag join now matches
   `status in ('live','updated')` plus pending pipeline content citing or block-binding the
   corrected object — second corrections and pre-publish BLK bindings are no longer skipped.
4. **One live revision per natural key is now a partial UNIQUE index** (§4) with
   supersede-then-insert in one transaction — concurrent parse runs cannot leave duplicate
   VERIFIED rows, so `verified_objects`, the datapoint fan-out, and R-04 stay unambiguous.
5. **Vercel Pro is baseline** (§23): Hobby's no-commercial-use term makes $0 Vercel illegal for
   a paid product; the floor is stated honestly (~$50–55/mo this domain's share; platform table
   in 06 §7.2).

**Improvements adopted:**

- **Realtime removed from `quotes_latest`** (§19) — polling/ISR matches the delayed-data
  contract at zero marginal cost; Realtime kept only for the Desk run-log broadcast.
- **Missing entities added to the schema plan** (land with their consuming phase, DDL follows
  the conventions here): `ops.incident_banners` (33a composer — DDL as drafted in 05 §9.3,
  renamed into `ops`), `public.company_people` (3d board & management: security_id, name, role,
  is_independent, seat_count context), `billing.support_log` + `billing.member_notes` +
  `billing.churn_scores` (30b member detail), `public.coverage_requests` (17c/m4b zero-result
  intake), `ops.agent_daily_stats` (agent_runs 90-day rollup target), and
  `ops.venue_fallback_config` (33a backup-cadence knobs). None change existing DDL.
- **Score teaser on free surfaces** (§19 policy family 3): `score_events` becomes
  world-readable with `new_value` masked for non-premium via a view (`public.score_events_feed`
  exposing direction + magnitude bucket only), and the front-page score module is
  server-rendered through the metered route-handler path. Free surfaces (2b feed, 1f screener
  score-threshold filter, 1h chips) render; exact scores stay premium.
- **Metered premium reads are explicitly the service-role path** (§13/§19): RLS physically
  blocks gated `content_blocks` from free JWTs, so the "2 premium reads/mo" is served by the
  article route handler after `billing.consume_meter()` succeeds — same pattern as the scores
  peek. New table `billing.article_unlocks(user_id, content_id, period_month, unique)` makes a
  metered read idempotent per article per period (re-reading a metered article never burns a
  second unit — resolves the reader-domain double-count too).
- **Inline-snapshot threshold honesty** (§3/§23): whole-venue quote boards (~230 tickers)
  typically exceed 32 KB uncompressed; the inline lever applies to *compact per-venue JSON
  endpoints and small pages*, not full boards. Threshold compares **gzipped** size, and the
  cost claim is downgraded accordingly (Storage still absorbs the overflow at ~6× cheaper than
  DB).
- **Big jobs are chunked by construction** (§21): score-batch, wire-brief, and the nightly
  omnibus run as per-venue / per-batch pgmq messages consumed by the VPS worker (06 is the
  runtime authority — there are **no Edge Functions**; every "edge fn" in §21's mechanism
  column now reads "pgmq → VPS worker handler"). pg_cron only enqueues.
- **`public.track()` hardened**: not callable by `anon` at all — the analytics beacon is a
  Vercel route handler (`/api/e`, 05 §8.2) that validates, caps 50 events/8 KB per request,
  rate-limits per session/IP, strips IPs, and inserts via the service role. The SECURITY
  DEFINER RPC is dropped from the public surface.
- **pg_partman confirmed** (§1) — hedge removed, run_maintenance() scheduled via job 12.
- **Cross-reference fixed** (§1 → §20 for the partman fallback).
- **Human-staff assumptions ledger**: analyst-maintained datapoint series (24 h revision SLA,
  named maintainers), desk-reviewed transcripts, desk estimate rows, "closest of 14" house
  estimates, conflict resolution, correction-note drafting, and holiday-calendar seeding beyond
  2027 are **reassigned to agent principals with owner spot-checks** where the schema already
  permits (`maintainer_id`/`verified_by` reference principals of any kind); what genuinely
  needs human judgment (conflict overrides, price-sensitive confirms, Hijri confirms,
  correction-note approval) stays in the owner's approval surfaces. The platform inherits a
  six-human newsroom's *features* with a one-human *staffing model*, and says so.

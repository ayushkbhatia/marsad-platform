### PR.6 — Open the gate, narrowly _(expansion; supersedes the four-line sketch above)_

---

#### 1. What PR.6 is, and why it is worth doing now

PR.6 is **not a feature**. It is the operating procedure that takes `iam.global_switches.pipeline_intake_enabled` from `false` to `true` and back, with a proof of the stop before the start — plus the small, unglamorous body of code without which that procedure cannot be executed at all.

**The governing decision: the switch is not flipped by PR.6 as previously scoped.** Flipping today produces a **100% terminal-failure rate**. The gate admits `PENDING` objects (`20260727150000:52-54` sets `accepted_states='{VERIFIED,PENDING}'` for `FILING.FINANCIALS`) while `ingestion/src/rules/rules.ts:71` blocks any citation whose object is not `VERIFIED` *right now*, in mode `BLOCK`. `rules-stage.ts:51-63` routes a block back to draft; `MAX_RULES_LOOPS=2` (`rules-stage.ts:16`) exhausts; the piece lands at `reassigned_human` — a stage with **no UI anywhere under `src/`** (`grep -rn reassigned_human src/` → 0 hits). Three writer calls per piece, no screen, empty approval queue. This is not hypothetical: `BUILD-STATUS.md:463-467` records the live 2026-07-20 QNBK slice doing exactly this.

So PR.6 has three parts, and the first two are mandatory:

| | | gate on the next |
|---|---|---|
| **PR.6.0** | Prerequisites — the code and migrations that make a *successful* path physically possible | PR.6.1 may not start until all of PR.6.0 is merged and locally green |
| **PR.6.1** | The drills — prove the STOP works and prove the CONVEYOR works, **separately**, with the gate still shut | PR.6.2 may not start until all five drills pass with recorded numbers |
| **PR.6.2–6.6** | Pre-flight, flip, watch, roll back or widen | — |

**Why the drills are split.** The gate (a trigger on `lake.objects`) and the conveyor (five pgmq handlers) are independent systems joined by one `pgmq.send`. Test them together, see nothing, and you cannot tell whether the gate refused or the conveyor died. Drill 1 tests the gate inside a rolled-back transaction; Drill 3 tests the conveyor with a hand-enqueued message that bypasses the gate. Neither result is ambiguous.

**Why now, in one sentence:** every item in PR.6.0 is independent of PR.1–PR.4 and can be built in parallel with them, and without PR.6.0 the *first real composed piece PR.4 produces* dies invisibly at `reassigned_human` — so the cheapest moment to discover these three defects is before the writer exists, not after.

---

#### 2. The measured constraints this must live within

**Flow, not stock.** `ops.v_intake_readiness.eligible_objects` reports ~36,330 for `FILING.FINANCIALS`; its own comment (`20260727150000:213`) claims that is "what would flow" and is **wrong**. Both triggers are edge-triggered (`20260727150000:180-193`), and `scripts/researchers/lib/lake-objects.mjs:70-79` updates PENDING rows in place without touching `state`, so the UPDATE arm never fires for existing objects and nothing else enqueues classify. Real flow: 4,050 new objects / 7 days → 1,413 events / 7 days ≈ **202 events/day** across all venues, before any narrowing. Fix the comment and add a flow column before this view is shown to the owner, or the opening gets refused for the wrong reason.

**Exactly one object type can flow, already.** `lake.fn_intake_eligible_state` (`20260727150000:62-73`) falls back to `VERIFIED`-only for any type with no prefilter row, so `FINANCIALS.XCHECK` (41,621), `COMPUTED.RATIOS` (736) and `INDEX.LEVEL` (42) — all Lane-B PENDING — are refused at the trigger's `WHEN`. `QUOTE.LAST` / `OHLCV.CLOSE` / `COMPUTED.SCORE` / `PROFILE.SECURITY` are `not_material` (`20260720110829:54-59`). `FILING.REF` is `ambiguous` but carries `security_id` on **zero of 669 rows**, so the provenance floor (`20260727150000:150`) rejects 100% of it at $0. `DIVIDEND.EXDATE` / `DISCLOSURE.DPS` are `price_sensitive` and can never auto-VERIFY. **The "one object_type" half of PR.6's narrowing is true by construction and needs no work.** Report this to the owner as *narrower than feared*.

**The "one venue" half is not expressible.** `lake.fn_verified_enqueue` reads `new.venue_code` only to put it in the message body (`:166`). `ops.materiality_prefilter` has columns `id/object_type/verdict/priority/template_hint/note` (`20260720110829:35-43`) plus `accepted_states`. No venue, no recency, no rate. There is also **no recency filter anywhere**, and the dedup key is period-scoped (`20260727150000:113-123`) — so a 2019-Q3 statement written by a gapfill run is a fresh, admissible event. One venue gapfill (5y × 4q × 3 statement types × 100 companies ≈ 6,000 new keys) ≈ **2,000 drafts**. This is the largest real blast radius.

**Cost is not the constraint.** Classify is $0 for `FILING.FINANCIALS` (deterministic prefilter row, `20260720110829:51`). Draft ≈ $0.00103 (writer pinned to Qwen3-235B via `ingestion/src/llm/roles.ts`; ~5,000 tok in at $0.09/Mtok, ~1,000 out at $0.58/Mtok; context pack sliced at 12,000 chars, `draft.ts:83`). Edit ≈ $0.000014. Rules and fit are pure TypeScript. **Happy path $0.00105/piece; today's terminal-failure path $0.0031/piece; a full open day at 202 events $0.21–$0.63.** Against `ops.newsroom_budget_state`'s $60 soft / $120 hard caps (`20260720142331:182-195`) that is 10–32% of the soft cap — but the ladder sums **all** of `ops.llm_runs`, so a large PE extraction run and open intake degrade the writer chain together.

**The amplifier, not the model, is what makes a burst expensive.** `ops.newsroom_stalled_sweep` (`20260720142331:140-155`) re-enqueues **every** item at `draft|edit|rules` older than 20 minutes, **every 5 minutes**, with no marker and no dedup. `q_pipeline` is shared with `ops.enqueue_crosscheck_sweep` at up to 500 keys / 5 min (`20260715080537:42,104,124`) read at `pipelineReadQty=25` / `pipelineConcurrency=12` (`worker/src/config.ts:82,89`), so **backlog is the normal condition**. An item stuck 2 hours takes ~24 duplicate messages; `draft.ts:59` checks the stage before the LLM call but two concurrent lanes can both pass it. This is `DEF-QPIPELINE-CONCURRENCY-CONTRADICTION` (`BUILD-STATUS.md:610`), whose own row says *resolve before intake is switched on*.

**Nothing reaches a reader without a human act.** Four independent locks, traced: `classify.ts:91-108` inserts `content_items` at `status='draft'`; anon RLS admits only `status in ('live','updated','retracted')` (`20260713000014:107-109`) and every reader read uses `createAnonClient` trusting RLS (`newsroom.ts:307,342,364,384`); the only two agent writes of `live` (`rules-stage.ts:84`, `fit.ts:100`) are both behind `switchOn('auto_publish_wires')`, which is false; and even then `fn_enforce_agent_publish_gate` (`20260713000008:64-83`) additionally demands `TPL-01` + `word_count<=40` + a `PUBLISHING`-class agent. **Opening intake is a financial and operational risk, not an editorial one.** That is the one part of PR.6's original premise that fully holds.

**Two corrections to carry, because both are currently stated wrong:**

- **`fit-engine` does not refuse a template that names a legacy key.** `fit-engine.ts:333-343` pushes `FIT-TEMPLATE-LEGACY-KEY` into `warnings`, with the rationale at `fit.ts:13-25`. What *is* a refusal is a **block** carrying a legacy code (`fit-engine.ts:237-246`). So "all 8 templates would be refused at fit" is **not** the PR.0c blocker and must not be given to the owner as one — reseed `ops.templates` for its own reasons (`max_words`, `always_premium`, `block_keys` are real policy; the four longform templates were never seeded). The genuine fit blocker for an admitted piece is `FIT-BIND-UNRESOLVED` (`fit-engine.ts:385`) — the same PENDING contradiction as R-03.
- **PE.6 silently fixed a message-envelope bug.** The pre-PE.6 trigger sent `'stage','classify'` (`20260720110829:181-187`); `consumer.ts:254-259` resolves a handler from `message.handler` or `message.task` only, so every such message would have been archived as an unrecognized envelope (`consumer.ts:153-171`). PE.6 sends `'handler','pipeline_classify'` (`20260727150000:161-167`), matching `register.ts:21`. **The gate before 2026-07-27 could not have delivered one message even with the switch on.** Load-bearing, not cosmetic — record it so nobody "simplifies" it back.

---

#### 3. The design, concretely

##### 3.1 Thread the admitted-state set (the dominant blocker)

Per **cited object type**, not per trigger type — one sentence may cite `FILING.FINANCIALS` at `{VERIFIED,PENDING}` and `COMPUTED.RATIOS` at `{VERIFIED}`, and each must be judged by its own row.

```ts
// ingestion/src/rules/types.ts — CitationRow (currently :15-24)
export interface CitationRow {
  claim_key: string;
  lake_object_id: string;
  cited_value: unknown;
  cited_hash: string | null;
  object_state?: string | null;
  object_type?: string | null;        // NEW — resolved by the assembler
  accepted_states?: string[] | null;  // NEW — ops.materiality_prefilter.accepted_states for that type
  object_payload?: Record<string, unknown> | null;
  lineage_root_count?: number;
}
```

```ts
// ingestion/src/rules/rules.ts:71-73 — R-03
const admitted = cit.accepted_states?.length ? cit.accepted_states : ['VERIFIED'];
if (!admitted.includes(cit.object_state ?? '')) {
  violations.push({
    where: surf.where,
    kind: 'cited_object_state_not_admitted',
    legacy_kind: 'cited_object_not_verified',   // keeps the BUILD-STATUS:463-467 QNBK trace greppable
    key, state: cit.object_state ?? 'missing', admitted,
  });
}
```

```ts
// worker/src/handlers/newsroom/rules-stage.ts:106-115 — assembleContext
const cites = await sql`
  select c.claim_key, c.object_id::text as object_id, c.quoted_value, c.cited_by,
         o.state as object_state, o.object_type, o.payload as object_payload, o.parse_run_id,
         coalesce(mp.accepted_states, '{VERIFIED}') as accepted_states
    from lake.citations c
    join lake.objects o on o.id = c.object_id
    left join ops.materiality_prefilter mp on mp.object_type = o.object_type
   where c.content_id = ${contentId}::uuid`;
```

`FitCitation` (`fit-engine.ts:72-78`) gains the same field; `fit-engine.ts:385` becomes the identical predicate.

**Do not touch the auto-publish gate.** `distinct_lineage_roots >= 2` stays exactly as it is — that separation is the documented contract (`09-signal-to-article.md §3.2`) and conflating the two bars is what produced D-3's confusion.

##### 3.2 Narrowing, deferral and pace — one migration

`supabase/migrations/<ts>_pr6_intake_narrowing.sql`. All new columns default `null` = "no narrowing", so the migration is a **no-op until an operator sets a value**.

```sql
alter table ops.materiality_prefilter
  add column if not exists venue_codes  text[]   default null,
  add column if not exists security_ids bigint[] default null,
  add column if not exists recency_days int      default null,
  add column if not exists hourly_cap   int      default null;

-- Count ADMISSIONS, never claims. A parked event holds a dedup row but has not been admitted;
-- the drip stamps this on release, so the governor can see its own output.
alter table ops.intake_dedup add column if not exists admitted_at timestamptz;
create index if not exists intake_dedup_admitted on ops.intake_dedup (object_type, admitted_at desc);

create table if not exists ops.intake_deferred (
  id bigint generated always as identity primary key,
  dedup_key text not null, object_id uuid not null, object_type text not null,
  security_id bigint, venue_code text,
  queued_at timestamptz not null default now(),
  released_at timestamptz, dropped_at timestamptz, drop_reason text
);
create index if not exists intake_deferred_pending on ops.intake_deferred (queued_at)
  where released_at is null and dropped_at is null;
alter table ops.intake_deferred enable row level security;
-- policy worker_all + grants mirroring 20260727150000:99-105
```

Inside `lake.fn_verified_enqueue`, between the provenance floor (`:152`) and the dedup insert (`:155`):

```sql
  select * into mp from ops.materiality_prefilter where object_type = new.object_type;
  if mp.venue_codes  is not null and not (new.venue_code  = any (mp.venue_codes))  then return null; end if;
  if mp.security_ids is not null and not (new.security_id = any (mp.security_ids)) then return null; end if;
  if mp.recency_days is not null then
    v_asof := coalesce(new.effective_date, nullif(new.payload->>'period_end','')::date);
    if v_asof is null or v_asof < current_date - mp.recency_days then return null; end if;
  end if;
```

and, **after** the dedup insert succeeds (`:159`) so the event is claimed exactly once:

```sql
  if mp.hourly_cap is not null
     and (select count(*) from ops.intake_dedup d
           where d.object_type = new.object_type
             and d.admitted_at > now() - interval '1 hour') >= mp.hourly_cap then
    insert into ops.intake_deferred (dedup_key, object_id, object_type, security_id, venue_code)
    values (v_key, new.id, new.object_type, new.security_id, new.venue_code);
    return null;                                          -- DIVERTED, not dropped
  end if;

  perform pgmq.send('q_pipeline', jsonb_build_object(
    'handler','pipeline_classify','lake_object_id',new.id,'object_type',new.object_type,
    'security_id',new.security_id,'venue',new.venue_code));
  update ops.intake_dedup set admitted_at = now() where dedup_key = v_key;
```

⚠️ **The rate governor must count `admitted_at`, not `first_seen`.** Counting `first_seen` double-counts in both directions: a 20-event burst against `hourly_cap=6` parks 14 events that all hold `first_seen`-stamped dedup rows, so the drip computes `v_recent=20 >= 6` and releases **nothing** for an hour; then the rows age out, releases write no new dedup row, and the drip releases 1 per tick forever — **12/hour against a cap of 6**, breached by the component that enforces it.

**Why divert rather than drop.** The gate is edge-triggered and nothing re-enqueues. A dropped event is gone forever. Diverting buys four things for ~50 lines: no lost events; `ops.intake_deferred` **is** the burst gauge the operator watches; the release job **is** the replay path needed anyway for poisoned events; and it is a second kill point that does not touch the master switch.

```sql
create or replace function ops.newsroom_intake_drip(p_batch int default 1) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; r record; v_cap int; v_recent int;
begin
  -- the master switch stops the BACKLOG, not just the door
  if not coalesce((select value from iam.global_switches where key='pipeline_intake_enabled'), false)
    then return 0; end if;
  for r in select * from ops.intake_deferred
            where released_at is null and dropped_at is null
            order by queued_at limit p_batch for update skip locked
  loop
    select hourly_cap into v_cap from ops.materiality_prefilter where object_type = r.object_type;
    select count(*) into v_recent from ops.intake_dedup
      where object_type = r.object_type and admitted_at > now() - interval '1 hour';
    if v_cap is not null and v_recent >= v_cap then exit; end if;
    perform pgmq.send('q_pipeline', jsonb_build_object(
      'handler','pipeline_classify','lake_object_id',r.object_id,'object_type',r.object_type,
      'security_id',r.security_id,'venue',r.venue_code));
    update ops.intake_dedup set admitted_at = now() where dedup_key = r.dedup_key;
    update ops.intake_deferred set released_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
select cron.schedule('newsroom_intake_drip', '*/5 * * * *', $$select ops.newsroom_intake_drip(1)$$);
```

**Architecturally: the trigger decides ADMISSIBILITY, the drip decides PACE.** Keep them separate; no rate logic in the trigger beyond the divert branch.

##### 3.3 The dead-man's switch (there is no push alerting anywhere)

`worker/src/heartbeat.ts:3-9` states it plainly — a dead worker becomes an `ops.incidents` row *without any push-based alerting*, and the only incidents surface is the pull-based `/admin/ops` page. Every tripwire in §3.7 is a manual query. Combined with the pre-flight's insistence on an editor being present 07:00–22:00 Riyadh, the gate would otherwise sit open all night with nobody watching and the SLA clock paused (`20260720142331:126-127`). **Machine-executed tripwires are the difference between a runbook and a wish.**

```sql
create or replace function ops.newsroom_intake_autohalt() returns text
language plpgsql security definer set search_path = '' as $$
declare v_t0 timestamptz; v_why text := null; v_sys uuid; v_n int;
begin
  select changed_at into v_t0 from iam.global_switches where key='pipeline_intake_enabled' and value;
  if v_t0 is null then return 'closed'; end if;

  if (select coalesce(sum(cost_usd),0) from ops.llm_runs where created_at > v_t0) > 2.00
    then v_why := 'TW-5 spend since T0 > $2.00'; end if;
  select count(*) into v_n from ops.pipeline_items
    where stage='reassigned_human' and stage_entered_at > v_t0;
  if v_n > 3 then v_why := coalesce(v_why,'') || ' TW-3 reassigned_human=' || v_n; end if;
  if (select queue_length from pgmq.metrics('q_pipeline')) > 2000
    then v_why := coalesce(v_why,'') || ' TW-6 q_pipeline depth'; end if;
  if exists (select 1 from ops.llm_runs where created_at > v_t0 and purpose like 'draft:%'
              and pipeline_item_id is not null
              group by pipeline_item_id having count(*) > 1)
    then v_why := coalesce(v_why,'') || ' TW-2 duplicate draft calls'; end if;

  if v_why is null then return 'ok'; end if;
  select id into v_sys from iam.principals where handle='SYSTEM';
  update iam.global_switches set value=false, changed_at=now(), changed_by=v_sys
   where key='pipeline_intake_enabled';
  insert into ops.incidents (severity, source, message)
  values ('critical','newsroom:intake', ('AUTOHALT — intake closed: '||v_why)::text);
  return 'halted: ' || v_why;
end $$;
select cron.schedule('newsroom_intake_autohalt', '*/5 * * * *', $$select ops.newsroom_intake_autohalt()$$);
-- Scheduled WITH the flip, not after it. pg_cron is UTC; 16:00 UTC = 19:00 Riyadh.
select cron.schedule('newsroom_intake_autoclose', '0 16 * * *',
  $$update iam.global_switches set value=false, changed_at=now(),
      changed_by=(select id from iam.principals where handle='SYSTEM')
    where key='pipeline_intake_enabled'$$);
```

Re-opening the next morning is one statement. Leaving it open unattended is the irreversible half.

##### 3.4 The desk surfaces (hard prerequisite, not polish)

`ops.*` is **not PostgREST-routed** — `db-schemas` is locked to `public, graphql_public`, so `ops.pipeline_items`, `ops.classifier_verdicts`, `ops.rule_violations`, `ops.fit_reports` and `iam.global_switches` are unreachable from Next even with the service-role key (`src/lib/data/desk.ts:12-29`, and the file says so explicitly). Ship, in one migration + two page changes:

- **`public.v_desk_reassigned`** — clone `v_desk_approvals` (`20260720151411:32-60`) with `where pi.stage='reassigned_human'`, plus the transition detail sourced from `ops.agent_runs.stats` where `task_key='pipeline:transition' and stats->>'to'='reassigned_human'` — that JSON already carries `reason` and `blocked[]` from `rules-stage.ts:55` and `refusals[]` from `fit.ts:83-86`.
- **`public.v_intake_pulse`** — the operator's screen: per-object_type `accepted_states / venue_codes / recency_days / hourly_cap`, `events_admitted_1h`, `events_admitted_24h`, `deferred_pending`, `deferred_oldest_age`, today's `ops.llm_runs` cost and `ops.newsroom_budget_state()`. Without it, "read `ops.v_intake_readiness` BEFORE flipping" is a psql-only act with no screen. **service_role only** — it exposes switch state and spend.
- **`public.desk_reopen_event(p_dedup_key text)`** — closes the burned-event hole (`consumer.ts:33` `MAX_READ_CT=5` → archive, and nothing deletes the dedup row). It must **never delete the ledger row**: deleting un-dedups a live event whose 2.9 siblings are still arriving, which is byte-for-byte the incident at `BRIDGE-BUILD-PLAN.md:936`.

```sql
create or replace function public.desk_reopen_event(p_dedup_key text) returns text
language plpgsql security definer set search_path = '' as $$
declare o lake.objects; mp ops.materiality_prefilter; v_asof date; v_status text; v_recent int;
begin
  if not coalesce((select value from iam.global_switches where key='pipeline_intake_enabled'), false)
    then return 'refused: intake gate closed'; end if;                   -- L1 stays complete
  select * into o from lake.objects
   where id = (select object_id from ops.intake_dedup where dedup_key = p_dedup_key);
  if not found then return 'refused: unknown dedup key'; end if;
  if o.superseded_by is not null then return 'refused: superseded'; end if;
  if not lake.fn_intake_eligible_state(o.object_type, o.state) then return 'refused: state'; end if;
  if o.security_id is null then return 'refused: no security'; end if;
  select pr.status into v_status from lake.parse_runs pr where pr.id = o.parse_run_id;
  if v_status is distinct from 'succeeded' then return 'refused: parse run'; end if;
  select * into mp from ops.materiality_prefilter where object_type = o.object_type;
  if mp.verdict = 'not_material' then return 'refused: not material'; end if;
  if mp.venue_codes  is not null and not (o.venue_code  = any(mp.venue_codes))  then return 'refused: venue'; end if;
  if mp.security_ids is not null and not (o.security_id = any(mp.security_ids)) then return 'refused: security'; end if;
  if mp.recency_days is not null then
    v_asof := coalesce(o.effective_date, nullif(o.payload->>'period_end','')::date);
    if v_asof is null or v_asof < current_date - mp.recency_days then return 'refused: recency'; end if;
  end if;
  select count(*) into v_recent from ops.intake_dedup
   where object_type = o.object_type and admitted_at > now() - interval '1 hour';
  if mp.hourly_cap is not null and v_recent >= mp.hourly_cap then return 'refused: hourly cap'; end if;

  update ops.intake_dedup set object_id = o.id, admitted_at = now() where dedup_key = p_dedup_key;
  perform pgmq.send('q_pipeline', jsonb_build_object('handler','pipeline_classify',
    'lake_object_id',o.id,'object_type',o.object_type,'security_id',o.security_id,'venue',o.venue_code));
  return 'reopened';
end $$;
revoke all on function public.desk_reopen_event(text) from public, anon, authenticated;
grant execute on function public.desk_reopen_event(text) to service_role;
```

Every new `public` object in this step carries the same `revoke all … from public, anon, authenticated; grant … to service_role` block as `20260720151411:97-98,116-117`.

- **`public.desk_retract(p_content uuid, p_mode text)`** — the emergency un-publish, because there is none today. `p_mode='retract'` → `status='retracted'` (page stays reachable with a banner — R-08's stated behaviour, and anon RLS still admits it, `20260713000014:109`); `p_mode='unpublish'` → `status='draft'`, the **only** status that simultaneously leaves anon RLS, deletes the `search_documents` row (`20260726203031:98-104`) and drops out of the sitemap. Append a `public.content_corrections` row in the same transaction (the table is append-only, `20260713000008:105-113`).

- **`/admin/approvals`** gains a `?stage=reassigned` tab rendering `v_desk_reassigned`, and the detail page renders `ops.rule_violations.detail` — `desk_approval_detail` already selects it (`20260720151411:90`) and the page throws it away, so *"R-04 · blocked"* is currently not an actionable fact.

##### 3.5 Fix the one tripwire that detects unreviewed public exposure

`ops.desk_decide_approval`'s `approve` branch (`20260720142331:70-71`) writes `content_items.status='live'` and calls `fn_transition`, and **never stamps `approval_decision` / `decided_by` / `decided_at`** — only `approve_scheduled` (`:76`), `send_back` (`:79`) and `reassign` (`:84`) do. The CHECK at `20260713000009:89` even reserves the value `'publish_now'` that is never written. So the tripwire "any live piece after T0 without a matching approval decision" returns NULL for **every legitimately approved piece**, and the auto-publish path (`rules-stage.ts:84`) leaves both NULL too — the query cannot distinguish the two states it exists to distinguish. One line, same PR:

```sql
  if p_decision = 'approve' then
    update public.content_items set status='live', published_at=now() where id = v_cid;
    update ops.pipeline_items
       set approval_decision='publish_now', decided_by=v_actor, decided_at=now()
     where id = p_item;
    perform ops.fn_transition(p_item, 'published', v_actor, jsonb_build_object('decision','approve'));
```

Until it ships, express TW-1 against the audit that *does* exist: `ops.agent_runs where task_key='pipeline:transition' and stats->>'to'='published'` — `stats->>'decision'='approve'` is the desk, `stats->>'auto'='true'` is `rules-stage.ts:86`, `stats->>'scheduled'='true'` is the publish sweep — and revert only on the last two.

##### 3.6 Make policy changes actually invalidate queued approvals

`ops.desk_decide_approval`'s RULES_STALE guard (`20260720142331:62-67`) compares `pipeline_items.rules_passed_version` (stamped from `ops.rulesets.version_no`, `rules-stage.ts:30,45`) against the live version. But the rules are **TypeScript** in `ingestion/src/rules/rules.ts`: the R-04 fix shipped 2026-07-27 with **no new `ops.rulesets` row** (still v9, seeded `20260713000009:161-163`), so pieces validated by the buggy R-04 read as fresh. §3.1 then moves R-03's state policy into `ops.materiality_prefilter.accepted_states` — a row this procedure *edits as an operating lever* — which the guard also cannot see. Without this, tightening `accepted_states` mid-incident leaves four pieces at `approval` that passed under the looser policy showing no stale banner.

```sql
create or replace function ops.fn_bump_ruleset() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_live int; v_next int; v_cfg jsonb; v_sys uuid;
begin
  select version_no, config into v_live, v_cfg from ops.rulesets where is_live;
  v_next := v_live + 1;
  select id into v_sys from iam.principals where handle='SYSTEM';
  update ops.rulesets set is_live = false where version_no = v_live;   -- rulesets_one_live is partial-unique
  insert into ops.rulesets (version_no, deployed_by, is_live, config) values (v_next, v_sys, true, v_cfg);
  insert into ops.rules (ruleset_version, rule_key, title, body, scope, enforcement, enabled, params)
    select v_next, rule_key, title, body, scope, enforcement, enabled, params
      from ops.rules where ruleset_version = v_live;                   -- ops.rules FKs version_no
  return null;
end $$;
create trigger materiality_prefilter_bumps_ruleset
  after insert or update or delete on ops.materiality_prefilter
  for each statement execute function ops.fn_bump_ruleset();
```

And the discipline for **rule code**: a change to `ingestion/src/rules/*.ts` bumps `ops.rulesets` in the same commit. PR.6.0 opens by bumping v9 → v10 for the already-shipped R-04 fix.

##### 3.7 The stop ladder — corrected ordering, and what each rung actually does

`draft.ts:55` and `edit.ts:28` early-`return` on `outputHalted`, and `consumer.ts:186-189` archives the message on **any** normal handler return. There is no redelivery on that path. The single re-delivery source is `ops.newsroom_stalled_sweep`. Pausing the sweep *before* halting output therefore strands every in-flight item with no message and no screen.

| L | Act | Stops | Latency | Cost of using it |
|---|---|---|---|---|
| **L1** | `update iam.global_switches set value=false where key='pipeline_intake_enabled'` | New admissions **and** the deferred backlog (the drip re-checks per tick) | Immediate — the trigger reads the switch per row (`20260727150000:139-141`) | none. **This is the default rollback, and it is complete for the gate.** |
| **L2** | `update … set value=true where key='kill_all_output'` | Drafting/editing on messages already in `q_pipeline` | Next delivery, ≤600s (`consumer.ts:27`) | ⚠️ **consumes and ARCHIVES the in-flight message; the item's only re-entry is `newsroom_stalled_sweep`.** Does **not** stop `classify.ts` creating stubs (`classify.ts:120` carries an explicit `void switchOn` "reserved" marker), and does **not** stop `rules-stage.ts:77-87` auto-publishing — both moot only while `auto_publish_wires=false`. Verify that first. |
| **L3** | `update … set value=true where key='newsroom_stalled_sweep_paused'` (a switch the sweep reads — **never `cron.unschedule`**) | The re-enqueue amplifier | ≤5 min | mid-conveyor items are now frozen with **no** re-entry until un-paused. Never pull L3 before L2. |
| **L4** | `ssh 91.99.99.85 'systemctl stop marsad-worker'` | Everything, including ingest | Immediate on new reads | Blunt — halts quote/filings ingestion too. |
| **L5** | `select pgmq.purge_queue('q_pipeline')` | Everything queued | Immediate | **Destroys the cross_check backfill fan-out** (up to 6,000 msgs/hour of unrelated work) with no other record. Last resort. |

**Manual re-entry**, which nothing else provides: `select pgmq.send('q_pipeline', jsonb_build_object('handler','pipeline_'||stage,'pipeline_item_id',id)) from ops.pipeline_items where stage in ('draft','edit','rules') and stage_entered_at > '<T0>';`

##### 3.8 The amplifier guard

```sql
alter table ops.pipeline_items add column if not exists last_nudged_at timestamptz;
-- ops.newsroom_stalled_sweep SELECT gains:
--   and (last_nudged_at is null or last_nudged_at < now() - interval '20 minutes')
--   and not coalesce((select value from iam.global_switches where key='newsroom_stalled_sweep_paused'), false)
-- and, inside the loop before pgmq.send:  update ops.pipeline_items set last_nudged_at = now() where id = r.id;
```

Caps amplification at 1 duplicate per 20 minutes instead of 4. **The better fix** — newsroom stages on their own pgmq queue at qty 1 / concurrency 1, which `consumer.ts:22-27` already claims is the contract — is the WD-4 widening precondition, not a day-1 blocker.

##### 3.9 The opening parameters, and why each

| parameter | day-1 value | reason |
|---|---|---|
| `object_type` | `FILING.FINANCIALS` only | already true by construction (§2) |
| `venue_codes` | `{TDWL}` | golden source (`DEF-EXIT-MUBASHER`); the XBRL producer is the most proven and `[100010]` gives 185/185 ISIN + sector, so the writer context is richest there |
| `security_ids` | 3, explicit | the first opening must produce a countable number of pieces the editor reads individually. Pick with: securities where `venue_code='TDWL' and status='listed'`, having both a `COMPUTED.RATIOS` and a `COMPUTED.SCORE` object, and `sector <> 'unknown'` — **487 of 762 securities are `sector='unknown'`**, and a piece about a sectorless company has no peer context |
| `recency_days` | `30` | kills historical backfill dead. A TDWL quarterly lands ~30 days after period end; annuals land 60–90 days out and are deliberately excluded on day 1 (they widen in at WD-2) |
| `hourly_cap` | `6` | 6 writer chains/hour ≈ $0.0063/hour, and at ~5 min per piece an editor absorbs ~10/hour — 6 leaves headroom for the day job |
| `auto_publish_wires` | stays `false` | non-negotiable for the entire opening |
| `newsroom_fit_stage` | stays **absent** | `worker/src/handlers/newsroom/fit-stage.sql` is written but not in `supabase/migrations/` (its own header, lines 3-13), `'fit'` is not in `pipeline_items_stage_check` (`20260720110829:104-106`) so `rules-stage.ts:71` would RAISE inside `fn_transition`, and `switchOn` reads a missing key as false (`shared.ts:26-29`). **Leave it that way.** `draft.ts` emits `text` blocks, not `BLK-*` codes; turning fit on now adds a refusal surface for a shape nothing produces. Fit belongs after PR.4. |

**Expected day-1 volume: 0–4 pieces.** That is the point. If the window is empty because no allowlisted company reported in 30 days, the opening still succeeds — it proves the gate is quiet — and the Drill-3 canary path exercises the conveyor.

---

#### 4. Build order

Each step is independently verifiable and merges on its own.

**PR.6.0a — Admitted-state threading.** §3.1, plus bump `ops.rulesets` v9 → v10 for the already-shipped R-04 fix.
_Accept:_ a `RuleContext` fixture with one PENDING citation carrying `accepted_states:['VERIFIED','PENDING']` passes R-03; the same citation with `['VERIFIED']` blocks; the same pair against `checkBinding`. `npx tsx --test "src/**/*.test.ts"` green in `ingestion/` and `worker/`.

**PR.6.0b — Narrowing, deferral, pace, dead-man.** §3.2 + §3.3, one migration. All narrowing columns NULL on apply.
_Accept:_ applying the migration changes zero behaviour (every predicate is NULL); `ops.newsroom_intake_drip(1)` returns 0 with the switch off; `cron.job` shows `newsroom_intake_drip`, `newsroom_intake_autohalt`, `newsroom_intake_autoclose` active; `scripts/check-migration-ledger.mjs` green.

**PR.6.0c — Desk surfaces.** §3.4 + §3.5 (`approve` stamping) + the `/admin/approvals` reassigned tab and violation-detail rendering.
_Accept:_ `/admin/approvals` and `/admin/approvals?stage=reassigned` both render; `desk_reopen_event` on a closed gate returns `'refused: intake gate closed'`; `desk_retract(<qnb>, 'retract')` moves the piece and appends a corrections row; `next build` green.

**PR.6.0d — Reader cache invalidation.** `src/app/admin/approvals/actions.ts` currently calls `revalidatePath` on the two admin paths only (`:25-26`) and never invalidates the reader tags — so approving is up to 60s late on the reader and **retracting is equally late** (`cacheLife({stale:30,revalidate:60,expire:3600})` + `cacheTag("content"|"newsroom"|"articles")` at `newsroom.ts:303-306,334-337,357-360` and `editorial.ts:285-289`; slug lists expire at 86400, `editorial.ts:461`). `decideAction` is a Server Action, so it can use `updateTag` (immediate, read-your-own-writes) — the form the route handler at `src/app/api/revalidate/route.ts:34-37` notes is Server-Action-only. ⚠️ Per AGENTS.md, confirm the `updateTag` export and signature against `node_modules/next/dist/docs/` before writing it; this is Next 16.2.10 with Cache Components on.
_Accept:_ a decision that changes `content_items.status` invalidates `content`, `newsroom`, `articles`; measured reader lag on approve/retract drops from ~60s to sub-second.

**PR.6.0e — Amplifier guard + sweep pause switch.** §3.8.
_Accept:_ two items at `draft` older than 20 min receive exactly one nudge each per 20 min, not four; setting `newsroom_stalled_sweep_paused` stops nudging within one tick and clearing it resumes.

**PR.6.0f — Two cheap defects, same PR.** (1) `rules.ts:147` — the R-04 "other direction" scan is nested inside the per-sentence loop opened at `:106`, shadowing `sentence`; a 6-sentence body scans 6×6 and pushes each `number_unaccounted` violation 6 times into `ops.rule_violations.detail` (persisted `rules-stage.ts:42-43`). O(n²). **Two-line dedent** to sit under the `bodySurfaces` loop at `:105`. It does not change the verdict; it makes the desk's rule log readable at exactly the moment it matters. (2) RLS on `ops.materiality_prefilter` and `ops.llm_cost_daily` — `DEF-RLS-GATE-RED-SINCE-0720`, red since 2026-07-20 and uncaught because GitHub Actions is billing-blocked.
_Accept:_ a 6-sentence fixture emits each violation once; `psql -f scripts/assert-rls.sql` green.

**PR.6.0g — Owner acts (not agent work).** (i) Correct or retract `content_id b2459c8e-c28f-4d5b-a37f-df82022904e5` — the live QNB wire whose *"QAR 4.22bn a year earlier"* is sourced to nothing and whose *11.2%* is cited to a net-profit object and reached the headline (`DEF-RULES-R04-SOME-NOT-EVERY`, `BUILD-STATUS.md:599`, which names this a precondition of switching intake on). Re-run the fixed R-04 against it and confirm it passes before any re-publish. **Do not open the gate with a known-wrong number on the reader.** (ii) Apply `20260722150000_newsroom_wire_slug_and_citations_read.sql` — see §7.

**PR.6.1 — The drills.** Five, run in one session from psql against production, in order, with numbers recorded in `docs/BUILD-STATUS.md`. Total cost under $0.01. A drill with no recorded numbers did not happen.

- **Drill 1 — the gate.** One transaction, **rolled back**; `pgmq.send` is an ordinary INSERT so it participates, the switch UPDATE is visible only inside, the synthetic object never commits. Open with `set local idle_in_transaction_session_timeout='60s'` — the drill holds a row lock on `iam.global_switches` and an abandoned session would block the L1 emergency statement. Assert on **the drill's own message**, never on queue depth: `select count(*) from pgmq.q_q_pipeline where message->>'lake_object_id' = '<synthetic uuid>'`. ⚠️ pgmq names the table `pgmq.q_<queue>`, so for queue `q_pipeline` it is **`pgmq.q_q_pipeline`**; and comparing `count(*)` across steps is racy against `enqueue_crosscheck_sweep` pushing 500 msgs/5min while the worker archives at qty 25 / concurrency 12 — the drill would silently pass on the one property it exists to prove. Use `pgmq.metrics('q_pipeline')` wherever a depth number is genuinely wanted.
  Arms, each asserting on its own uuid: switch OFF → 0 · switch ON → 1 · switch OFF again → 0 · `venue_code='DFM'` against `venue_codes='{TDWL}'` → 0 · `security_id` outside the allowlist → 0 · `effective_date = current_date-200` with `recency_days=30` → 0 · `parse_runs.status='running'` → 0 (`20260727150000:151-152`) · `security_id is null` → 0 (`:150`) · same `(type,security,fiscal_period)` twice → second is 0 · `hourly_cap` exceeded → 0 **and** one `ops.intake_deferred` row.
  **Plus a drip arm in the same rolled-back transaction:** insert one `ops.intake_deferred` row, `select ops.newsroom_intake_drip(1)` with the switch off (must return 0 and send nothing), flip on, re-run (must return 1 and stamp `admitted_at`). The drip is the *second* `pgmq.send` path and the thing that makes L1 stop the backlog — untested, nobody finds out until the night a backlog exists.
  **This is the single most important drill: it proves the switch and every predicate against production at zero cost and zero residue.**
- **Drill 2 — the output kill switch.** Stub a `content_items` row + `ops.pipeline_items` at `stage='draft'` against a real recent TDWL `FILING.FINANCIALS`; set `kill_all_output=true`; send `pipeline_draft`. PASS iff the log shows `draft: output halted (kill switch) — leaving in place` (`draft.ts:55`), the item is still at `draft`, no `content_blocks`, and **no** new `ops.llm_runs` row. Record in the ledger, because it changes the rollback design: **the stop is `pipeline_intake_enabled=false` plus a drain, not `kill_all_output`.**
- **Drill 3 — the canary (go/no-go for PR.6.0a).** Bypass the gate by hand: `pgmq.send('q_pipeline', {'handler':'pipeline_classify','lake_object_id':'<real recent TDWL FILING.FINANCIALS uuid>', …})`. PASS iff within 10 minutes exactly one new `ops.pipeline_items` row reaches `stage='approval'`, with: one `ops.classifier_verdicts` row `tier='prefilter'`, `verdict='material'`, `priority='story'`, `llm_run_id is null` (a deterministic prefilter row, `20260720110829:51` — classify is $0); **no** `outcome='blocked'` `cited_object_state_not_admitted` row; exactly **2** `ops.llm_runs` rows (`draft:` and `edit:`) totalling ≈$0.00105; the piece visible in `/admin/approvals`; and `content_items.status='draft'`, not `live`. **FAIL → stop; do not proceed.** Record `blocked[]` from `ops.agent_runs.stats` and go back to PR.6.0a. **Repeat on three different securities** — one success is a coincidence, three is a path.
- **Drill 4 — the stop on a piece already in flight.** Enqueue a fourth canary; the moment it enters `edit`, set `kill_all_output=true`. PASS iff it stays at `edit` for ≥15 min with no new `ops.llm_runs` row, and each stalled-sweep nudge produces exactly **one halt log and one archived message** — there is no redelivery on the halt path (`consumer.ts:186-189` archives on normal return), so "a halt log per redelivery" is unobservable. **Count the nudges**: with `last_nudged_at` shipped, at most one per 20 minutes. This is the live verification of PR.6.0e. Clear the switch; confirm it resumes to `approval`.
- **Drill 5 — un-publish latency, measured on the QNB act, not on a canary.** ⚠️ **Do not publish a canary to test retraction.** Retraction does not undo publication: anon RLS still admits `'retracted'` (`20260713000014:109`), `fn_search_index_content` treats it as visible and keeps the `search_documents` row (`20260726203031:90`), and `listPublishedArticleSlugs` (`editorial.ts:457-470`) leans entirely on RLS, so the piece stays in `sitemap.xml`, which `robots.ts` hands to every crawler. Publishing an untriaged machine-written earnings claim about a real listed issuer as a *test* is the exact failure the guardrail stack exists to prevent. PR.6.0g requires the QNB status change anyway, and it exercises the identical code path (status change → cacheTag invalidation → reader), so **stopwatch that** and record the number. Without PR.6.0d it is up to 60s; with it, sub-second. That number is the true latency of your emergency un-publish and §5's rollback depends on it. If a canary publish is ever still wanted, it must terminate at `status='draft'` — the only status that simultaneously leaves anon RLS, deletes the search row (`20260726203031:98-104`) and drops from the sitemap — with all three verified, and never at `'retracted'`.
  *One line on where the adversarial reading is wrong today:* the sitemap/search residue is **not** currently reachable for an ARTICLE, because `20260722150000` is unapplied so no publish path stamps `slug` (`DEF-NEWSROOM-WIRE-SLUG-CITATIONS`), `fn_search_index_content` deletes rather than inserts when `v_url is null`, and every ARTICLE reader surface filters `slug is not null` (`editorial.ts:400,447,469,500`) — but it becomes exactly right the moment PR.6.0g(ii) lands, which PR.6 requires, so the rule stands unchanged.
- **Teardown (mandatory).** Enumerate every `pipeline_item` and `content_id` created by Drills 2–4 **by id**, `fn_transition(id,'dead',…)` each (legal from `draft`/`edit`/`rules`, `20260720110829:~135`), and record the content_ids in the BUILD-STATUS drill entry as known debris. ⚠️ `content_items` has no `archived`/`killed` status (`20260713000008:32-33`), so each stub remains a permanent `status='draft'` row — that is the same missing verb as `DEF-NEWSROOM-NO-DECLINE-DECISION`, and it is why P-07 below is phrased as an *enumerated exception*, not "zero".

**PR.6.2 — Pre-flight.** Every row is a hard stop; one mismatch aborts the opening.

| # | Read | Required |
|---|---|---|
| P-01 | `iam.global_switches` | `pipeline_intake_enabled=false`, `auto_publish_wires=false`, `kill_all_output=false`, `pause_all_agents=false`. Anything else → something already changed state |
| P-02 | `ops.v_intake_readiness` | exactly one row whose `accepted_states` contains `PENDING`, and it is `FILING.FINANCIALS` |
| P-03 | `ops.materiality_prefilter where verdict <> 'not_material'` | `FILING.FINANCIALS`: `venue_codes='{TDWL}'`, the 3-security allowlist, `recency_days=30`, `hourly_cap=6`. Every other row: all four NULL **and** `accepted_states='{VERIFIED}'` |
| P-04 | 7-day flow: `count(distinct lake.fn_intake_dedup_key(o))` over `FILING.FINANCIALS`, `venue_code='TDWL'`, `superseded_by is null`, `created_at > now()-'7 days'` | record it; ÷7 = expected events/day. >40/day → tighten before flipping |
| P-05 | `count(*) from ops.intake_dedup` | 0, or exactly the drill rows listed by key |
| P-06 | `ops.intake_deferred` pending | 0 |
| P-07 | `ops.pipeline_items` by stage | ≤3 pre-existing rows; **zero at `draft/edit/rules` other than the enumerated drill ids, which must all be at `dead`** |
| P-08 | `pgmq.metrics('q_pipeline')` | record the baseline; >2,000 → postpone, you are opening into contention |
| P-09 | `systemctl list-timers 'marsad-*'` on 91.99.99.85 | **every researcher gapfill/backfill timer stopped** — `tadawul-gapfill`, `adx-gapfill`, `dfm-backfill`, `msx-stmt-extract`, `bhb-financials`, `qe-financials` |
| P-10 | `ops.newsroom_budget_state()` + MTD `ops.llm_runs` | `'ok'`, MTD < $30 — at `degraded` the writer silently drops to the fallback chain (`draft.ts:88`) and you are testing a different model than you intend |
| P-11 | `content_items` for `b2459c8e-…` | `status='retracted'`, or `'live'` with ≥1 `content_corrections` row |
| P-12 | `cron.job where jobname like 'newsroom%'` | publish/sla/stalled/**intake_drip**/**intake_autohalt**/**intake_autoclose** all present and active |
| P-13 | `\d ops.pipeline_items` | `last_nudged_at` exists |
| P-14 | `/admin/approvals` and `/admin/approvals?stage=reassigned` | both render |
| P-15 | `select version_no from ops.rulesets where is_live` | **> 9**, and no item at `approval` carries a lower `rules_passed_version` |
| P-16 | RB record in `docs/BUILD-STATUS.md` | all 5 drills PASS with numbers, dated today or yesterday |
| P-17 | Editor availability | a named human at the desk for the next 6 hours inside 07:00–22:00 Riyadh — outside that window the SLA clock is paused (`20260720142331:126-127`) and nobody is reading |

**PR.6.3 — The flip.** One statement, timestamped. `changed_by` is a NOT NULL FK (`20260713000002:56-61`), so it must name a principal:

```sql
update iam.global_switches
   set value = true, changed_at = now(),
       changed_by = (select id from iam.principals where handle = 'DESK-OWNER')
 where key = 'pipeline_intake_enabled';
```

Record T0 to the second; every watch query is scoped `where created_at > '<T0>'`. **There is no UI for this** — `iam.global_switches` has no public wrapper and `src/app/admin/agents/page.tsx:144-148` already renders it as a flagged data gap. Flipping is a direct-SQL owner act, and the switch has no audit trail beyond `changed_by`/`changed_at`. Say so rather than pretending otherwise.

**PR.6.4 — The watch.** Every 15 min for 2 hours, every 30 min to T+6h, hourly to T+24h, into a single timestamped scratch file — a watch with no written trail cannot support a widening decision. Screen: `/admin/v_intake_pulse`, plus psql for the rest.

- **W1** admission + dedup: `count(*) filter (where admitted_at > now()-'1 hour')` and total, from `ops.intake_dedup`.
- **W2** burst gauge: pending / oldest / oldest_age from `ops.intake_deferred`.
- **W3** stage histogram + oldest stuck, `stage_entered_at > T0`.
- **W4** **the amplifier tripwire**: `ops.llm_runs` where `purpose like 'draft:%'` group by `pipeline_item_id` having `count(*) > 1`.
- **W5** failure reasons: `ops.rule_violations` by `rule_key, outcome`.
- **W6** spend by lane: `split_part(purpose,':',1)` + `ops.newsroom_budget_state()`.
- **W7** contention: `pgmq.metrics('q_pipeline')` + `ops.incidents where source='worker:q_pipeline'`.
- **W8** **the one that matters most** — reader exposure: `content_items` at `live|updated` created after T0, left-joined to `ops.pipeline_items.approval_decision/decided_by`; cross-checked against `ops.agent_runs` transitions until PR.6.0c ships.
- **W9** staleness escape: items whose trigger object's `coalesce(effective_date,(payload->>'period_end')::date) < current_date - 30`.
- **W10** what the newsroom ignored: `ops.classifier_verdicts` by tier/verdict/priority.
- **W11** the failure desk: `count(*) at reassigned_human` since T0.

Out of band: `journalctl -u marsad-worker -f | grep pipeline_` for the halt/no-op lines, and `/admin/approvals` actually populating.

**PR.6.5 — Rollback.** Ladder per §3.7. Disposition by stage:

| stage | disposition |
|---|---|
| `draft` (never drafted) | `fn_transition(id,'dead',…)`; the `'(drafting)'` stub stays at `status='draft'` as debris — **log the ids** |
| `draft` (drafted, looped back) | same — the draft is unfinished, not wrong; do not publish it |
| `edit` | `edit → dead` (legal) |
| `rules` | **wait** for it to land at `approval` or `reassigned_human`; forcing `rules → dead` is legal but loses the rule log, which is the diagnostic you rolled back to obtain |
| `approval` | **leave it.** These are the artefacts of the experiment; approving one after a rollback is a deliberate, separate decision |
| `reassigned_human` | leave; this is the failure sample. Read every one through `v_desk_reassigned` |
| `published` | `desk_retract(id,'retract')` keeps the page with a banner; `desk_retract(id,'unpublish')` removes it from anon RLS, the search index and the sitemap. Only category with public blast radius |

Closing out the ledgers **atomically** — the drop and the un-claim must be one statement, or the parked events (which already hold committed dedup rows, and therefore "will never re-admit") become silently unreachable forever with no query that reveals it:

```sql
with d as (
  update ops.intake_deferred set dropped_at = now(), drop_reason = 'PR.6 rollback <T0>'
   where released_at is null and dropped_at is null
  returning dedup_key)
delete from ops.intake_dedup where dedup_key in (select dedup_key from d);
```

Record the dropped keys in the BUILD-STATUS rollback entry so the events are re-creatable by hand. Post-rollback obligations: write it up the same day with T0, the trip and the §PR.6.4 counts; if the trip was a content defect, **the rule that should have caught it gets written and the ruleset bumped before the next attempt** (that is the standing policy from the R-04/QNB incident, and §3.6 is what makes it enforceable); and re-run Drill 1 — a rollback means something in the model of the system was wrong.

**PR.6.6 — Widening.** Never two dimensions at once; each step needs a full clean watch cycle at the previous one.

| step | change | preconditions |
|---|---|---|
| **WD-1** | drop `security_ids` | ≥10 pieces reached `approval`; ≥8 decided `approve` or `send_back` (not `reassign`); 0 tripwires over ≥48h; deferred backlog returned to 0 at least once |
| **WD-2** | `recency_days` 30 → 90 (admits annuals) | 3 consecutive trading days clean at WD-1; W9 never fired; **researcher gapfill timers still stopped** — this is the step where a backfill would do the most damage |
| **WD-3** | add venue `QE` | 5 trading days clean at WD-2. QE next because its researcher is deployed and proven live 2026-07-18 (QIBK 81 rows, 0% identity gap) and its universe is 54 companies, not 185 — the smallest possible second venue. **Not** ADX/DFM/BHB/MSX yet |
| **WD-4** | `hourly_cap` 6 → 12 | the editor cleared a full day's queue inside the 3h SLA (`20260720110829:108`) with zero `sla_breached_at`; **and** newsroom stages moved onto their own pgmq queue at qty 1 / concurrency 1 — the full `DEF-QPIPELINE-CONCURRENCY-CONTRADICTION` fix, not the `last_nudged_at` mitigation |
| **WD-5** | restart the researcher gapfill timers | WD-2 stable 5 trading days, proving `recency_days` holds against a live backfill. One researcher, watch 24h, then the rest |
| **WD-6** | a second `object_type` | **Blocked, and say so.** The natural candidate is `DIVIDEND.EXDATE`, but it is `price_sensitive`, which `fn_object_state_guard` requires a **human** `verified_by` for, and no code implements that path — it is **PE.7**, which must ship first. `FINANCIALS.XCHECK` (41,621 objects) is not a candidate: a reconciliation is not an event |

**Widen on evidence, not on a schedule.** If nothing arrives for a week because no allowlisted company reported, wait.

**Immediate-revert tripwires** (any one → L1 now, questions after). Named `TW-*` deliberately, to avoid collision with rules `R-01…R-10`:

| # | Trip | Query | Why |
|---|---|---|---|
| TW-1 | any `live`/`updated` piece after T0 with no matching desk decision | W8 | the four-locks assumption has failed — the one outcome with public blast radius |
| TW-2 | any `pipeline_item_id` with >1 `draft:` run | W4 | the stalled-sweep amplifier is live; per-piece cost is unbounded |
| TW-3 | `reassigned_human` >20% of admitted events in hour 1, or >3 absolute | W11 | the R-03 class is back; every further admission burns three writer calls to a dead end |
| TW-4 | a piece at `approval` whose trigger period is outside the window | W9 | recency is not working; a backfill can mint stale earnings stories |
| TW-5 | spend since T0 > $2.00 | W6 | ~30× the expected full day ($0.21–$0.63); something is looping |
| TW-6 | `q_pipeline` depth >2,000 or ≥3 `worker:q_pipeline` incidents | W7 | contention with the cross_check fan-out; the amplifier compounds it |
| TW-7 | `newsroom_budget_state()` `degraded`/`halted` | W6 | ladder shared with the PE extraction fleet; the writer silently dropped to the fallback chain |
| TW-8 | the editor finds a number not in the cited object | manual | a rule escape. Freeze, write the rule, bump the ruleset, then re-open |
| TW-9 | `ops.intake_deferred` pending rises 2 consecutive hours | W2 | inflow exceeds both the cap and the editor; not an emergency, but the experiment is no longer readable |
| TW-10 | two pieces at `approval` for the same security and fiscal period | manual | dedup is not holding; `DEF-NEWSROOM-DEDUP` is back |

TW-2, TW-3, TW-5 and TW-6 are also machine-enforced by `ops.newsroom_intake_autohalt` (§3.3).

**Ledger rows to file in `docs/BUILD-STATUS.md` §7** in the same commits (`BRIDGE-BUILD-PLAN.md:880` lists 14 rows P4.0 required; §7 contains none of them):

| ID | Trigger | Home |
|---|---|---|
| `DEF-NEWSROOM-INTAKE-STATE-CONTRADICTION` — R-03 (`rules.ts:71`) and `checkBinding` (`fit-engine.ts:385`) hard-code `VERIFIED` while the gate admits PENDING. **The single biggest thing between the gate and a working newsroom, written down nowhere.** | before any flip | `09 §3.2`; PR.6.0a |
| `DEF-NEWSROOM-INTAKE-NARROWING` — no venue/recency/security/rate predicate; "one venue" is not expressible | PR.6.0b | `09 §3.2` |
| `DEF-NEWSROOM-DEDUP` — named at `:880`, described at `:936`, never filed; mitigation shipped, recovery path had no RPC | PR.6.0c | `09 §3.2` |
| `DEF-NEWSROOM-NO-FAILURE-DESK` — `v_desk_approvals` is `stage='approval'` only | PR.6.0c | `05-desk-admin.md` |
| `DEF-DESK-APPROVE-NO-DECISION-STAMP` — the `approve` branch never writes `approval_decision`/`decided_by` | PR.6.0c | `05 §4.2` |
| `DEF-NEWSROOM-NO-DECLINE-DECISION` — no "correctly written, not worth publishing" verb, and `content_items.status` has no archived state | before WD-1 | `05 §4.2` |
| `DEF-DESK-APPROVE-NO-CACHE-INVALIDATION` — publish **and retract** lag the reader up to 60s | PR.6.0d | `04-reader-app.md` |
| `DEF-RULES-R04-NESTED-SCAN` — `rules.ts:147` nested inside `:106`; O(n²) violation duplication | PR.6.0f | `03 §8` |
| `DEF-RULESET-VERSION-DOES-NOT-TRACK-TS-RULES` — RULES_STALE cannot see TS rule changes or prefilter policy | PR.6.0a/3.6 | `05 §4.2` |
| `DEF-INTAKE-PROVENANCE-FLOOR-IS-A-CONVENTION` — `20260727150000:151-152` reads `parse_runs.status` at object-INSERT; all seven `FILING.FINANCIALS` producers pre-stamp `'succeeded'`, and the two that honestly stamp `'running'` first (`stockanalysis-financials.mjs:439/472`, `dividend-declared.mjs:152/218`) are **permanently unreachable**. Its real content is "names a security and is not superseded" | before adding any new producer | `09 §3.2` |
| `DEF-INTAKE-READINESS-STOCK-VS-FLOW` — reports a 36,330 stock; flow is ~202/day; the comment claims otherwise | PR.6.0b | `09 §3.2` |
| `DEF-NEWSROOM-BUDGET-LADDER-SHARED` — `newsroom_budget_state` sums all `ops.llm_runs`; `purpose` already carries the lane | WD-4 | `03 §1.7` |

Update rather than duplicate: `DEF-QPIPELINE-CONCURRENCY-CONTRADICTION` (`:610`) — restate its trigger as PR.6.0e (mitigation) / WD-4 (full fix); `DEF-RULES-R04-SOME-NOT-EVERY` (`:599`) — stays open until PR.6.0g(i); `DEF-RLS-GATE-RED-SINCE-0720` — closed by PR.6.0f.

---

#### 5. Acceptance criteria

**PR.6.0**
- [ ] A `RuleContext` with a PENDING citation and `accepted_states:['VERIFIED','PENDING']` passes R-03; with `['VERIFIED']` it blocks. Same pair for `checkBinding`.
- [ ] `ops.rulesets` live version is ≥10, with `ops.rules` rows copied forward.
- [ ] The narrowing migration applies as a behavioural no-op (all four columns NULL).
- [ ] `ops.newsroom_intake_drip(1)` returns 0 with the switch off.
- [ ] `newsroom_intake_drip`, `newsroom_intake_autohalt`, `newsroom_intake_autoclose` are scheduled and active.
- [ ] `public.v_desk_reassigned`, `public.v_intake_pulse`, `public.desk_reopen_event`, `public.desk_retract` exist, each with `revoke all … from public, anon, authenticated` + `grant … to service_role`.
- [ ] `desk_reopen_event` returns `'refused: intake gate closed'` when the switch is off, and re-points (never deletes) the dedup row when it succeeds.
- [ ] The `approve` branch stamps `approval_decision='publish_now'`, `decided_by`, `decided_at`.
- [ ] `decideAction` invalidates `content`, `newsroom`, `articles` on every status-changing decision.
- [ ] `ops.pipeline_items.last_nudged_at` exists; the sweep skips items nudged inside 20 min and honours `newsroom_stalled_sweep_paused`.
- [ ] A 6-sentence R-04 fixture emits each `number_unaccounted` violation exactly once.
- [ ] `psql -f scripts/assert-rls.sql` green (`ops.materiality_prefilter` + `ops.llm_cost_daily`).
- [ ] `npx tsx --test "src/**/*.test.ts"` green in `worker/` **and** `ingestion/`; `next build` green; `node scripts/check-migration-ledger.mjs` green. **Local gates are the only verification — GitHub Actions is billing-blocked and Vercel is the only live gate.**
- [ ] Owner: QNB piece `b2459c8e-…` corrected or retracted, and re-passes the fixed R-04.
- [ ] Owner: `20260722150000` applied (or the decision to defer it recorded, with §7's consequence understood).

**PR.6.1**
- [ ] Drill 1: all eleven arms assert on their own `lake_object_id`, all inside rolled-back transactions, including the drip arm. Zero residue: `ops.intake_dedup`, `ops.intake_deferred`, `lake.objects` and `iam.global_switches` unchanged after `rollback`.
- [ ] Drill 2: halt log present, item unmoved, **zero** new `ops.llm_runs`.
- [ ] Drill 3: three canaries on three securities each reach `approval` with exactly 2 LLM runs, ≈$0.00105, no `cited_object_state_not_admitted`, `status='draft'`.
- [ ] Drill 4: ≥15 min at `edit` with no LLM run; **at most one nudge per 20 minutes** counted.
- [ ] Drill 5: reader un-publish latency measured on the QNB act and recorded; **no canary was published**.
- [ ] Teardown: every drill item at `dead`, every drill `content_id` listed in the BUILD-STATUS entry as known debris.
- [ ] All five drills recorded with actual numbers in `docs/BUILD-STATUS.md`; total drill cost < $0.01.

**PR.6.2–6.4**
- [ ] All seventeen pre-flight rows pass. Any one failing aborts.
- [ ] T0 recorded to the second; the watch file exists with readings at the stated cadence.
- [ ] Over the first 24h: zero TW-1…TW-10 trips, or a rollback written up the same day.
- [ ] `ops.newsroom_intake_autoclose` fired at 19:00 Riyadh and the switch is `false` overnight.
- [ ] Every piece that reached the reader has a matching `approval_decision` **and** `decided_by`.

---

#### 6. What PR.6 deliberately does not do

- **It does not turn on the fit stage.** `fit-stage.sql` stays out of `supabase/migrations/`, `'fit'` stays out of `pipeline_items_stage_check`, and `newsroom_fit_stage` stays a non-existent key. Fit has never seen a real block-coded piece and `draft.ts` emits `text`/`heading`/`pull_quote`, not `BLK-*`. **Hands to PR.4** the job of producing a block-coded piece, and to a PR.4-adjacent step the job of applying `fit-stage.sql` and re-running Drill 3 against it.
- **It does not reseed `ops.templates`.** That is PR.0c, and its justification is `max_words` / `always_premium` / `block_keys` policy plus the four unseeded longform templates — **not** "every template fails fit", which is false (`fit-engine.ts:333-343`).
- **It does not add a `decline` decision or an archived `content_items` status,** so every dead pipeline item leaves a permanent `status='draft'` stub. Filed as `DEF-NEWSROOM-NO-DECLINE-DECISION`, required **before WD-1**.
- **It does not fix `q_pipeline` properly.** `last_nudged_at` caps the amplifier at 1 duplicate/20 min; the real fix — newsroom stages on their own queue at qty 1 / concurrency 1 — is WD-4's precondition and belongs to `DEF-QPIPELINE-CONCURRENCY-CONTRADICTION` / P4.11.
- **It does not scope the budget ladder per lane,** so a large PE extraction run can still demote the writer chain. TW-7 detects it; WD-4 fixes it.
- **It does not build the human-confirm path for `price_sensitive` objects.** That is **PE.7**, and it is what blocks WD-6 and the entire dividend wire class.
- **It does not give the editor everything they need.** Ranked by how likely the absence is to cause a wrong decision under an open gate, and handed forward: (1) **the trigger object's period and as-of date** — missing entirely, and the single most likely defect under an open gate is a stale piece; one join onto `desk_approval_detail`, rendered next to the ticker, is the highest-value UI change available and should land with PR.6.0c if it fits; (2) rule-violation detail (PR.6.0c); (3) a path from a citation to the object — `object_id` is returned (`20260720151411:82`) but not rendered, so the editor cannot verify a number against the lake; (4) what the writer was actually given — `draft.ts:75` reads one object and slices the pack at 12,000 chars, and the editor cannot tell "the writer omitted it" from "the pack never had it"; (5) sibling objects for the event (dedup collapsed ~2.9 into one piece); (6) the last published piece for this security — one line, "last piece for 1010: 3 days ago", catches `DEF-NEWSROOM-DEDUP`. Items 3–6 are a follow-on desk step.
- **It does not make send-back a revision.** `send_back` re-enqueues `pipeline_draft` (`20260720142331:82`) and `draft.ts` re-reads the same single trigger object and the same pack — so **send-back is currently a re-roll, not a revision**. Say that to the editor plainly. It stops being true at PR.2/PR.4, when the researcher brief becomes the writer's input.

**What the editor's loop looks like in the meantime**, stated as procedure: for each piece at `approval`, in SLA order — (1) check company and period, and that the period is inside the recency window; stale → reassign and raise TW-4; (2) read the body against the citation list: every number in prose appears in a citation's `quoted_value`, and every citation's object is in an admitted state; (3) read the rule log — a blocking entry surviving to `approval` cannot happen today (blocked → draft → `reassigned_human`), so its presence means the ruleset changed under the piece, which is exactly what `RULES_STALE` reports; **never approve through a stale-rules banner, re-run instead**; (4) decide. Note what approving bypasses: `fn_enforce_agent_publish_gate` fires only when `app.principal_kind='agent'` (`20260713000008:69`) and the desk path never sets it — **the human is deliberately the exception to the agent publish gate, which is why approving is a real editorial act and not a rubber stamp.** SLA is 3 hours (`20260720110829:108`), paused 22:00–07:00 Riyadh, and a breach only stamps `sla_breached_at` — it never auto-publishes.

---

#### 7. Dependencies — what must be true before PR.6 starts

**Owner actions (cannot be executed by an agent):**

- **O — apply the pending migrations.** `20260727161500` (block `payload_schema`, 0/61) and `20260727170000` (turnover index) are PR.0's items; PR.6 additionally needs **`20260722150000_newsroom_wire_slug_and_citations_read.sql`** applied, because without it no publish path stamps `slug` and an approved ARTICLE has **no reader surface at all** — `getArticleBySlug` cannot find it, `listResearchArticles`/`getRelatedArticles`/`listPublishedArticleSlugs` all filter `slug is not null` (`editorial.ts:400,447,469,500`), and `fn_search_index_content` deletes the search row when `v_url is null` (`20260726203031:98-104`). Either apply it and accept that approving is genuinely public (which is the point), or record the decision to defer it and understand that the first opening cannot demonstrate a published piece.
- **O — correct or retract the live QNB piece** (`b2459c8e-c28f-4d5b-a37f-df82022904e5`). Append-only `content_corrections` or `status='retracted'`; both are human acts through `/admin`. This is PR.6.0g(i) and an explicit gate.
- **O — stop the researcher gapfill timers** on 91.99.99.85 for the duration of the first opening (P-09), and keep them stopped through WD-2.
- **O — flip the switch** (PR.6.3) and be present at the desk for the first 6 hours (P-17).
- **O-5 — unblock GitHub billing.** Until then CI is decorative: every job has died in ~3s with 0 steps since 2026-07-18, `scripts/assert-rls.sql` has been failing unnoticed since 2026-07-20, and `main` was red for 10 commits with two gates dark. PR.6 does not block on this, but every acceptance box above must be ticked from a **local** run.

**Phase dependencies:**

- **PR.6.0 has none.** It is independent of PR.1–PR.4 and should be built in parallel with them. Nothing in it presumes a researcher, an analyst or a compose stage.
- **PR.6.1 (drills) depends on PR.6.0 merged and locally green.** Drill 3 is meaningless before PR.6.0a.
- **PR.6.2–6.4 (the actual opening) depend on PR.6.1 passing with recorded numbers**, and — for the opening to be *worth* doing rather than merely safe — on **PR.4** having produced at least one piece whose `content_blocks` carry real `BLK-*` codes. Opening the gate onto today's `draft.ts` proves the plumbing and produces flat prose; that is a legitimate first outcome, but say which one you are buying.
- **WD-3 (add QE)** depends on nothing new. **WD-4** depends on `DEF-QPIPELINE-CONCURRENCY-CONTRADICTION` / P4.11. **WD-6** depends on **PE.7**.
- **PR.5** (the remaining 41 renderers + the chart compiler) is not a dependency in either direction — `MissingBlock.tsx` degrades honestly, so a composed piece renders partially rather than not at all.
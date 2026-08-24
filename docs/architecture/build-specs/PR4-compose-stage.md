### PR.4 — The compose stage: the producer that emits blocks

_Expansion of the PR.4 stub above; supersedes its two paragraphs. Written 2026-07-27 against the tree at `c181a86` and the live-DB measurements in `architecture/09-signal-to-article.md §12`. Every count below is derived in-repo or measured, not assumed._

---

#### PR.4.0 What this is, and why now

PR.4 builds `pipeline_compose`: a two-pass producer that turns a PR.1/PR.2/PR.3 evidence brief into `public.content_blocks` rows carrying real `BLK-*` codes, D-8 bindings and `lake.citations` with frozen values — and that refuses, with evidence, when it cannot.

**Why now:** the entire validation half of the newsroom is built and idle — 61 Zod schemas, 486 payload constraints, a 869-line fit engine with 19 refusal codes, 20 renderers — and the only thing feeding it is `draft.ts`, which reads exactly one lake object (`draft.ts:75`) and emits flat prose; live `content_blocks.block_kind` is `text(43) heading(8) pull_quote(5)`, **zero** `BLK-*`. Until a producer emits the vocabulary, every one of those checks is a validator with nothing to validate, and the owner has no way to look at what the design actually produces.

---

#### PR.4.1 The measured constraints this must live within

##### 1.1 What the lake can actually bind

Live object families: `OHLCV.CLOSE` 640,992 · `FINANCIALS.XCHECK` 41,621 · `FILING.FINANCIALS` 36,330 · `QUOTE.LAST` 10,913 (6,254 linked to a security) · `COMPUTED.RATIOS` 736 · `PROFILE.SECURITY` 728 · `FILING.REF` 669 (security_id on **zero** rows) · `COMPUTED.SCORE` 540 · `INDEX.LEVEL` 42.

There is **no** dividend family, **no** consensus/estimate family, **no** `market.status` family, and **no** series object. `FILING.FINANCIALS.numeric_value` is populated on **2 of 36,330** rows, so essentially every financial binding is `payload.line_items.<key>` — and `objectField` (`ingestion/src/blocks/binding.ts:48-57`) rejects any path segment with a hyphen or a leading digit, so some real jsonb keys are unaddressable and must be dropped, not guessed at.

##### 1.2 The first-cut vocabulary, derived — 8 codes, not 16

| filter | count |
|---|---|
| active blocks in `ops.story_blocks` | 61 |
| …with a renderer (`src/components/blocks/{a,c,g}`) | 20 |
| …also piece-type-legal on FEATURE+AI (registry normalisation per `scripts/design/generate-registry-seed.mjs:85-91`; `agent_authored` adds `AI` via `fit-engine.ts:289-294`) | 16 |
| …**that the measured lake can supply and fit will accept** | **8** |

The eight that survive: `BLK-TICKER` `BLK-DELTA` `BLK-STATSTRIP` `BLK-RANKROW` `BLK-COMPARE` `BLK-CONFLICT` `BLK-PROV` `BLK-AGENTS`.

The eight dropped from the 16, each for a reason that is a data or contract fact, not taste:

| code | why it cannot be emitted yet | home |
|---|---|---|
| `BLK-SPARK` | `series: ObjectBinding` must resolve to a numeric series; the price family is 640,992 one-value-per-day `OHLCV.CLOSE` objects — no series object exists to bind | PE.5 |
| `BLK-ESTIMATE` | `actual.value`/`estimate.value` bind a **forward** desk computation; the only COMPUTED families are RATIOS (736) and SCORE (540), neither forward | PE.5 |
| `BLK-SCENARIO` | same — `rows[].eps` / `rows[].return_pct` bind desk computations that do not exist | PE.5 |
| `BLK-BEATMISS` | needs consensus EPS **and** a T+0 reaction object; neither family exists | PE.5 |
| `BLK-EXDATE` | needs a dividend-declaration object; no `DIVIDEND.*` family in the lake | PE.5 |
| `BLK-FRESH` | binds `market.status` per venue — no such family; **and** its registry `requires_binding=true` targets a non-lake object, so `checkBinding` (`fit-engine.ts:363-373`) refuses `FIT-BIND-MISSING` regardless | DEF-FIT-BIND-NONLAKE |
| `BLK-RULE` | `requires_binding=true` against `ops.rules`, same `FIT-BIND-MISSING` trap; **and** compose runs two stages before `pipeline_rules`, so `ops.rule_violations` is empty at compose time and there is no fact of the matter for the model to state. `requirement`, `how_it_shaped_this` and `automated_check` would be fabricated by construction | DEF-COMPOSE-BLK-RULE |
| `BLK-CITE` | its `markers[]` are payload-level chips, while R-03 reads `[cN]` **in prose** (`rules.ts:58-80`). Two citation surfaces, one of which nothing checks, is worse than one. Deferred until the reader renders payload-level chips | DEF-COMPOSE-BLK-CITE |

`BLK-TICKER` is conditional: it binds a change field on `QUOTE.LAST`. **PR.1 must prove `QUOTE.LAST.payload` carries one.** If it does not, the first cut is 7 codes and the plan does not change otherwise.

Family D is excluded entirely — `src/lib/blocks/` does not exist, so the chart compiler does not exist, and `SHAPE_BY_BLOCK` (`d-charts.ts:43-81`) has no consumer.

##### 1.3 The piece-type axis is a harder constraint than PR.0c assumes

`BLK-FINTABLE.piece_types = ['DEEP DIVE','NOTE']`, and `fit-engine.ts:166-172` maps `content_type ARTICLE → FEATURE`. So the workhorse financial table is **illegal on the workhorse content type**. PR.0c cannot fix this by swapping block keys.

Nor can it be fixed by re-typing earnings pieces as `NOTE`. Layout template `1b` (`docs/design/article-templates.json`, seeded into `ops.article_templates`) makes `rating_panel`, `valuation_bridge` and `risks_and_falsifiers` **required** regions; those are family B (`BLK-VERDICT`, `BLK-FALSIFY`) and family D — **41 of 61 renderers are absent and both those families are among them**. A NOTE is therefore not composable until PR.5, and neither is `BLK-FINTABLE`.

Checked against all four layouts:

| layout | piece type | composable in the first cut? |
|---|---|---|
| `1a` Feature long read | FEATURE | **yes** — every required `measure >` region maps to chassis prose, a C-family exhibit, or the footer |
| `1b` Research note | NOTE | no — required regions need families B and D |
| `3a` Sector deep dive | DEEP DIVE | no in practice — 4 required chapters × 3 required exhibits, and a single filing does not warrant one |
| `3b` Explainer | EXPLAINER | no — `hero_diagram` is family D; `BLK-TERM` is `requires_binding` against the glossary store, same non-lake trap |

**PR.4 composes `1a`/FEATURE only.** That is the honest scope, and it is stated up front so nobody discovers it at the end.

##### 1.4 The chassis is already in the database

`ops.article_templates.section_sequence` (`20260727143000_design_registry_schema.sql:120-133`) is an ordered region list with a `required` flag per region — for `1a`, 23 regions including `measure > opening_paragraph` (req), `measure > exhibit_1` (req), `measure > stat_strip` (opt), `measure > premium_cut` (req), `measure > method_disclosure_footer` (req). `premium_cut` for `1a` is `{present:true, falls_after:"…roughly two thirds through the argument"}`; `1b` is `{present:false, rule:"the whole note is premium"}`; `3b` is free.

This is not decoration — it is the outline. Compose fills a chassis; it does not invent a shape.

##### 1.5 What the consumers actually read

- `rules-stage.ts:101` reads `b.body?.text ?? ''`. A `BLK-*` payload has no `.text`, so R-03 and R-04 would see the empty string on every block and **pass vacuously**.
- `fit-engine.ts:151` `PROSE_FIELDS = ['text','body','prose','caption','note','standfirst','one_line_intent','intent']`. Measured over the 61 schemas: `body` appears in 3, `caption` in 16 (almost all family D), and `text`/`prose`/`note`/`standfirst`/`one_line_intent`/`intent` in **zero**. Over the 8 first-cut codes it matches **nothing at all**. `proseOf()` also reads top-level fields only.
- `src/lib/data/editorial.ts:191-197` returns `body.text ?? body.caption ?? null`; `src/lib/data/adapters/research.ts:84` **drops** any block with empty text. `BLOCK_RENDERERS` has exactly one importer outside `src/components/blocks/`: `src/app/styleguide/blocks/page.tsx:4-5`, against fixtures.

So without §3.15's companion changes, a correctly composed piece passes rules and fit **because nothing looked at it**, and renders as a blank article. A green pipeline that verified nothing is worse than a red one; the companion changes are not optional and they land in this PR.

##### 1.6 Write-path and grant reality

`20260720134217_p3_newsroom_grants.sql` gives the worker `select, insert, delete` on `public.content_blocks` — **no `update`**. Delete-then-insert inside one `sql.begin` with `set_config('app.principal_kind','agent')` (the `draft.ts:127-146` pattern) is the only legal write path, and `gated` can therefore only be set **at insert**. `public.content_blocks` needs no DDL: `block_kind text` is unconstrained, `body jsonb` is free, `bound_object_id uuid` and `gated boolean` already exist (`20260713000008_content.sql:93-103`).

`ops.pipeline_items.stage` has **no `compose` value** (`20260713000009_rules_pipeline.sql:81-82`) — and no `fit` value either: `worker/src/handlers/newsroom/fit-stage.sql` says in its own header that it is "WRITTEN, NOT APPLIED, AND NOT YET IN `supabase/migrations/`". PR.4 has nothing to hand off to until that is filed.

---

#### PR.4.2 Decisions

| # | decision | reason |
|---|---|---|
| **D-C1** | **Compose runs beside `draft.ts`, not instead of it.** New stage `compose` in `draft`'s slot (`queued → compose → edit`). The wire lane (`priority='wire'` ∨ `template_hint='TPL-01'`) keeps `draft.ts`. | TPL-01 is `max_words=40`, two blocks, no dek; composing it costs ~11 calls for a 40-word artefact a single call already produces. It is also the **only human-free path** (`auto_publish_wires` → `rules-stage.ts:78-87`, `fit.ts:95-105`, the DB gate `fn_enforce_agent_publish_gate`); changing its producer changes the risk profile of the one unattended lane. And a WIRE's natural vocabulary is family F, which has **zero renderers** — a composed wire is a `MissingBlock` where a sentence used to be. |
| **D-C2** | **The model never emits a uuid, a label, a column header or a cell coordinate.** Pass 2 emits a *selection* document over evidence keys; compose **materialises** the block payload. | This is the load-bearing decision, and it is the one the design as first drafted got wrong. D-8 binds values; it does not bind the labels, columns, names or order that give values meaning. `BLK-COMPARE.names[].ticker` and `.short_name` are free `z.string().min(1)`, and the only refinement (`c-tabular.ts:325-333`) checks `values.length === names.length` — nothing asserts that `metrics[i].values[j]` belongs to `names[j]`'s security. A model emitting Al Rajhi's `payload.pe` under a column headed `SABIC` uses two VERIFIED, resolvable, correctly-typed bindings and passes every check in the pipeline: `checkBinding` inspects only `bound_object_id` (`fit-engine.ts:362-396`), the prose carries no numeral, and the reader gets a fabricated peer comparison built entirely from real lake numbers. Same class: `BLK-STATSTRIP.cells[].label`, `BLK-RANKROW.rows[].rank`, `BLK-FINTABLE`'s row×period grid. Only compose knows the coordinate, so only compose may write it. |
| **D-C3** | **No schema narrowing, no uuid enums.** D-C2 makes the mechanism unnecessary. | The narrowing idea (rewrite `properties.object_id` to an enum of resolved ids) breaks two ways: an empty candidate set emits `enum: []`, unsatisfiable under `strict:true`; and `ObjectRef` is `z.strictObject({object_id})` (`binding.ts:76-80`) with **no** `field`, so injecting one into a node with `additionalProperties:false` makes the provider emit a key that the unnarrowed `strictObject` then rejects — firing on `BLK-PROV`, which appears under every exhibit. Removing the mechanism removes both failures. |
| **D-C4** | **The pass-2 contract is a compose-authored selection schema per code**, sent as `json: <object>` → `response_format: {type:'json_schema', strict:true}` (`gateway.ts:374-379`). The block's Zod schema is the **validator** after materialisation, never the generation contract. | `fit-engine.ts:727-761` already states this split ("Zod is the enforcer; `ops.story_blocks.payload_schema` is a projection"). It also means PR.4 has **no dependency at all** on the owner-gated `20260727161500` — stronger than "computes it in-process". |
| **D-C5** | **The outline is `ops.article_templates.section_sequence`.** Pass 1 chooses which optional regions to include and what fills each, not the shape. | Makes `FIT-CUT-UNPLACEABLE`/`FIT-CUT-MID-SENTENCE` structurally impossible (the cut is region 20 of `1a`, with required `exhibit_1` at region 12 above it and a paragraph at region 18 before it), and makes the composed piece match the rendered design reference rather than an invented shape. |
| **D-C6** | **Connective prose is chassis `text`/`heading`/`standfirst`/`disclaimer` blocks**, interleaved by the chassis. | `CHASSIS_KINDS` accepts them (`fit-engine.ts:142-146`); the reader reads `body.text`; R-03/R-04 read `body.text`. Without them the piece is checked by nothing and renders blank. |
| **D-C7** | **The numeral contract: block-payload prose carries no material numeral and no `[cN]`. Chassis prose may state a figure only by copying a frozen `printed` value, and only in a sentence carrying that fact's `[cN]`. Headline and dek carry no material numeral at all.** | Forced by the rules engine read together: R-03 blocks a numeral-bearing sentence with no marker (`rules.ts:64-66`), **and** R-04 blocks a marked sentence whose numerals do not include the marker's frozen value (`rules.ts:108-116`) **and** blocks any material numeral in a marked sentence not accounted for by that sentence's citations (`rules.ts:147-168`). The two directions together admit exactly one discipline. It also keeps `[c3]` out of `host_sentence`, which `interpolate` (`primitives.tsx:71-79`) would print verbatim on the page. |
| **D-C8** | **Compose owns template + `is_premium` + the cut + `word_count` + the R-01 disclaimer.** `edit.ts` skips template re-selection when `producer='compose'`. | A producer that does not know its template has no legal vocabulary. Today `edit.ts:42` picks the template *after* the writer wrote, and can flip TPL-03 → TPL-08 under a piece composed against TPL-03. `shared.ts:92-94` `wordCount()` over joined block payloads is meaningless. R-01 (`rules.ts:39-44`) returns `auto_fixed` and **writes nothing**. |
| **D-C9** | **Reuse the `writer` role** (`analyst_take` when `ops.templates.always_premium`). No new `AgentRole`. | `ingestion/src/llm/types.ts:21-27` is a closed union; adding a member touches `types.ts`, `roles.ts` DEFAULT_MODELS ×4 providers, DEFAULT_FALLBACKS and env keys. Both roles are pinned `supports_structured_output=true` (verified 2026-07-27). |
| **D-C10** | **Repair budget: 2 per block. Fuse derived from the outline: `1 + 3×|outline| + 2`.** Never a fallback block, never a silent trim. | A fixed 40-call fuse is smaller than the budget it is supposed to bound — a 14-entry outline repairing every block is 43 calls, so `MAX_BLOCK_REPAIRS=2` could never actually be spent and the fuse would fire mid-outline, converting an actionable block-level refusal into `CMP-BUDGET-FUSE` with nothing said about the blocks never attempted. A derived fuse cannot contradict the per-block budget. |
| **D-C11** | **Compose runs `runFit()` in-process as a pre-flight** before the transaction opens. | `runFit()` is pure and I/O-free by its own header. The producer validating against the consumer's own engine makes "survives fit" true by construction at zero marginal cost. |
| **D-C12** | **Candidate bindings are filtered to `state='VERIFIED'` at the gate**, dropped PENDING facts recorded. | `fit-engine.ts:385-395` refuses any non-VERIFIED bound object, while `ops.materiality_prefilter.accepted_states = {VERIFIED,PENDING}` for `FILING.FINANCIALS`. Refuse in compose with one readable reason rather than at fit with N block-level codes that read as "compose is broken". |
| **D-C13** | **`bound_object_id` = the first binding in document order; one `lake.citations` row per distinct object per block**, `block_key='s{seq}:{k}'`, `claim_key='c{N}'` piece-global per object. | `citations_uni` is `(content_id, object_id, coalesce(block_key,''))` (`20260713000008_content.sql:146`). Keying by claim alone silently drops the second row. |

---

#### PR.4.3 The design

##### 3.1 Stage graph

```
classify ─┬─ (wire lane)  draft ──┐
          └─ (story lane) compose ┴─ edit ─ rules ─┬─ fit ─ approval ─ published
                                                   └─ (blocked) → producer
                                    compose ─(refusal)→ reassigned_human
```

`rules-stage.ts:60-61` loops back to `draft` unconditionally. Nothing records which producer made the piece → add `ops.pipeline_items.producer`. `MAX_RULES_LOOPS` stays 2 for draft; **compose caps at 1** (a re-roll is 1 + 3N calls, not one).

##### 3.2 Two migrations, in order

**(a) `supabase/migrations/<ts>_newsroom_fit_stage.sql`** — a straight `git mv` of `worker/src/handlers/newsroom/fit-stage.sql`. Without it `fit` is not a legal stage and PR.4 has nothing to hand off to.

**(b) `supabase/migrations/<ts+1>_newsroom_compose_stage.sql`:**

```sql
begin;

alter table ops.pipeline_items drop constraint if exists pipeline_items_stage_check;
alter table ops.pipeline_items add constraint pipeline_items_stage_check
  check (stage = any (array['queued','draft','compose','edit','rules','fit','approval',
                            'published','sent_back','reassigned_human','dead']));

alter table ops.pipeline_items
  add column if not exists producer text not null default 'draft'
  check (producer in ('draft','compose'));

-- Supersedes (a)'s fn_transition; keeps every existing arm so the switch can go off again.
--   queued  → draft|compose|dead        draft   → edit|dead|reassigned_human
--   compose → edit|dead|reassigned_human edit   → rules|dead|reassigned_human
--   rules   → fit|approval|published|draft|compose|reassigned_human|dead
--   fit     → approval|published|draft|compose|reassigned_human|dead
--   approval→ published|sent_back|reassigned_human   sent_back → draft|compose
create or replace function ops.fn_transition(...) ...;

insert into iam.global_switches (key, value) values ('newsroom_compose_stage', false)
on conflict (key) do nothing;

-- The exact payload path a citation's quoted_value was frozen from. rules.ts:118-125 names this
-- as the real fix for DEF-RULES-R04-LAKE-DRIFT: findPayloadMagnitude currently guesses the
-- payload leaf NUMERICALLY NEAREST the cited value, which blocked every citation in both real
-- drafts by matching a fiscal year against a profit.
alter table lake.citations add column if not exists quoted_field text;

create table if not exists ops.compose_reports (
  id               bigserial primary key,
  pipeline_item_id bigint not null references ops.pipeline_items(id) on delete cascade,
  content_id       uuid   not null references public.content_items(id) on delete cascade,
  passed           boolean not null,
  template_key     text,
  layout_id        text,          -- ops.article_templates.id: '1a' | '1b' | '3a' | '3b'
  piece_type       text,
  outline          jsonb not null default '[]'::jsonb,   -- pass-1 output, verbatim
  evidence         jsonb not null default '{}'::jsonb,   -- counts, withheld_pending[],
                                                         -- unaddressable_fields[], dropped_rows/cols[]
  refusals         jsonb not null default '[]'::jsonb,
  repairs          jsonb not null default '[]'::jsonb,
  dry_run_fit      jsonb not null default '{}'::jsonb,   -- the full FitReport
  llm              jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index compose_reports_item on ops.compose_reports (pipeline_item_id, created_at desc);
create index compose_reports_open on ops.compose_reports (created_at desc) where not passed;

grant select, insert on ops.compose_reports to marsad_worker;
grant usage, select on sequence ops.compose_reports_id_seq to marsad_worker;
grant select on ops.story_blocks, ops.templates, ops.article_templates to marsad_worker;  -- idempotent

commit;
```

Then `node scripts/check-migration-ledger.mjs --write` **in the same commit** — the exact trap `fit-stage.sql` fell into.

The handler is deployable before either migration is applied: `switchOn()` reads a missing key as `false` (`shared.ts:26-29`), and `ops.compose_reports` is `to_regclass`-probed before every write (`fit.ts:218-222` is the pattern).

##### 3.3 The evidence seam — `ComposeEvidence` (**PROVISIONAL**)

> Reconciled with PR.1 **only** through `worker/src/handlers/newsroom/evidence.ts::toComposeEvidence()`. Nothing else in compose imports a PR.1 type. If PR.1's envelope differs, this adapter changes and `compose-engine.ts` does not.

PR.1's stated `{object_id, field, value, as_of}` is necessary but not sufficient — compose cannot place a fact on a grid without knowing its coordinate.

```ts
/** PROVISIONAL — the minimum compose needs from a PR.1 bundle. */
export interface ComposeFact {
  object_id: string;                       // lake.objects.id, strict RFC-4122 v4 (binding.ts:39-41)
  field: string;                           // dotted path, /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/
  value: number | string | null;
  as_of: string | null;

  object_type: string;                     // 'FILING.FINANCIALS' | 'COMPUTED.RATIOS' | …
  state: 'VERIFIED' | 'PENDING';
  unit: 'pct' | 'frac' | 'x' | 'ratio' | 'days' | 'date' | string | null;  // scale, not decoration
  label: string;                           // 'FY25 revenue' — the marker table + the materialised label
  security_id: number | null;              // the COLUMN coordinate for multi-name blocks
  row_key: string | null;                  // the ROW coordinate ('revenue', 'pe')
  col_key: string | null;                  // the COLUMN coordinate ('FY25', security ticker)
  polarity: 'higher_better' | 'lower_better' | null;   // lets compose derive rank / best_index
}

export interface ComposeFactGroup {
  ref: string;                             // slug [a-z0-9_]{2,32}, e.g. 'ratios_now', 'peers_pe'
  kind: 'ratio_set' | 'statement_series' | 'score' | 'quote' | 'peer_set'
      | 'filing_ref' | 'conflict_pair' | 'misc';
  title: string;
  facts: ComposeFact[];                    // document order
  rows: string[]; cols: string[];          // the declared matrix axes (may be 1×N)
}

export interface ComposeEvidence {
  security_id: number | null;
  trigger_object_id: string;
  as_of: string;
  groups: ComposeFactGroup[];
  absences: Array<{ looked_for: string; why_absent: string }>;   // PR.2's "what I did NOT find"
}
```

**`unit` is load-bearing, not metadata.** `parseMagnitude` does not scale percents (`text.ts:97-110`), while `COMPUTED.RATIOS` may store `dividend_yield` as `0.0525` for a printed `5.25%`. Get that wrong and R-04's lake-drift arm compares `5.25` against whatever payload leaf is numerically nearest — `roe: 5.1` gives `relDiff = 0.027`, inside `(DRIFT_TOL, LAKE_DRIFT_MAX]`, and **blocks the piece**. A fact whose `unit` is null may be bound but **may not be printed in prose**; compose records `CMP-UNIT-UNKNOWN` as a warning.

**Escape hatch, so PR.1 is not gated on this.** If PR.1 ships without `object_type`/`state`/`unit`/`security_id`, `toComposeEvidence()` fills them with **one** query over the id set (≤200 ids), never per fact:

```sql
select id::text, object_type, state, unit, effective_date, security_id
  from lake.objects where id = any($1::uuid[])
```

`row_key`/`col_key`/`polarity` are the two things the adapter genuinely cannot synthesise. Without them compose degrades to single-fact blocks only (`BLK-STATSTRIP`, `BLK-DELTA`, `BLK-TICKER`) and drops the grid blocks with `CMP-EVIDENCE-THIN`. It never guesses a coordinate.

##### 3.4 Pass 0 — chassis, piece type, vocabulary

`compose.ts` does I/O; `compose-engine.ts` is pure.

1. `loadItem()`; guard `item.stage !== 'compose'` → no-op (idempotent redelivery).
2. `outputHalted(sql)` → leave in place. `budgetState(sql)`: `'halted'` → park (compose is never the wire lane, so `draft.ts:72`'s carve-out does not apply); `'degraded'` → `budgetDegraded: true` on every call.
3. **Template** — `selectTemplateForCompose(triggerObjectType, bundleKinds, item.template_hint)`, deterministic, keyed off the trigger and the bundle rather than citations (which do not exist yet). Load the `ops.templates` row.
4. **Piece type** — `resolvePieceType(content_type, template_key)` **imported from `fit-engine.ts:175-178`**, the same function fit will use, so the two cannot disagree. `agent_authored` is true (`classify.ts:95` sets `author_id` to the `DATA-FILINGS` agent principal) → the set is `{primary, 'AI'}`.
5. **Layout** — `select id, piece_type, section_sequence, premium_cut, hard_rules from ops.article_templates where piece_type = $1`. Absent → `CMP-LAYOUT-UNRESOLVED`. First cut refuses anything but `1a`, naming the required regions it cannot fill (`CMP-LAYOUT-UNFILLABLE`).
6. **Registry** — `select key, status, family, piece_types, requires_binding, binds_to, constraints from ops.story_blocks`.
7. **The vocabulary** =
   `{status='active'}` ∩ `{piece_types ∋ 'ALL' ∨ ∩ pieceTypeSet ≠ ∅}` ∩ `{ops.templates.block_keys}` ∩ `FIRST_CUT_CODES` ∩ `{family ≠ 'D'}` ∩ `{the bundle can supply every required binding site}`.
   The `ops.templates` intersection is **skipped with a warning** while the row still names legacy keys — but a template that names only legacy keys yields `CMP-VOCAB-EMPTY`, which is PR.0c not having landed and should read that way.
8. **Evidence** — `toComposeEvidence(await loadBundle(sql, item))`.
9. **Rules feedback** on loop re-entry: `select rule_key, detail from ops.rule_violations where content_id = $1 and outcome='blocked' order by id desc limit 10`.

##### 3.5 Pass 1 — the outline over the chassis

One call. Role `writer` (or `analyst_take` when `always_premium`). `purpose: 'compose:outline:${template}:${triggerType}'`. The user message carries the region list with `required` flags, the group `ref`/`kind`/`title`/axis sizes, the `absences[]` verbatim, and the piece's trigger.

```jsonc
{ "type":"object","additionalProperties":false,
  "required":["headline","dek","regions"],
  "properties":{
    "headline":{"type":"string","maxLength":90},
    "dek":{"type":["string","null"],"maxLength":220},
    "regions":{"type":"array","minItems":1,"maxItems":23,
      "items":{"type":"object","additionalProperties":false,
        "required":["region","why_here","fill"],
        "properties":{
          "region":{"enum":["measure > standfirst_bullets","measure > opening_paragraph", …]},
          // ORDER MATTERS: reasoning precedes the answer (09 §5.5, ":665-666").
          "why_here":{"type":"string","maxLength":200},
          "fill":{"enum":["prose","heading","omit",
                          "BLK-TICKER","BLK-DELTA","BLK-STATSTRIP",
                          "BLK-RANKROW","BLK-COMPARE","BLK-CONFLICT"]},
          "evidence_ref":{"enum":["ratios_now","peers_pe", …]},   // the bundle's group slugs
          "one_line_intent":{"type":"string","maxLength":160},
          "word_budget":{"type":"integer","minimum":15,"maximum":220}
        }}}}}
```

The model **never types a uuid**: it names a group slug. Deterministic post-validation, all pure:

| check | on failure |
|---|---|
| every required region present and not `omit` | `CMP-OUTLINE-REGION` |
| `fill` legal for that region (a static region→kind map) | `CMP-OUTLINE-REGION` |
| `evidence_ref` ∈ `groups[].ref`, and its `kind` compatible with the code | `CMP-OUTLINE-EVIDENCE` / `CMP-OUTLINE-MISMATCH` |
| **every block in `LITERAL_NUMERIC_FIELDS` carries an `evidence_ref`** (not just `requires_binding` blocks) | `CMP-OUTLINE-UNBOUND` |
| `ONE PER PIECE` constraints from `ops.story_blocks.constraints` | `CMP-OUTLINE-DUPLICATE` |
| Σ `word_budget` ≤ `ops.templates.max_words` | rescale proportionally — deterministic, not a refusal |
| every `block_code` ∈ the enum (belt-and-braces: Anthropic has no `response_format`, `gateway.ts:393-397`) | `CMP-OUTLINE-CODE` |

`LITERAL_NUMERIC_FIELDS: Record<BlockCode, string[]>` is a new explicit map in `ingestion/src/blocks/` naming every schema field that **prints a number without a binding** — today `BLK-DELTA.magnitude` (`z.string().min(1)`, "Magnitude with its unit, as printed — e.g. `110 bp`", `a-inline.ts:66-70`) and `BLK-RANKROW.rows[].rank`. `BLK-DELTA` is family A with `binds_to: null`, so the seed heuristic (`requiresBinding = Boolean(binds_to) || family C || D`) makes `requires_binding=false`, `checkBinding` returns immediately, and **nothing** would check it — while `BlockDelta.tsx:25-27` renders `magnitude` through `<Val>` in mono/tabular-nums, the slot whose entire purpose is "this came from the lake". Membership in this map must never be decided by omission from a prose-field allowlist.

There is **no repair round on the outline**. The outline is the editorial judgement; a model that picked illegal regions from a 9-value enum will not be repaired into good judgement, and the Desk needs to see the attempt.

##### 3.6 The gate between the passes — pure, no LLM

Per region with an `evidence_ref` (09 §5.5: "validate … BEFORE pass 2 runs"):

1. **Expand** the group.
2. **State filter** — drop `state !== 'VERIFIED'` (D-C12) → `evidence.withheld_pending[]`.
3. **Field-path filter** — drop any `field` failing `binding.ts:52`'s regex → `evidence.unaddressable_fields[]`. Real, not theoretical: 36,328 of 36,330 `FILING.FINANCIALS` bindings are `payload.line_items.<key>`.
4. **Resolution check** — one query, then `resolveFieldPath(row, field)` must return non-null:
   `select id::text, object_type, state, unit, effective_date, numeric_value, payload from lake.objects where id = any($1::uuid[]) and state='VERIFIED' and superseded_by is null`.
   The bundle's cached `value` may be stale; the live row wins.
5. **Rectangularise** — for a matrix group, drop whole rows or whole columns until the surviving matrix is complete, recording `evidence.dropped_rows[]` / `dropped_cols[]`. This is why the axis sizes are **recomputed after the drops, never carried from the bundle**: `BLK-FINTABLE`'s refinement requires `row.values.length === periods.length` for every row (`c-tabular.ts:117-131`), so a ragged survivor is unsatisfiable by *any* payload — 2 repairs and a refusal for a hole the gate could have closed. The same discipline applies to `BLK-COMPARE`'s `values.length === names.length` (`c-tabular.ts:325-333`).
6. **Thinness gate over required binding sites**, not `minItems` — walk the emitted JSON Schema counting `ObjectBinding`/`ObjectRef` nodes at their minimum arity (the `carriesObjectBinding` predicate, `ingestion/src/blocks/index.ts:165-172`). A block with **zero** candidates for any required site is dropped with `CMP-EVIDENCE-THIN` before pass 2. `minItems` would have missed exactly the blocks that hit this: `BLK-ESTIMATE`'s `actual.value`/`estimate.value` are single bindings, not arrays. If dropping leaves a required region unfilled or < 1 data block above the cut → refuse.
7. **Re-run the §3.5 structural checks over the post-drop outline.** With 487 of 762 securities carrying `sector='unknown'`, thin peer sets — and therefore dropped `BLK-COMPARE`/`BLK-RANKROW`, both C-family — are the expected case. Cheap deterministic checks are the last thing before spend, not the first thing after generation.
8. **Freeze the marker table** — assign `c1…cN` over the distinct surviving `object_id`s in document order:

```ts
{ key:'c3', object_id:'…', label:'FY25 revenue', field:'payload.line_items.revenue',
  printed:'SAR 12.4bn', resolved: 12_400_000_000, unit:'SAR',
  as_of:'2025-12-31', object_type:'FILING.FINANCIALS' }
```

`printed = formatBound(resolved, unit, object_type)`, and compose **asserts `relDiff(parseMagnitude(printed), resolved) <= DRIFT_TOL`** before the citation is written. A `printed` that does not round-trip through `parseMagnitude` is a refusal (`CMP-PRINTED-ROUNDTRIP`), not a warning — `quoted_value` feeds R-04 (`rules.ts:87-174`) and `reachableValues` (`fit-engine.ts:414-415`), and a null or unparseable `quoted_value` makes R-04's `citedMag === null` branch **skip silently**, which reads as a pass.

##### 3.7 Pass 2 — selection, then materialisation

One constrained call per outline entry. Two shapes only.

**Block entry — a selection document, never a payload.** Example, `BLK-COMPARE`:

```jsonc
{"type":"object","additionalProperties":false,
 "required":["reasoning","names","metrics"],
 "properties":{
   "reasoning":{"type":"string","maxLength":300},
   "names":{"type":"array","minItems":2,"maxItems":4,
            "items":{"enum":["1120","2010","2222"]}},        // surviving col_keys, in the model's order
   "metrics":{"type":"array","minItems":1,"maxItems":8,
     "items":{"type":"object","additionalProperties":false,
       "required":["row_key"],
       "properties":{"row_key":{"enum":["pe","pb","roe","dividend_yield"]},
                     "best_index":{"type":"integer","minimum":0,"maximum":3}}}}}}
```

The model chooses **which** facts and in **what order**. Compose then materialises:

```ts
export interface PlacedBinding { path: string; object_id: string; field: string; fact: ComposeFact }
export type Materializer =
  (selection: unknown, ctx: MaterializeCtx) => { payload: unknown; bindings: PlacedBinding[] };
export const MATERIALIZERS: Record<FirstCutCode, Materializer>;
```

Each materialiser writes labels **and** bindings together from the same fact — `names[j].ticker`/`short_name` and every `metrics[i].values[j]` come from the fact at `(row_key_i, col_key_j)`, so a column header and the number under it cannot come from different securities. `BLK-RANKROW.rows[].rank` and `BLK-COMPARE.metrics[].best_index` are **derived** from the resolved values and `polarity`, overwriting anything the model emitted; where `polarity` is null, `best_index` stays model-supplied and is recorded in `evidence.model_judgements[]`. A bare integer rank is invisible to every numeral check by construction (`isMaterialNumeral` returns false for a unitless integer < 1000, `text.ts:71-77`), so it must be derived or it is unchecked forever.

`houseHeaders`/`houseLabel` fields (`binding.ts:154-174`) are never in a selection schema — they are pinned literals with defaults, and compose supplies them.

**Prose entry:**

```jsonc
{"type":"object","additionalProperties":false,"required":["reasoning","text","markers"],
 "properties":{"reasoning":{"type":"string","maxLength":300},
               "text":{"type":"string","pattern":"^\\s*(?:\\S+\\s+){0,<budget-1>}\\S+\\s*$"},
               "markers":{"type":"array","items":{"enum":["c1","c2", …]}}}}
```

The word cap is a `pattern`, so the **provider** enforces it during generation rather than us discovering the overrun after paying for the tokens (`wordCapped`, `binding.ts:184-191`). Persisted as `block_kind='text'`, `body={text}`.

The user message carries: the `one_line_intent`; the marker table restricted to this entry's candidates with `printed` values; the axis labels; the headline/dek; the preceding prose marked "context, do not restate".

`FILL_SYSTEM`, the standing rules:
- *"You select facts by key. You never type a number, a ticker, a column header or a uuid."*
- *"A figure may appear in prose only as its exact `printed` form, and only in a sentence carrying that fact's `[cN]`."*
- *"`is_change`, `is_base`, `is_estimate` and, where you are told polarity is unknown, `best_index` are your judgement and stay literal — the lake does not know which direction a metric points"* (the `c-tabular.ts:1-11` rule, restated to the model).

**Token sizing.** `gateway.ts:41` `DEFAULT_MAX_TOKENS = 1024`. A selection document is far smaller than a payload — a 10-row rank selection is 10 enum members, not 20 uuids — but size it anyway: `clamp(768, 512 + 8*sites + 6*words, 4000)`.

##### 3.8 Post-parse checks and the bounded repair loop

After each pass-2 call, cheapest first, over the **materialised** payload:

| # | check | code |
|---|---|---|
| 1 | `BLOCK_PAYLOAD_SCHEMAS[code].safeParse(payload)` — the Zod schema, which catches the 8 cross-field refinements JSON Schema cannot express | `CMP-PAYLOAD-SCHEMA` |
| 2 | every `object_id` in the payload ∈ the block's resolved set — the closed-set check of `draft.ts:104-112`, extended to **walk the payload recursively** rather than read a flat map | `CMP-BIND-FOREIGN` |
| 3 | every `(object_id, field)` **pair** ∈ the resolved pair set | `CMP-BIND-FIELD` |
| 4 | **coordinate**: for every `PlacedBinding`, `fact.col_key` equals the label materialised at that column and `fact.security_id` equals the security named at that column | `CMP-BIND-COORDINATE` |
| 5 | array lengths equal the **post-gate** axis sizes | `CMP-CARDINALITY` |
| 6 | no material numeral and no `[cN]` in any collected block-payload prose field | `CMP-NUMBER-IN-BLOCK-PROSE` |
| 7 | every material numeral in a chassis prose block equals a frozen `printed` value of a marker in the **same sentence**, within `DRIFT_TOL`; every marker in that sentence has its value present | `CMP-NUMBER-UNSOURCED` / `CMP-NUMBER-MISMATCH` |
| 8 | every `LITERAL_NUMERIC_FIELDS` value equals a frozen `printed` value from that block's marker table | `CMP-NUMBER-UNBOUND-LITERAL` |

Checks 6–8 reuse `numberTokens`/`isMaterialNumeral`/`parseMagnitude`/`relDiff` exported from `marsad-ingestion` — the identical primitives `fit-engine.ts:466-528` and `rules.ts` use, because a second definition of "what is a number" is how DEF-RULES-R04-REGEX happened.

**Repair:** one round-trip per block appending the concrete issues plus the marker table again. `MAX_BLOCK_REPAIRS = 2` → at most 3 calls per block. Third failure → refuse the piece naming block code, region, seq and the issue list. **Never substitute a fallback block** — the closed-vocabulary property is only true if the enforcement point refuses.

**The `LlmJsonError` trap.** `gateway.ts:111-115` **re-throws** without falling through to the next provider, and the gateway's own single repair round-trip is already spent inside `callTargetOnce`. So each pass-2 call is wrapped in its own `try`; on `LlmJsonError` the entry is retried once at our level (a fresh call ⇒ a fresh gateway repair budget), then the piece routes to `reassigned_human` with the entry named, mirroring `draft.ts:91-97`. `LlmUnavailableError` is **not** a refusal — the handler returns without transitioning and the pgmq message redelivers.

##### 3.9 Assembly and the in-process fit pre-flight

`assemble()` builds the exact `FitInput` shape `fit.ts:122-204` would read from the DB, from memory, then:

```ts
const dryRun = runFit({ content_id, content_type, template_key, is_premium, word_count,
                        agent_authored: true, premium_cut_after_block,
                        blocks, citations, registry, pipelineTemplate, layoutTemplate });
```

Block-attributable refusals (`FIT-PAYLOAD-SCHEMA`, `FIT-CONSTRAINT-*`, `FIT-NUMBER-*`, `FIT-BIND-*`) feed one more repair on that block if its budget is unspent; the rest refuse the piece as `CMP-FIT-DRYRUN` carrying the whole `FitReport`. `dryRun.warnings` and `dryRun.unchecked` are stored, not acted on.

The property worth stating plainly: **a piece that leaves compose has already been judged by the same engine that will judge it at fit.** The only things that can change in between are the object states in `lake.objects` and the headline `edit.ts` rewrites — and §3.12 closes the second.

##### 3.10 Citations — the exact write

Per **distinct object per block** (never per binding — `BLK-EXDATE` binds one declaration under four fields, `c-tabular.ts:252-274`):

| column | value |
|---|---|
| `content_id` | the piece |
| `object_id` | the lake object |
| `block_key` | `` `s${seq}:${k}` `` — unique by construction, which is what `citations_uni` demands |
| `claim_key` | the piece-global `` `c${N}` `` — what `markersIn()` finds and what R-04 and `reachableValues` join on |
| `claim_text` | the entry's `one_line_intent`. **This is where 09 §5.5's orphan field finally lands** — it is in fit's `PROSE_FIELDS` but exists in no block schema, so today it is persisted nowhere |
| `quoted_value` | the frozen `printed` string for that object's primary field in that block. Never null |
| `quoted_field` | the dotted path it was frozen from (new column) |
| `cited_by` | the writer principal |

`bound_object_id` on the block = the object at `k=0`. Every `requires_binding` block therefore has a binding **and** a matching citation — `FIT-BIND-MISSING` and `FIT-BIND-UNCITED` satisfied by construction. Note the insert trigger bumps `lake.objects.cited_count` (`20260713000008_content.sql:150-162`), so delete-then-insert decrements and re-increments; correct, and worth knowing before someone reads the counter mid-transaction.

##### 3.11 The four things nothing else will own

- **`word_count`** — computed over the prose compose emitted: every chassis `text`/`heading`/`standfirst`/`disclaimer` `body.text`, plus every declared prose field of every block payload at any depth. Written to `content_items.word_count`, which `fit.ts:124` reads and `fit-engine.ts:316-321` checks against `max_words`.
- **The premium cut** — the `1a` chassis puts it at region 20. Compose sets `gated=true` on every block after it **at insert time** (there is no `update` grant) and writes `premium_cut_after_block` so the two surfaces agree (`FIT-CUT-INCONSISTENT`, `:807`, is a warning otherwise). Emitting `BLK-CUT` alone does nothing — fit never reads `after_block_index` from its payload (`h-gates.ts:28-45`); **the `gated` column is the gate**, and family H has no renderer anyway.
- **`template_key` / `is_premium`** — written in compose's transaction; `edit.ts` gains `if (item.producer === 'compose')` and keeps them.
- **The R-01 disclaimer** — `rules.ts:39-44` returns `auto_fixed` and performs no write; the only reader is `rules-stage.ts:120`. Compose appends it as the final chassis block. One row, and it closes a rule that currently self-reports as fixed while doing nothing.

##### 3.12 The transaction

Copied from `draft.ts:127-146` with the payload changed:

```ts
const inserted = await sql.begin(async (tx) => {
  await tx`select set_config('app.principal_id',   ${writerId}, true)`;
  await tx`select set_config('app.principal_kind', 'agent',     true)`;
  await tx`update public.content_items
              set headline=${headline}, dek=${dek}, word_count=${wc},
                  template_key=${template}, is_premium=${isPremium},
                  premium_cut_after_block=${cutAfterSeq}, updated_at=now()
            where id = ${item.content_id}::uuid`;
  await tx`delete from public.content_blocks where content_id = ${item.content_id}::uuid`;
  await tx`delete from lake.citations     where content_id = ${item.content_id}::uuid`;
  let nb = 0, nc = 0;
  for (const b of blocks) {                       // seq 1-based, dense, document order
    await tx`insert into public.content_blocks (content_id, seq, block_kind, body, bound_object_id, gated)
             values (${item.content_id}::uuid, ${b.seq}, ${b.block_kind}, ${sql.json(b.body)}::jsonb,
                     ${b.bound_object_id}::uuid, ${b.gated})`; nb++;
  }
  for (const c of citations) {
    await tx`insert into lake.citations (content_id, object_id, block_key, claim_key,
                                         claim_text, quoted_value, quoted_field, cited_by)
             values (${item.content_id}::uuid, ${c.object_id}::uuid, ${c.block_key}, ${c.claim_key},
                     ${c.claim_text}, ${c.quoted_value}, ${c.quoted_field}, ${writerId}::uuid)`; nc++;
  }
  if (nb !== blocks.length || nc !== citations.length)
    throw new Error(`compose: wrote ${nb}/${blocks.length} blocks, ${nc}/${citations.length} citations`);
  return { nb, nc };
});
await writeComposeReport(sql, item.id, report);      // to_regclass-probed
await transition(sql, item.id, 'edit', writerId, { headline, word_count: wc, blocks: inserted.nb });
await enqueueStage(sql, 'pipeline_edit', item.id);
```

Only `content_items` (update), `content_blocks` and `lake.citations` (insert/delete) — inside the grant envelope.

##### 3.13 Refusal taxonomy — all → `reassigned_human`, all carrying evidence

`CMP-EVIDENCE-EMPTY` · `CMP-EVIDENCE-PENDING` (names the objects, so the Desk reads "not verified", not "compose is broken") · `CMP-EVIDENCE-THIN` (warning; refusal only when a required region or the last data block goes) · `CMP-UNIT-UNKNOWN` (warning) · `CMP-TEMPLATE-UNRESOLVED` · `CMP-LAYOUT-UNRESOLVED` · `CMP-LAYOUT-UNFILLABLE` · `CMP-VOCAB-EMPTY` · `CMP-OUTLINE-{REGION,CODE,EVIDENCE,MISMATCH,UNBOUND,DUPLICATE}` · `CMP-PRINTED-ROUNDTRIP` · `CMP-PAYLOAD-SCHEMA` · `CMP-BIND-{FOREIGN,FIELD,COORDINATE}` · `CMP-CARDINALITY` · `CMP-NUMBER-{MISMATCH,UNSOURCED,IN-BLOCK-PROSE,UNBOUND-LITERAL}` · `CMP-LLM-JSON` · `CMP-BUDGET-FUSE` (carries the block that consumed the last repair **and** the list of regions never attempted) · `CMP-FIT-DRYRUN`.

##### 3.14 Cost

| lane | calls | note |
|---|---|---|
| wire (`draft.ts`, unchanged) | 1 | ~$0.00085 measured |
| story, `1a` with 6 prose + 3 exhibits + 2 inline, no repairs | 12 | 1 outline + 11 fills |
| story, worst case | `1 + 3×|outline| + 2` = 38 at 12 entries | the derived fuse |

Every call carries `runContext.{agentId, pipelineItemId, purpose}` (mandatory, `gateway.ts:59-64`) and lands an `ops.llm_runs` row via `finalizeRun` (`:529-555`); `purpose` is `compose:outline:*` / `compose:fill:*:*`, so per-block spend is queryable without new plumbing. Per-piece cost is **not** 12 × $0.00085: prose calls are smaller than draft's 2,500-token call and selection calls carry a larger prompt. Treat ~$0.005–0.015/piece as an estimate and replace it with the measured `ops.llm_runs` sum after the first ten pieces.

##### 3.15 Companion changes that land WITH PR.4

**(a) The shared prose-field contract — highest severity.** `ingestion/src/blocks/prose-fields.ts` exports `BLOCK_PROSE_FIELDS` and a **recursive** `collectProse(payload): string[]`. Membership = `CHASSIS_PROSE_KEYS` **∪** schema-derived. The chassis keys `{text, body, caption, prose, note, standfirst, dek, one_line_intent, intent}` are seeded **unconditionally**: they appear in zero of the 61 schemas, so a set derived only from the schemas would make `proseOf()` return `[]` for every chassis `text` block — blinding `checkNumbers` to the argument prose (so `numerals_checked > 0` could be satisfied by block payloads alone) **and** making `endsCompleteThought` return `null` for every block, so `FIT-CUT-MID-SENTENCE` can never fire and `legal()`'s ends-thought walk falls through to `return false` at every index, refusing `FIT-CUT-UNPLACEABLE` on any piece whose layout requires a cut. That regression would be introduced by PR.4 in the same commit that creates the surface it blinds.

Consumers: `fit-engine.ts:151` `PROSE_FIELDS`/`proseOf` → `collectProse`; `rules-stage.ts:101` → `[b.body?.text, ...collectProse(b.body)].filter(Boolean).join(' ')`. A test walks `z.toJSONSchema(schema,{io:'input'})` for all 61 and asserts every string property not on an explicit `NON_PROSE_ALLOWLIST` (`ticker_code`, `glossary_key`, `label`, `title`, `unit`, `venue`, `name`, `term`, `kicker`, `rule_id`, `format`, …) is covered, **and** that the chassis keys are present. `magnitude` is not decided here — it is in `LITERAL_NUMERIC_FIELDS`, by name, because a safety property decided by omission from an allowlist is decided by a coin flip.

**(b) The binding resolver.** Nothing in the repo reads a dotted path off `lake.objects`; `src/components/blocks/types.ts` declares `BoundValue = string | null`, i.e. the renderers take already-resolved values.
- `ingestion/src/blocks/resolve.ts` — `resolveFieldPath(row, path)` + `formatBound(value, unit, objectType)`, pinned so `parseMagnitude(printed)` round-trips to the source scale.
- `src/lib/blocks/resolve.ts` — the reader's copy. The Next app does **not** depend on `marsad-ingestion` (no such entry in `package.json`), and adding a `file:` TS dependency to the Vercel build is a worse risk than a 20-line duplicate.
- `docs/design/fixtures/binding-resolution.json` — one fixture, a test on each side asserting identical output. Name the duplication and pin it; do not pretend it is not one.

D-8 forbids storing the resolved number in `content_blocks.body`, so both copies are genuinely needed.

**(c) R-04's drift arm reads `quoted_field`.** `findPayloadMagnitude` (`rules.ts:177-185`) returns whatever payload leaf is numerically nearest the cited value; the comment at `:118-125` records it "blocking every citation in both real drafts". With `quoted_field` present, r04 reads the exact path and only falls back to the nearest-leaf probe when it is null. Note the arm is currently *inert* for `FILING.FINANCIALS` — the figures are nested under `payload.line_items` while `findPayloadMagnitude` iterates `Object.values(payload)` at the top level only — but it is live and dangerous for `COMPUTED.RATIOS`, whose payload is flat (`pe`, `pb`, `roe`, `net_margin`, …). Composed pieces cite ratios constantly.

**(d) `edit.ts` headline guard.** When `producer='compose'`: keep `template_key`/`is_premium`, and **reject a rewritten headline containing any material numeral**, keeping the original. R-04's headline arm accepts a headline magnitude within 0.5% of *any* citation's `quoted_value` with no attribution check (`rules.ts:93-103`), and compose writes one citation per distinct object per block — 20–40 on a real piece, so a peer's P/E and a prior-year figure become legal headline numbers for the subject company. *One objection here is partly wrong: the headline is not unjudged. `edit.ts` runs before `pipeline_rules`, so R-04's headline arm does see the rewrite; what is too wide is its acceptance set, and the fix belongs at `edit.ts`. Adding `headline`/`dek` to `FitInput` is therefore not adopted — it would duplicate a check that already runs, on every draft-produced piece too.*

**(e) The reader dispatch (PR.4b — same PR, separate commit).** `src/lib/blocks/toBlockNode.ts`: `(block_kind, body, resolvedValues) → AnyBlockNode`. The payload shapes are **not** the same on both sides and this adapter is where that is reconciled: stored `BLK-TICKER` is `{host_sentence, ticker_code, quote:{object_id,field}}` (`a-inline.ts:37-51`) while `TickerPayload` wants `{hostText, tickers:[…]}` with `{0}` slot markers; stored `BLK-DELTA` is one delta while `BlockDelta` reads `{hostText, deltas[]}`. Plus `src/lib/blocks/markers.ts`, rendering `[cN]` in chassis prose as a citation chip and a footnote list — otherwise `[c3]` prints literally on the page. Then `ArticleView` dispatches through `BlockList` with `MissingBlock` for the rest.

---

#### PR.4.4 Build order

Each step is independently verifiable with `npx tsc --noEmit`, `npx eslint <paths>` and `npx tsx --test "src/**/*.test.ts"` in the package it touches. GitHub Actions is billing-blocked; local gates and Vercel are the real verification.

| step | does | verified by |
|---|---|---|
| **PR.4a** | `git mv` `fit-stage.sql` → `supabase/migrations/`; write the compose migration; `check-migration-ledger.mjs --write` in the same commit | ledger check clean; SQL reviewed for the full adjacency table; **applying is owner-gated** (§PR.4.7) |
| **PR.4b** | `prose-fields.ts` + `collectProse`; rewire `fit-engine.ts:151` and `rules-stage.ts:101` | coverage test over all 61 schemas; **regression test: a chassis-text-only piece yields identical `numerals_checked` and identical `cut` before and after the swap** |
| **PR.4c** | `ingestion/src/blocks/resolve.ts`, `src/lib/blocks/resolve.ts`, the shared fixture; `LITERAL_NUMERIC_FIELDS` | conformance test both sides; `numeric_value`, `payload.line_items.<k>`, missing path → null, hyphenated key rejected; `parseMagnitude(formatBound(v,u)) ≈ v` for every fixture row |
| **PR.4d** | `evidence.ts` `toComposeEvidence()` + the `ComposeEvidence` types + a hand-written PR.1-shaped fixture bundle | adapter test: missing optional fields are backfilled by the single id-set query; a bundle with no `row_key` degrades to single-fact blocks and drops the grids |
| **PR.4e** | pass 0 — chassis load, piece type, vocabulary computation | test asserts the FEATURE+AI vocabulary is exactly the 8 codes of §1.2, and that `1b`/`3a`/`3b` refuse `CMP-LAYOUT-UNFILLABLE` naming the required regions |
| **PR.4f** | pass 1 schema + all post-validation | each check refuses on a crafted bad outline; a `BLK-DELTA` entry without `evidence_ref` is `CMP-OUTLINE-UNBOUND` |
| **PR.4g** | the gate: state/field/resolution filters, rectangularisation, thinness over binding sites, marker table, `printed` round-trip | **a bundle with one hole in an 8×5 group composes at 8×4** and records the dropped column; a PENDING-only bundle refuses `CMP-EVIDENCE-PENDING` naming the objects |
| **PR.4h** | selection schemas + materialisers for all 8 codes | coordinate test: a materialised `BLK-COMPARE` whose `metrics[i].values[j]` is forced to a foreign security fails `CMP-BIND-COORDINATE`; `rank` and `best_index` are derived and overwrite the model |
| **PR.4i** | pass-2 driver, repair loop, derived fuse, `LlmJsonError` path | stub failing twice then succeeding → 3 calls and a pass; failing three times → refusal naming the block; `LlmJsonError` on entry 3 of 9 → one retry → refusal naming entry 3 and **no partial write**; fuse trip lists un-attempted regions |
| **PR.4j** | assembly, dry-run fit, transaction, `compose_reports`, `register.ts`, `classify.ts` routing, `rules-stage.ts` producer loop, `edit.ts` guard | **the golden test** (§PR.4.5 #3); citation-keying test against the `citations_uni` predicate |
| **PR.4k** | PR.4b reader: `toBlockNode`, `markers.ts`, `ArticleView` dispatch | the composed fixture renders with zero `MissingBlock`, no literal `[cN]` on the page, and every printed figure traced to an object id |
| **PR.4l** | docs in the same commit: `09 §5.5` (close the five open items), `§6` (the pre-flight), `§12`; this section → built; `BUILD-STATUS §7` DEF rows | `AGENTS.md` documentation discipline |

---

#### PR.4.5 Acceptance criteria

- [ ] 1. `ops.pipeline_items.stage` accepts `compose` and `fit`; `ops.fn_transition` carries both arms; `ops.pipeline_items.producer` exists; `lake.citations.quoted_field` exists; `newsroom_compose_stage` seeded **false**; `supabase/migrations.ledger` clean in the same commit.
- [ ] 2. `npx tsc --noEmit` and `npx tsx --test "src/**/*.test.ts"` green in `worker/` and `ingestion/`, including the §PR.4.4 tests.
- [ ] 3. **Golden test (executable, no DB, no LLM):** a fixture bundle + a stub `chatComplete` → a fully composed piece → `runFit()` on the assembled `FitInput` returns `passed === true`, `refusals.length === 0`, with ≥ 3 `BLK-*` blocks, ≥ 4 chassis `text` blocks, ≥ 1 chassis sentence carrying a `[cN]` whose frozen value it states, `numerals_checked > 0`, and **zero** material numerals in any block-payload prose field.
- [ ] 4. With the switch on and one real story-lane item: `content_blocks` carries ≥ 3 distinct `BLK-*` codes; every `requires_binding` block has a non-null `bound_object_id` and a matching `lake.citations` row; every citation has a non-null `quoted_value` **and** `quoted_field`; `relDiff(parseMagnitude(quoted_value), resolveFieldPath(object, quoted_field)) <= 0.005` for all of them.
- [ ] 5. That piece passes the real `pipeline_rules` **with `numerals_checked > 0` and R-03/R-04 both evaluating non-empty surfaces** — i.e. green because it was checked, not because it was empty.
- [ ] 6. That piece passes the real `pipeline_fit` with zero refusals, and the stored `FitReport` is byte-identical to compose's `dry_run_fit`.
- [ ] 7. It renders in `ArticleView` with zero `MissingBlock`, no literal `[cN]`, and every printed figure resolved live from `lake.objects` at render time (change the object, reload, the figure changes).
- [ ] 8. `ops.compose_reports` has one row per attempt. A deliberately broken bundle (a PENDING-only trigger; a peer set of one; a hyphenated jsonb key) produces a refusal a human can act on **without re-deriving the check**.
- [ ] 9. With `newsroom_compose_stage` off, `classify.ts` enqueues `pipeline_draft` byte-for-byte as today, and the wire lane is untouched in both states.

---

#### PR.4.6 What PR.4 deliberately does not do

- **It does not replace `draft.ts`.** The wire lane keeps it, and `draft.ts` remains the fallback when the switch is off. Record `DEF-COMPOSE-WIRE-LANE` — trigger: family F renderers ship in PR.5; then add `'wire'` to the compose lane by flipping one predicate in `classify.ts` and retire `draft.ts` in a commit of its own, with `auto_publish_wires` still false.
- **It does not compose NOTE, DEEP DIVE or EXPLAINER.** Blocked on families B and D (PR.5), not on PR.0c. `DEF-COMPOSE-NOTE-LAYOUT` — trigger: `BLK-VERDICT`/`BLK-FALSIFY` renderers + the chart compiler.
- **It does not emit 53 of the 61 codes.** Each dropped code has a row in §1.2 with a named blocker; five of them wait on PE.5's object families, not on the newsroom.
- **It does not open the intake gate.** `pipeline_intake_enabled` stays false; PR.6 owns that, narrowly, after the owner has read composed pieces.
- **It does not fix post-publish correction drift.** A chassis sentence copies a frozen `printed` value while the block beside it resolves live, so an R-07 correction after publication splits the article against itself. `quoted_field` makes the affected sentences *findable* (`select … from lake.citations c join lake.objects o … where o.updated_at > c.created_at`); acting on them is R-07's. `DEF-COMPOSE-PROSE-DRIFT` — trigger: the R-07 correction sweep lands.
- **It does not move `PIECE_TYPE_BY_TEMPLATE` (`fit-engine.ts:160-165`) or the region→code map into the registry.** Both are hard-coded policy, in two places now instead of one. `DEF-REGISTRY-PIECE-TYPE-COLUMN` — trigger: `ops.templates` gains a `piece_type` column.
- **It does not fix `requires_binding` conflating lake and non-lake targets.** `BLK-FRESH`, `BLK-RULE` and `BLK-TERM` are refused by `checkBinding` for having no `bound_object_id` when their binding target was never a lake object. `DEF-FIT-BIND-NONLAKE` — trigger: any of those three enters a vocabulary.

**Hands to PR.5:** the 41 remaining renderers and the chart compiler, plus `toBlockNode` coverage for each new code. **Hands to PR.6:** a `producer='compose'` filter for the narrow gate, so the first opened `object_type` produces composed pieces and nothing else.

---

#### PR.4.7 Dependencies — what must be true before PR.4 starts

| # | must be true | owner |
|---|---|---|
| 1 | **PR.1 returns `lake.objects.id` per fact.** `lake.fn_writer_context` does not: ratios, score and price come from `public.*` projections with no object id at all (`20260719175050_writer_context_pack.sql:139-158`); only `source_object_id` on statement rows is a uuid, and `draft.ts:163` currently harvests bigint `row_id`/`source_filing_id` as if they were citable. Compose is unbuildable against the pack as it stands. | PR.1 |
| 2 | **PR.1 verifies that `QUOTE.LAST.payload` carries a change field.** If not, `BLK-TICKER` leaves the first cut and it becomes 7 codes. | PR.1 |
| 3 | **PR.1 supplies `unit` (scale), or compose prints no figure in prose.** Without it, the `COMPUTED.RATIOS` percent-vs-fraction ambiguity turns R-04's drift arm into a random blocker. | PR.1 |
| 4 | **PR.0c seeds one `ops.templates` row that serves `ARTICLE`, declares exactly the 8-code FEATURE vocabulary, is not `TPL-01/05/06/08`** (those four are hard-mapped to other piece types by `fit-engine.ts:160-165`), sets `max_words` to `1a`'s stated read length and `always_premium=false`. Until then every template names a legacy key and compose refuses `CMP-VOCAB-EMPTY`. | PR.0c |
| 5 | **`ops.article_templates` is seeded** with `1a`'s `section_sequence` and `premium_cut`. PD.1/PD.2 shipped (`c181a86`) and `ops.story_blocks` is 61 active, so this is expected true; compose refuses `CMP-LAYOUT-UNRESOLVED` if the row is absent rather than inventing a shape. | verify at PR.4e |
| 6 | **The owner applies the two migrations of §3.2.** There is no privileged write path from an agent session; the handler is deployable before they land and inert until then. | **owner action** |
| 7 | *Not* a dependency: `20260727161500` (`payload_schema`, 0/61). D-C4 means the provider is never handed that column, and `fit-engine.ts:727-761` already enforces from Zod. It stays a drift test, not a gate. | — |
| 8 | *Not* a dependency: PR.2 and PR.3. Compose consumes `ComposeEvidence`; PR.2's `absences[]` and PR.3's thesis enter the pass-1 prompt as extra context when they exist and are absent-tolerant when they do not. PR.4 can be built and tested against a hand-written fixture bundle. | — |
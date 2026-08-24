# PR.0c — reseed `ops.templates` and bind it to the layout axis

## 1. What it is

One DDL migration (`ops.templates.piece_type`), one generated seed migration re-pointing all eight `TPL-0x` rows at the active 61-block vocabulary, a fourth emitter in `scripts/design/generate-registry-seed.mjs`, and five small code changes in `fit-engine.ts` / `fit.ts` / `edit.ts` / `classify.ts` that make the registry the authority instead of a hard-coded map.

**Why now:** `ops.templates.block_keys` is PR.4's pass-1 enum (09 §5.5), so until it names only codes that exist, render and bind, the compose stage's first act will be to hand the writer `BLK-TABLE` / `BLK-CHART` / `BLK-QUOTE` / `BLK-HOLDERS` — which `fit-engine.ts:238` then refuses **per emitted block**.

### 1.1 The stated blocker is misdiagnosed, and this change fixes the docs as well as the data

`fit-engine.ts:332-343` pushes `FIT-TEMPLATE-LEGACY-KEY` into `warnings`, not `refusals`. `worker/src/handlers/__tests__/fit.test.ts:112-119` asserts `r.passed === true` against TPL-02's exact `block_keys` — the test is named *"a TEMPLATE that merely names legacy keys warns — it does not refuse"*. The refusal, `FIT-BLOCK-LEGACY` (`fit-engine.ts:238-247`), fires on codes a **piece emits**. So: **no template is refused at fit today, and seven of eight trip the warning — TPL-01 `{BLK-TICKER, BLK-DELTA}` is clean.** `docs/BRIDGE-BUILD-PLAN.md:1235-1239` and `docs/architecture/09-signal-to-article.md:1020-1027` both assert the opposite; `09 §6.0:730` already states it correctly, so the domain doc contradicts itself. Correcting them is part of this change (AGENTS.md: never "done in code, stale in docs").

### 1.2 The thing that *is* broken today: no `piece_type` column

`ops.templates` has no `piece_type`. `resolvePieceType` (`fit-engine.ts:175-178`) therefore falls through `PIECE_TYPE_BY_CONTENT_TYPE['ARTICLE'] = 'FEATURE'` for TPL-02/03/04/07 → `fit.ts:190-192` resolves `ops.article_templates` row `1a` → `premium_cut.present = true` → `fit-engine.ts:789-791` sets `required = true` → every free earnings recap either gets a metered paywall cut written to `content_items.premium_cut_after_block` (`fit.ts:86-92`) or takes a `FIT-CUT-UNPLACEABLE` refusal. `fit-engine.ts:157-165` names the fix verbatim: *"This map is the stage's ONLY hard-coded policy; it moves into the registry the moment `ops.templates` gains a `piece_type` column"*, and `fit-engine.ts:206` repeats it inside a refusal's `fix`.

---

## 2. The measured constraints this must live within

| Constraint | Measured value |
|---|---|
| Renderers | **20 of 61** (`src/components/blocks/registry.tsx:49-73`). Families B, D, E, F, H empty; no `src/lib/blocks/` (PD.6 absent) |
| Live lake object types | 9: `OHLCV.CLOSE` 640,992 · `FINANCIALS.XCHECK` 41,621 · `FILING.FINANCIALS` 36,330 · `QUOTE.LAST` 10,913 · `COMPUTED.RATIOS` 736 · `PROFILE.SECURITY` 728 · `FILING.REF` 669 · `COMPUTED.SCORE` 540 · `INDEX.LEVEL` 42. **No `DIVIDEND.*`, no `IPO.*`, no `EARNINGS.VERDICT`, no consensus/estimate family, no `MARKET.STATUS`, no glossary store** |
| Live-reachable lanes | `ops.materiality_prefilter` marks exactly one of the nine live types material: `('FILING.FINANCIALS','material','story','TPL-03')` (`20260720110829:49`), and PE.6 gave only that row `accepted_states = {VERIFIED,PENDING}` (`20260727150000:52-53`). `edit.ts:75` then falls back to `hint ?? 'TPL-03'`. **TPL-03 and TPL-01 are the only lanes that can fire; TPL-02/04/05/06/07/08 are dead** |
| Key immovability | `ops.templates(key)` is FK'd from `content_items.template_key` (`20260713000008:34`), `materiality_prefilter.template_hint` (`20260720110829:40`), `classifier_verdicts.suggested_template` (`:74`), `pipeline_items.template_hint` (`:96`); hard-coded at `classify.ts:127` (`/^TPL-0[1-8]$/`), `classify.ts:131-137`, `edit.ts:43`, `edit.ts:69-76`, `ingestion/src/rules/engine.ts:42`. Live prefilter rows already reference TPL-01/03/04/07 |
| Design JSON cannot supply `block_keys` | Across the 4 templates' 70 `block_instances`, only **9** carry a non-null `block_id` (1a `BLK-CUT`/`BLK-MARGIN`; 1b `BLK-THESIS`/`BLK-FALSIFY`; 3a `BLK-CUT`; 3b `BLK-TIMELINE`/`BLK-WORKED`/`BLK-GLOSSARY`/`BLK-TERM`) — the 2/2/1/4 count `20260727143000:76` already records. The rest is `suggested_id` chassis furniture (`BLK-MASTHEAD`, `BLK-HEADLINE`, `BLK-EXHIBIT`, `BLK-DROPCAP`) not in the 61 |
| No word budget in the design | `article-templates.json` carries only `stated_read_length`, and 1a/1b both carry `discrepancy: true` (README ~18 min vs markup "21 MIN READ"; ~14 vs "24 MIN"). `max_words` is a policy decision, not an extraction |
| Ledger tail | `20260727170000`. `20260727161500` and `20260727170000` are both committed and **unapplied** |
| Gates | GitHub Actions billing-blocked (`ci.yml` wires only `check-migration-ledger.mjs`; `generate-registry-seed.mjs --check` was never wired at all). Vercel runs neither. **Local gates are the verification** |
| `fit` is doubly unreachable | `fit-stage.sql` sits in `worker/src/handlers/newsroom/`, **not** in `supabase/migrations/`, so `fit` is not a legal `ops.pipeline_items.stage` value; `switchOn('newsroom_fit_stage')` is false by construction |

### 2.1 What fit does *not* check — this shapes the seed

Three measured facts that a plan built on "fit will catch it" would get wrong:

1. **`checkBinding` never compares `binds_to` to anything** (`fit-engine.ts:362-396`). It checks only: `bound_object_id` non-null → a `lake.citations` row exists for it → at least one such citation has `object_state = 'VERIFIED'`. `binds_to` appears solely inside the `FIT-BIND-MISSING` evidence payload. A `BLK-EXDATE` bound to a `PROFILE.SECURITY` object passes.
2. **Payload-level bindings are format-checked only.** D-8 lives in the payload (`ObjectBinding = {object_id: z.uuid(), field: /dotted path/}`, `ingestion/src/blocks/binding.ts`), but `checkBinding` inspects the separate `content_blocks.bound_object_id` column. No code resolves a payload `object_id` against `lake.objects` or requires it to carry a citation. A strict-v4 uuid that names nothing passes.
3. **`checkNumbers` has no surface on family A.** `PROSE_FIELDS` (`fit-engine.ts:151`) is `['text','body','prose','caption','note','standfirst','one_line_intent','intent']`. Every inline block's prose field is `host_sentence` / `host_claim` / `host_paragraph`. None is scanned.

Consequence for the seed: **a code whose data has no live source is not "guaranteed refused" — it is silently satisfiable with the wrong object.** That is worse, and it is the real reason to withhold such codes from the pass-1 enum.

---

## 3. The design

### 3.1 Schema — exactly one column

```sql
alter table ops.templates add column if not exists piece_type text;
alter table ops.templates drop constraint if exists templates_piece_type_check;
alter table ops.templates add constraint templates_piece_type_check
  check (piece_type is null or piece_type in
         ('WIRE','FEATURE','NOTE','DEEP DIVE','EXPLAINER','IPO'));
```

Nullable, no default, no backfill — the seed in 3.4 sets all eight explicitly and `resolvePieceType` keeps `PIECE_TYPE_BY_TEMPLATE` as a fallback, so the worker is deployable against either schema state.

**Rejected: `layout_template_id`.** `ops.article_templates.piece_type` is already 1:1 across the four chassis (`generate-registry-seed.mjs:99` — `{1a:FEATURE, 1b:NOTE, 3a:'DEEP DIVE', 3b:EXPLAINER}`) and `fit.ts:190-192` already resolves the layout row **by that token**. One token resolves both the block-permission axis and the chassis; an FK would be a second key for the same join, and `20260727143000:105-113` argues the two axes must stay separate tables.

**`AI` is excluded from the constraint.** It is an authorship axis added by `pieceTypeSet` (`fit-engine.ts:284-295`) when `content_items.author_id` is an agent principal, never a template's declared type.

### 3.2 The seed rule

A code enters `block_keys` only if all three hold:

1. **It renders.** `code ∈ BLOCK_RENDERERS` (the 20). Declaring `BLK-WATERFALL` yields a piece that passes fit and renders `MissingBlock`.
2. **Its piece type admits the row's.** `piece_types ⊇ {ALL} ∨ {row.piece_type} ∨ {AI}` — the `AI` disjunct mirrors `pieceTypeSet` (`fit-engine.ts:284-295`), which adds `'AI'` whenever `input.agent_authored`, which `fit.ts:125` derives from `(p.kind::text = 'agent')`, which `classify.ts:51/94` always sets to the DATA-FILINGS agent. **Every pipeline piece is agent-authored**, so `BLK-CITE` (`piece_types = {AI, NOTE}`) — the design's mandatory citation block, rule R-03 — is legal on all eight rows. Omitting the `AI` disjunct would have excluded it from seven of them.
3. **A live `lake.objects.object_type` can honestly satisfy its binding.** Not because fit type-checks it (§2.1 shows it does not) but *because it does not*: a code with no live source can only be satisfied by binding an unrelated object, and that is invisible to every check the stage runs. Withholding it from the pass-1 enum is the only place the mistake is preventable.

Measured mechanical ceiling (clauses 1+2 only), from `BLOCK_RENDERERS` × `pieceTypesFor`:

```
WIRE 15 · FEATURE 16 · NOTE 17 · DEEP DIVE 17 · EXPLAINER 16 · IPO 16
```

Clause 3 withholds **seven** codes, each with the object family it is waiting on:

| code | `binds_to` / required payload | missing |
|---|---|---|
| `BLK-FRESH` | `status: ObjectRef` → venue `market.status` | no `MARKET.STATUS` object |
| `BLK-RULE` | the publishing ruleset (rule id) | `ops.rules` is not a lake object; `lake.citations.object_id` FKs `lake.objects` |
| `BLK-TERM` | `glossary.term` | no glossary store |
| `BLK-BEATMISS` | `rows[].consensus_eps` — a **required** `ObjectBinding` (`c-tabular.ts:231-234`, four required bindings, `.min(1)`) | no consensus/estimate family |
| `BLK-EXDATE` | `dps`, `ex_date`, `yield_pct`, `pay_date` bindings | no `DIVIDEND.*` |
| `BLK-KEYSTATS` | IPO mechanics (4 or 8 cells) | no `IPO.*` |
| `BLK-CONFLICT` | `source_a.value` + `source_b.value`, two distinct bindings | `FINANCIALS.XCHECK` (41,621) is the plausible source, but **whether it exposes both sides as separate lake objects is unverified from this session** — PR.1 is where that gets settled |

Cost, stated plainly: design hard-rule 2's freshness badge is absent from all eight rows; TPL-03 ships **without a beat/miss table**; TPL-04 without a dividend row; TPL-05 without IPO key stats; TPL-06 without defined terms. Each is a `DEF-BLOCK-BINDING-NO-LAKE-TYPE` row with a named trigger, and each returns via one edit to `docs/design/pipeline-templates.json` plus a regenerate.

Ceiling after clause 3: `WIRE 10 · FEATURE 11 · NOTE 12 · DEEP DIVE 12 · EXPLAINER 10 · IPO 10`.

**`BLK-FINTABLE` is not widened, and TPL-03 gets no statement table.** Its `piece_types` are `{DEEP DIVE, NOTE}` (`block-registry.json`, via `pieceTypesFor`), so a `FEATURE`-typed TPL-03 may not declare it — an earnings recap therefore carries `BLK-STATSTRIP` (3–5 cells), `BLK-COMPARE` and `BLK-RANKROW` as its whole evidence surface. The obvious fix, `update ops.story_blocks set piece_types = ...`, is refused for a mechanical reason: `generate-registry-seed.mjs:144-151` regenerates `piece_types` from the JSON with `on conflict do update`, so a hand-written UPDATE in a later migration is silently reverted the next time the blocks seed is re-applied. The honest route is an explicit, named override in the generator that regenerates deterministically into `20260727144500` — which means re-applying the blocks seed (a second owner-gated apply) and pre-empting an editorial call before any piece has ever been composed. Parked as `DEF-TEMPLATE-EARNINGS-NO-TABLE`, trigger **PR.4** (the first phase that can say whether the recap needs one), and recorded in the migration comment so the next reader does not "fix" it by hand.

### 3.3 Semantic collisions — two survivors changed meaning between 2026-07-13 and the design

- **`BLK-VERDICT`**: seed = "Earnings verdict" (`lake_object_type = 'EARNINGS.VERDICT'`); design = family B "Rating card", `allowed_piece_types = "NOTES ONLY"`. TPL-03 declares it. A `FEATURE` emitting it takes `FIT-BLOCK-PIECE-TYPE` (`fit-engine.ts:252-261`). Dropped, and family B has no renderer anyway.
- **`BLK-ESTIMATE`**: seed = "Estimate vs actual" table; design = family **G** "Desk-estimate marker", `binds_to: desk computation (as opposed to a company disclosure)`. Its payload is a filed figure `ObjectBinding` plus a desk-computation `ObjectBinding` — satisfiable by `FILING.FINANCIALS` (36,330) + `COMPUTED.RATIOS` (736), so it stays, meaning the marker. The actual-vs-consensus table is `BLK-BEATMISS`, withheld under clause 3.

`lake_object_type` is left stale (live `BLK-ESTIMATE` still holds `'ESTIMATE.OBS'`). Nothing reads it (DEF-REGISTRY-ZERO-READERS), and nulling it is an `ops.story_blocks` change that does not belong in an `ops.templates` reseed. Recorded in the migration comment.

### 3.4 The eight rows

All eight are **kept and UPDATEd in place** — never `delete`+`insert`, per the FK/code-site inventory in §2. No new `TPL-09`+: `classify.ts:127` hard-rejects anything failing `/^TPL-0[1-8]$/` (→ `writerForTemplate(null)` → WRITER-2), so a ninth key costs three code edits in the same change.

| key | `piece_type` | `block_keys` | n | auto_pub | always_prem | max_words |
|---|---|---|---|---|---|---|
| TPL-01 Wire | `WIRE` | TICKER, DELTA, STATSTRIP, CITE, PROV, AGENTS | 6 | **true** | false | **40** |
| TPL-02 Market Wrap | `FEATURE` | TICKER, DELTA, SPARK, STATSTRIP, RANKROW, COMPARE, CITE, PROV, AGENTS | 9 | false | false | null |
| TPL-03 Earnings Recap | `FEATURE` | TICKER, DELTA, STATSTRIP, SPARK, COMPARE, RANKROW, ESTIMATE, CITE, PROV, AGENTS | 10 | false | false | null |
| TPL-04 Dividend Note | `FEATURE` | TICKER, DELTA, STATSTRIP, CITE, PROV, AGENTS | 6 | false | false | null |
| TPL-05 IPO Coverage | `IPO` | TICKER, DELTA, STATSTRIP, COMPARE, CITE, PROV, AGENTS | 7 | false | false | null |
| TPL-06 Explainer | `EXPLAINER` | TICKER, DELTA, STATSTRIP, COMPARE, CITE, PROV, AGENTS | 7 | false | false | null |
| TPL-07 Free + Marsad Take | `FEATURE` | TICKER, DELTA, SPARK, STATSTRIP, SCENARIO, COMPARE, ESTIMATE, CITE, PROV, AGENTS | 10 | false | false | null |
| TPL-08 Premium Deep Dive | `DEEP DIVE` | TICKER, DELTA, MARGIN, FINTABLE, STATSTRIP, COMPARE, SPARK, ESTIMATE, CITE, PROV, AGENTS | 11 | false | **true** | null |

Verified: every row is inside its clause-3 ceiling (`6/10, 9/11, 10/11, 6/11, 7/10, 7/10, 10/11, 11/12`), and all eight sizes sit in 09 §5.5's "~5–12".

Three row-level decisions worth their reasons:

- **TPL-01 does not get `BLK-SPARK`.** `ops.story_blocks.requires_binding = false` on it (`requiresBinding` at `generate-registry-seed.mjs:64` is `binds_to || family C || family D`, and BLK-SPARK is family A with `binds_to` null), and `checkBinding`'s first line is `if (!reg.requires_binding) return;`. The repo already knows the row is wrong — `a-inline.ts:147-157` binds `series` to an `ObjectBinding` anyway and ends *"Flagged for the registry row to be corrected"* (DEF-BLOCK-BINDING-REGISTRY-DRIFT). TPL-01 is the only `auto_publish_eligible` row; it does not get the block whose registry row is known-wrong. It stays on TPL-02/03/07/08, all of which route to approval. Flipping `requires_binding` instead would rewrite what fit refuses across the whole vocabulary and force a second owner-gated apply of the blocks seed — not a templates reseed's business.
- **TPL-04 is `FEATURE`, not `NOTE`.** Chassis 1b's `access_tier.effective` is *"premium — whole document gated; there is no in-page cut"*, which contradicts the row's own `always_premium = false`; a `NOTE` type would render premium masthead furniture on a free piece the moment PR.5 wires the chassis. Making it `always_premium = true` instead is a commercial decision that is not mine to take in a reseed. Consequence, stated: **no row uses `piece_type = 'NOTE'`, so chassis 1b is unreachable after this change** — parked as `DEF-TEMPLATE-RESEARCH-NOTE`.
- **`max_words` stays NULL everywhere except TPL-01 = 40.** `FIT-TEMPLATE-MAXWORDS` (`fit-engine.ts:316-321`) is a hard refusal and must never be why a good piece dies. 40 is the only real policy value — it is `AUTO_WORD_CAP_DEFAULT` (`ingestion/src/rules/engine.ts:16`), `autoWordCap: 40` (`rules-stage.ts:34`) and `<= 40` in `fn_enforce_agent_publish_gate`. The read-minute figures imply ≈4,300 / 3,400 / 9,600 / 2,600 at 240 wpm; they go in a SQL comment marked **derived**, not into the column.

`auto_select_rule` (not null) is kept verbatim from `20260713000008:271-279` except TPL-05, which becomes `'IPO.* object or ipo_offers stage change; the IPO lane, not TPL-07'`. `served_types` is corrected to what the pipeline can actually produce (TPL-04 → `{ARTICLE}`, TPL-07 → `{ARTICLE}`) — it is `text[]` with no check and **zero readers** (grep over `served_types` / `auto_select_rule` returns only DDL, generator comments and fit's `block_keys` hits), so it is documentation.

Also in the same migration: `update ops.materiality_prefilter set template_hint = 'TPL-05' where object_type = 'IPO.OFFER'` (seeded `TPL-07` at `20260720110829:53` — an IPO offer routed to the Take lane is part of what forced everything into 1a).

### 3.5 The new reviewed data file

`docs/design/pipeline-templates.json` sits beside `block-registry.json` / `article-templates.json` for the same reason they do: the eight rows are a design decision and the `.sql` is its projection. It carries what is declared **and what is deliberately withheld**:

```jsonc
{ "templates": [ {
    "key": "TPL-03", "name": "Earnings Recap", "served_types": ["ARTICLE"],
    "piece_type": "FEATURE",
    "auto_select_rule": "earnings verdict set on earnings_events",
    "block_keys": ["BLK-TICKER","BLK-DELTA","BLK-STATSTRIP","BLK-SPARK","BLK-COMPARE",
                   "BLK-RANKROW","BLK-ESTIMATE","BLK-CITE","BLK-PROV","BLK-AGENTS"],
    "deferred_blocks": [
      { "code": "BLK-BEATMISS", "reason": "rows[].consensus_eps is a required ObjectBinding; no consensus/estimate object family is live",
        "trigger": "PR.1 — an estimates family exists in lake.objects" },
      { "code": "BLK-FINTABLE", "reason": "piece_types = {DEEP DIVE, NOTE}; widening is a story_blocks change the generator would revert",
        "trigger": "PR.4 — once a composed recap shows the statement table is load-bearing" } ],
    "unbound_allowed": [],
    "auto_publish_eligible": false, "always_premium": false, "max_words": null
} ] }
```

`unbound_allowed` is only non-empty on TPL-01: `BLK-DELTA` ("magnitude is a literal string — DEF-BLOCK-DELTA-LITERAL-MAGNITUDE") and `BLK-AGENTS` ("byline chain, no datum").

### 3.6 Generator — a fourth emitter, additive only

`scripts/design/generate-registry-seed.mjs` already has the `OUTS` map (32-36), `banner()/q()/j()` (101-111), one `jsonb_to_recordset` per file, `do $$` assertions (156-162, 194-198) and `--check` (221-237). Add — and touch nothing else:

```js
OUTS.pipeline_templates = join(ROOT, 'supabase/migrations/20260728090100_pipeline_templates_reseed.sql');
const pipeline = JSON.parse(readFileSync(join(ROOT, 'docs/design/pipeline-templates.json'), 'utf8'));

// The codes that actually render, parsed from the renderer registry so PR.5 widens the
// ceiling by ADDING A RENDERER, not by editing SQL. Measured 2026-07-27: 20 codes, all in the 61.
const tsx  = readFileSync(join(ROOT, 'src/components/blocks/registry.tsx'), 'utf8');
const body = tsx.split('export const BLOCK_RENDERERS')[1].split('\n};')[0];
const RENDERED = [...body.matchAll(/"(BLK-[A-Z]+)"\s*:/g)].map((m) => m[1]);

// Mirrors fit-engine.ts pieceTypeSet(): every pipeline piece is agent-authored
// (fit.ts:125 ← classify.ts:51/94), so the piece always carries 'AI' alongside its primary type.
const admits = (b, pt) => { const p = pieceTypesFor(b); return p.includes('ALL') || p.includes(pt) || p.includes('AI'); };
```

Assertions, all of which **throw before any file is written**:

| # | assertion |
|---|---|
| a | every `block_keys` code ∈ `RENDERED` |
| b | every `block_keys` code satisfies `admits(byCode[code], row.piece_type)` |
| c | `block_keys ∩ deferred_blocks = ∅`, and every deferred entry has a non-empty `reason` **and** `trigger` |
| d | on `auto_publish_eligible` rows: every code has `requiresBinding(b) === true` **or** appears in `unbound_allowed` with a reason |
| e | `5 ≤ block_keys.length ≤ 12` |
| f | `piece_type ∈ {WIRE, FEATURE, NOTE, DEEP DIVE, EXPLAINER, IPO}`, never null |
| g | keys are exactly `TPL-01…TPL-08` |

**Do not touch `pieceTypesFor` (85-92), `requiresBinding` (64) or `rendererFor` (52-56).** They feed the blocks seed; a one-character change silently rewrites `piece_types` / `requires_binding` on all 61 rows, and `requires_binding = true` is what makes `fit-engine.ts:362-396` refuse.

### 3.7 The two migrations

**(a) `20260728090000_pipeline_templates_piece_type.sql` — hand-written DDL.** The `alter`/`check` from §3.1 plus:

```sql
comment on column ops.templates.piece_type is
  'The design piece-type token this pipeline template renders as. Joins BOTH axes: '
  'ops.story_blocks.piece_types (block permission) and ops.article_templates.piece_type '
  '(the 1a/1b/3a/3b chassis, incl. where the premium cut falls). WIRE and IPO have no chassis '
  'row by design — the handoff exports no wire or IPO page — so layoutTemplate resolves null and '
  'the cut is reported unchecked rather than refused. ''AI'' is deliberately NOT legal here: it is '
  'an authorship axis added by fit-engine pieceTypeSet(), not a template declaration.';
```

**(b) `20260728090100_pipeline_templates_reseed.sql` — GENERATED.** One `jsonb_to_recordset` upsert plus assertions:

```sql
insert into ops.templates (key, name, served_types, auto_select_rule, piece_type,
                           block_keys, auto_publish_eligible, always_premium, max_words)
select s.key, s.name, array(select jsonb_array_elements_text(s.served_types)),
       s.auto_select_rule, s.piece_type, array(select jsonb_array_elements_text(s.block_keys)),
       s.auto_publish_eligible, s.always_premium, s.max_words
  from jsonb_to_recordset('[…8 rows…]'::jsonb) as s(
    key text, name text, served_types jsonb, auto_select_rule text, piece_type text,
    block_keys jsonb, auto_publish_eligible boolean, always_premium boolean, max_words int)
on conflict (key) do update set
  name = excluded.name, served_types = excluded.served_types,
  auto_select_rule = excluded.auto_select_rule, piece_type = excluded.piece_type,
  block_keys = excluded.block_keys, auto_publish_eligible = excluded.auto_publish_eligible,
  always_premium = excluded.always_premium, max_words = excluded.max_words;

update ops.materiality_prefilter set template_hint = 'TPL-05' where object_type = 'IPO.OFFER';

do $$ declare v int; begin
  select count(*) into v from ops.templates;
  if v <> 8 then raise exception 'expected 8 pipeline templates, got %', v; end if;

  -- (1) UNKNOWN KEYS FIRST. An inner join cannot see a key with no story_blocks row, and an
  -- unknown code at PR.4 is FIT-BLOCK-UNKNOWN (fit-engine.ts:222-232) — a REFUSAL, strictly
  -- worse than the legacy warning this reseed exists to remove.
  select count(*) into v from ops.templates t, unnest(t.block_keys) k
   where not exists (select 1 from ops.story_blocks b where b.key = k);
  if v <> 0 then raise exception '% declared block keys do not exist in ops.story_blocks', v; end if;

  -- (2) no template may still name a retired code
  select count(*) into v from ops.templates t, unnest(t.block_keys) k
    join ops.story_blocks b on b.key = k where b.status <> 'active';
  if v <> 0 then raise exception '% legacy block_keys survive the reseed', v; end if;

  -- (3) piece-type permission, NULL-SAFE: legacy rows carry piece_types = null, and
  -- `not (null @> ...)` is NULL, which the WHERE silently drops.
  select count(*) into v from ops.templates t, unnest(t.block_keys) k
    join ops.story_blocks b on b.key = k
   where t.piece_type is not null
     and coalesce(b.piece_types @> array['ALL'] or b.piece_types @> array['AI']
                  or b.piece_types @> array[t.piece_type], false) = false;
  if v <> 0 then raise exception '% declared blocks are not permitted for their piece_type', v; end if;

  if exists (select 1 from ops.templates where piece_type is null) then
    raise exception 'a template row has no piece_type — it would inherit FEATURE and a metered cut';
  end if;

  -- (4) the auto-publish lane may not declare an unbound block except the reviewed two
  select count(*) into v from ops.templates t, unnest(t.block_keys) k
    join ops.story_blocks b on b.key = k
   where t.auto_publish_eligible and b.requires_binding is not true
     and k <> all (array['BLK-DELTA','BLK-AGENTS']);
  if v <> 0 then raise exception '% unbound blocks on an auto-publish template', v; end if;

  select count(*) into v from ops.templates where cardinality(block_keys) not between 5 and 12;
  if v <> 0 then raise exception '% templates outside the 5..12 pass-1 enum band', v; end if;
  raise notice 'ops.templates: 8 rows, 0 unknown, 0 legacy, 0 piece-type violations';
end $$;
```

The generated header carries the semantic collisions (§3.3), the seven withheld codes with reasons and triggers (§3.2), and the "UPDATE IN PLACE, never DELETE+INSERT" note with the four FKs named.

### 3.8 Code changes in the same PR

**(a) `fit-engine.ts` — read the column, keep the map as fallback. `piece_type` is OPTIONAL on the interface.**

```ts
export interface PipelineTemplate {
  key: string;
  piece_type?: string | null;      // NEW — optional: fit.test.ts holds 11 literals without it
  block_keys: string[];
  auto_publish_eligible: boolean; always_premium: boolean; max_words: number | null;
}

export function resolvePieceType(
  contentType: string, templateKey: string | null, registryPieceType?: string | null,
): string | null {
  if (registryPieceType) return registryPieceType;
  if (templateKey && PIECE_TYPE_BY_TEMPLATE[templateKey]) return PIECE_TYPE_BY_TEMPLATE[templateKey]!;
  return PIECE_TYPE_BY_CONTENT_TYPE[contentType] ?? null;
}
```

Required would emit 11× `TS2741` at `fit.test.ts` lines 70, 128, 171, 184, 198, 272, 284, 325, 345, 360, 409 — and the natural reflex, editing those literals, touches the file whose line 112-119 test is this change's stated regression guard. Optional costs nothing: the call site is `input.pipelineTemplate?.piece_type ?? null` and the third parameter is already optional. `pieceTypeSet` (`fit-engine.ts:286`) passes it through.

**(b) `fit.ts` — schema-tolerant read.** `fit.ts:186` is an explicit column list; adding `piece_type` makes it throw `42703` until (a) applies. `fit.ts:205-211` already sets the precedent (`select to_regclass('ops.fit_reports')` — *"the stage must be deployable before the migration is applied"*). Cheaper than a probe:

```ts
const tplRow = ci.template_key
  ? ((await sql`select to_jsonb(t) as t from ops.templates t where key = ${ci.template_key}`) as unknown as Array<{ t: Record<string, unknown> }>)[0]?.t ?? null
  : null;
const pipelineTemplate = tplRow ? ({
  key: String(tplRow.key), piece_type: (tplRow.piece_type as string | null) ?? null,
  block_keys: (tplRow.block_keys as string[]) ?? [],
  auto_publish_eligible: tplRow.auto_publish_eligible === true,
  always_premium: tplRow.always_premium === true,
  max_words: (tplRow.max_words as number | null) ?? null,
}) : null;

const pieceType = resolvePieceType(ci.content_type, ci.template_key, pipelineTemplate?.piece_type);
```

The template is already fetched *before* the piece type is resolved, so no reordering. **Deploy order is explicit: the code may ship before the migration; the fallback map stays until the apply is verified.**

**(c) `fit-engine.ts` `checkCut` — stop forcing a paywall into free ARTICLEs.** `piece_type` alone does not fix this: TPL-02/03/04/07 are all `FEATURE` → 1a → `present = true` → cut forced. One line at `fit-engine.ts:790`:

```ts
const required = present === true && (input.is_premium || input.pipelineTemplate?.always_premium === true);
```

TPL-08 keeps its 3a chapter-4 cut; TPL-02/03/04/07 (free) get none. `permitted` is untouched, so a cut placed on a 1b/3b piece is still `FIT-CUT-NOT-PERMITTED`. 1a's actual model — metered-but-free, "3/3 FREE READS USED" — is not expressible (`is_premium` is boolean); parked as `DEF-TEMPLATE-METERED-FREE` rather than approximated by walling every article.

**(d) `edit.ts` — the misroutes the reseed makes visible, and the word band.**

```ts
if (citeTypes.has('EARNINGS.VERDICT')) return 'TPL-03';   // was TPL-08 — a verdict is a recap, not a deep dive
if (citeTypes.has('IPO.OFFER'))        return 'TPL-05';   // was TPL-07 — the IPO lane, not the Take lane
if (citeTypes.has('DIVIDEND.EXDATE'))  return 'TPL-04';
if (citeTypes.has('FILING.FINANCIALS') && wordCount > 500) return 'TPL-03';
if (wordCount <= 40) return 'TPL-01';                     // was `< 90` — TPL-01.max_words IS 40
return hint ?? 'TPL-03';
```

The word band is the live bug the rest of this change would otherwise arm: `edit.ts:73` assigned TPL-01 up to 89 words, `ops.templates.max_words = 40`, and `fit-engine.ts:316-321` turns that into a hard refusal — every 41-to-89-word draft routed to the one lane that structurally cannot accept it, straight to `reassigned_human`. Raising `max_words` to 90 instead is acceptable only if all three mirrored literals move together (`engine.ts:16`, `rules-stage.ts:34`, `fn_enforce_agent_publish_gate`); dropping the router threshold is one line and touches no gate. Both changed arms above are dead code today — `EARNINGS.VERDICT` and `IPO.OFFER` are not among the nine live object types.

Also `edit.ts:43`, per the `fit` precedent:

```ts
const [tpl] = await sql`select always_premium from ops.templates where key = ${template}`;
const isPremium = tpl?.always_premium === true;
```

**(e) `fit-engine.ts` `PROSE_FIELDS` — give `checkNumbers` a surface on family A.**

```ts
const PROSE_FIELDS = ['text', 'body', 'prose', 'caption', 'note', 'standfirst',
                      'one_line_intent', 'intent',
                      'host_sentence', 'host_claim', 'host_paragraph'];
```

Today every inline block's prose lives in a `host_*` field and none is scanned, so a `BLK-DELTA` on the auto-publish lane states "SAR 2.1bn" under zero numeric checks. Blast radius is zero right now (nothing emits `BLK-*`), and PR.0c is the change that makes the vocabulary reachable, so it closes before PR.4. **One side effect to test:** `proseOf` also feeds `endsCompleteThought`, so inline blocks now participate in the `FIT-CUT-MID-SENTENCE` check instead of returning `null`. `magnitude` is deliberately **not** added — it is a value field, and stuffing it into a scan documented as "fields that carry PROSE" is the kind of half-truth `fit-engine.ts:736-742` argues against. `BLK-DELTA`'s literal magnitude is parked as `DEF-BLOCK-DELTA-LITERAL-MAGNITUDE`.

**(f) `classify.ts` — the minimum.** Line 30's prompt enum → `"TPL-01|TPL-03|TPL-04|TPL-05|TPL-07|null"`, matching the prefilter re-point. `normalizeTemplate` (`:127`) and `writerForTemplate` (`:131-137`) unchanged; TPL-05 already falls to WRITER-2.

**Not changed here:** `classify.ts:95` `content_type = priority === 'wire' ? 'WIRE' : 'ARTICLE'`. `content_items` allows six types (`20260713000008:26`) but NOTE/EXPLAINER/TAKE/NEWSLETTER are unreachable from the pipeline. A TPL-04 piece is created `content_type = 'ARTICLE'` with `piece_type = 'FEATURE'` — consistent. Widening the ternary is a PR.3/PR.6 editorial decision, not a reseed side effect.

---

## 4. Build order

Each step is independently verifiable and leaves the tree green.

1. **Baseline the generator.** `node scripts/design/generate-registry-seed.mjs --check` → green, 3 files in sync. *(If it is red before you start, stop: something else is drifting.)*
2. **Write `docs/design/pipeline-templates.json`** — the 8 rows of §3.4 with `deferred_blocks` and `unbound_allowed`. Verify: `node -e` parse + count 8.
3. **Extend the generator** (§3.6): `OUTS.pipeline_templates`, the `RENDERED` parse, `admits`, the seven assertions, the fourth emitter. Verify: run without `--check`; it must either throw with the offending codes named, or write exactly one new file. Then `--check` → green with **4** files, and `git diff --stat` must show only the new migration — the three pre-existing files byte-identical. **This is the only guard that `pieceTypesFor` / `requiresBinding` were not perturbed.**
4. **Write `20260728090000_pipeline_templates_piece_type.sql`** by hand (§3.1 + the comment).
5. **Ledger.** `node scripts/check-migration-ledger.mjs --write`; `git diff supabase/migrations.ledger` must be **exactly +2 lines**. A third line is drift.
6. **SQL applies against a clean fixture (docker, no live DB).** `psql` is not on the host; `docker` is (`/usr/local/bin/docker`). A full 133-migration replay fails on Supabase roles/extensions, so use a minimal fixture: `create schema ops`, `ops.templates` verbatim from `20260713000008:5-14`, `ops.story_blocks (key, status, piece_types, requires_binding)`, `ops.materiality_prefilter (object_type, template_hint)`; seed `story_blocks` from the generated blocks file; run both new files with `ON_ERROR_STOP=1`. Exercises the `jsonb_to_recordset` column list, the `text[]` casts, the check constraint and all six assertions. Then re-run with two deliberately broken rows (a typo'd code, a legacy code) and confirm assertions (1) and (2) fire.
7. **Code changes** §3.8 (a)–(f).
8. **Tests.** New `worker/src/handlers/__tests__/templates-reseed.test.ts` (§5), then `cd worker && npx tsx --test "src/**/*.test.ts"` and `npm run typecheck`; same in `ingestion/`.
9. **Docs, same commit.**

| file:line | says | must say |
|---|---|---|
| `09:1020-1027` | "`fit-engine.ts` refuses a template that declares a legacy key … every one of those templates would be refused at the fit stage today"; "The four longform templates … were never seeded" | it **warns** (`fit-engine.ts:332-343`, asserted by `fit.test.ts:112-119`); 7 of 8 warn, TPL-01 is clean; the blocker is PR.4's pass-1 enum. The four longform templates **are** seeded — as `ops.article_templates` 1a/1b/3a/3b (`20260727144600`); PR.0c binds each TPL row to one via `piece_type` |
| `09:609` | palette comes "from `ops.article_templates.block_keys`" | `ops.templates.block_keys` — `ops.article_templates` has no such column (DDL `20260727143000:120-133`) |
| `BRIDGE-BUILD-PLAN.md:1235-1239` | "every template in the DB fails fit today" | 7 of 8 warn; nothing fails fit; PR.0c gates **PR.4**, and it is the missing `piece_type` (not the legacy keys) that is breaking behaviour today |
| `BRIDGE-BUILD-PLAN.md:1299-1300` | "until the templates declare a legal vocabulary, the fit stage refuses every piece" | until they do, the **compose stage** hands the writer retired codes that fit then refuses per block |
| `09:730` | already correct | leave — the domain doc currently contradicts itself |

10. **`docs/BUILD-STATUS.md` §7 rows** (`| ID | What | Why parked | Trigger | Home |`):
 - **DEF-REGISTRY-LEGACY-BLOCK-KEYS** — cited by name at `20260727143000:96`, **zero hits in `docs/`**. Add it (an unledgered deferral is a dropped one), trigger *"owner applies `20260728090100`"*, delete on apply.
 - **DEF-BLOCK-BINDING-NO-LAKE-TYPE** — the seven withheld codes of §3.2 with their missing object families. Trigger: **PR.1**. Sibling of DEF-BLOCK-BINDING-REGISTRY-DRIFT.
 - **DEF-FIT-PAYLOAD-BINDING-UNRESOLVED** — payload-level `ObjectBinding.object_id` is uuid-format-checked only; never resolved against `lake.objects`, never required to carry a citation (`checkBinding` reads only `content_blocks.bound_object_id`). Trigger: **PR.4**, the first stage that emits them.
 - **DEF-BLOCK-DELTA-LITERAL-MAGNITUDE** — `BLK-DELTA.magnitude` is a writer-emitted string on the auto-publish lane. Trigger: before PR.6 flips `auto_publish_wires`.
 - **DEF-TEMPLATE-EARNINGS-NO-TABLE** — TPL-03 has no statement table; `BLK-FINTABLE` is `{DEEP DIVE, NOTE}` and a hand-written `piece_types` UPDATE is reverted by the next blocks-seed regeneration. Trigger: **PR.4**.
 - **DEF-TEMPLATE-RESEARCH-NOTE** — chassis 1b unreachable (no row is `piece_type='NOTE'`); needs a 9th key (3 code edits) **and** family-B renderers. Trigger: PR.3 emits rating + falsifiers **and** PR.5 ships family B.
 - **DEF-TEMPLATE-METERED-FREE** — 1a's "3/3 free reads then a cut" has no representation. Trigger: the meter ships.
 - **DEF-BLOCK-SCORE-CHIP** — `BLK-SCORE` retired with no active successor; `COMPUTED.SCORE` (540 objects) has no dedicated block, so the score lands as a `BLK-STATSTRIP` cell. Trigger: PR.5 family B (`BLK-BIGNUM`).
 - Update **DEF-REGISTRY-ZERO-READERS** (`BUILD-STATUS.md:607`) — `block_keys` and the new `piece_type` now have a reader.
 - Update **DEF-BLOCK-BINDING-REGISTRY-DRIFT** (`:593`) — note that `BLK-SPARK` is kept off the auto-publish lane until the row is corrected.

11. **Apply — owner-gated.** Three migrations need the same privileged write path: `20260727161500`, `20260727170000`, and this pair. The reseed has **no dependency on `payload_schema`**, so it can apply first or alone. Per `supabase/migrations.ledger:19-25`, for **each** file: apply → immediately verify `supabase_migrations.schema_migrations.version` equals the filename's 14 digits and re-stamp if the MCP auto-generated its own → then `check-migration-ledger.mjs --write` and read the diff. Do not regenerate the ledger before re-stamping; that papers over live drift, which recurred twice (PR #22, then again within two days).

12. **Post-apply smoke (read-only, when a session has DB access).**

```sql
select t.key, t.piece_type, cardinality(t.block_keys) n,
       count(*) filter (where b.status <> 'active') legacy,
       count(*) filter (where b.key is null)        unknown
  from ops.templates t
  left join lateral unnest(t.block_keys) k on true
  left join ops.story_blocks b on b.key = k
 group by 1,2,3 order by 1;
-- expect 8 rows; legacy = 0 and unknown = 0 on every one; n in 5..12; piece_type never null
```

---

## 5. Acceptance criteria

Local gates are the verification — Actions is billing-blocked, Vercel runs neither script, and a green Vercel build proves nothing about this change.

- [ ] `node scripts/design/generate-registry-seed.mjs --check` green with **4** files; `git diff --stat` shows the three pre-existing seed files unchanged (byte-identical).
- [ ] The generator throws, naming the offending codes, when a `block_keys` entry escapes clause 1, 2, e, f or g — verified by temporarily adding `BLK-WATERFALL` to TPL-02.
- [ ] `git diff supabase/migrations.ledger` is exactly +2 lines.
- [ ] Both `.sql` files apply clean on a `postgres:16` fixture with `ON_ERROR_STOP=1`, raising the final `notice`; and assertions (1) and (2) each fire on a deliberately broken fixture row.
- [ ] `cd worker && npm run typecheck` clean — including `fit.test.ts`'s 11 `pipelineTemplate` literals, untouched.
- [ ] `cd worker && npx tsx --test "src/**/*.test.ts"` — all 33 `fit.test.ts` tests plus the rest of the 89 still green, `fit.test.ts:112-119` included.
- [ ] **New `worker/src/handlers/__tests__/templates-reseed.test.ts`** — the real acceptance test, run through the actual engine with no DB. It builds `Record<string, RegistryBlock>` from `docs/design/block-registry.json` via the same `pieceTypesFor` / `requiresBinding` (plus the 8 legacy keys at `status:'legacy'`, `piece_types: null`), reads `docs/design/pipeline-templates.json`, and follows the runtime-read pattern `ingestion/src/blocks/__tests__/schemas.test.ts:56` already uses (`readFileSync(new URL("../../../../docs/design/…", import.meta.url))` — how a `rootDir:"src"` package reaches repo data). For each of the 8 rows:
  - [ ] **(a)** `runFit` with chassis prose only → **no** `FIT-TEMPLATE-LEGACY-KEY` warning and `passed === true`. *Today TPL-02 fails this — it is the regression test for the whole change.*
  - [ ] **(b)** `runFit` with one block per declared code, each `bound_object_id = '11111111-1111-4111-8111-111111111111'` (a real RFC 9562 v4, per `fit.test.ts:44-48`) plus a `VERIFIED` citation → zero `FIT-BLOCK-UNKNOWN`, `FIT-BLOCK-LEGACY`, `FIT-BLOCK-PIECE-TYPE`, `FIT-BIND-*`.
  - [ ] **(c)** every `piece_type` is one of the six tokens and none is null; `{WIRE, FEATURE, EXPLAINER, IPO, DEEP DIVE}` each have ≥1 row; **`NOTE` has none** — asserted explicitly so chassis 1b's unreachability is a stated fact, not an oversight.
  - [ ] **(d)** with `is_premium = false` and `layoutTemplate = 1a`, `report.cut.required === false` for TPL-02/03/04/07 and `true` for TPL-08 with `layoutTemplate = 3a` and `is_premium = true` — the §3.8(c) regression test.
  - [ ] **(e)** for every `auto_publish_eligible` row, every declared code has `requires_binding === true` or is in `unbound_allowed`.
  - [ ] **(f)** for every `auto_publish_eligible` row with `max_words = n`, the `edit.ts` router threshold for that key is `≤ n` — i.e. `autoSelectTemplate(new Set(), n, null) === key` and `autoSelectTemplate(new Set(), n + 1, null) !== key`.
  - [ ] **(g)** a `BLK-DELTA` whose `host_sentence` states a figure with no citation now takes `FIT-NUMBER-UNSOURCED` — the §3.8(e) test — and a normal inline block whose `host_sentence` ends in a period does not newly trip `FIT-CUT-MID-SENTENCE`.
- [ ] The five doc corrections in step 9 are in the same commit, and the ten §7 rows in step 10 exist.

---

## 6. What it deliberately does not do

- **It does not touch `ops.story_blocks`.** No `piece_types` widening (`BLK-FINTABLE`), no `requires_binding` flip (`BLK-SPARK`), no `lake_object_type` cleanup. All three are vocabulary decisions that the generator would revert on the next blocks-seed regeneration and that would force a second owner-gated apply of `20260727144500`.
- **It does not add a ninth template key**, does not build the 1b research-note lane, and does not widen `classify.ts:95` to reach `content_type` NOTE / EXPLAINER / TAKE.
- **It does not seed a word budget** beyond TPL-01 = 40. The derived read-minute figures are in a SQL comment, marked derived.
- **It does not make any template's evidence surface complete.** Seven codes are withheld for want of a live object family; TPL-04/05/06 are skeletons; TPL-03 has no statement table and no beat/miss table.
- **It does not turn the fit stage on**, does not move `fit-stage.sql` into `supabase/migrations/`, and does not flip `pipeline_intake_enabled` or `auto_publish_wires`.
- **It does not resolve a single binding.** `checkBinding` still never compares `binds_to` to an object type, and payload-level `object_id`s remain format-checked only.

**Handoffs.** To **PR.1**: `DEF-BLOCK-BINDING-NO-LAKE-TYPE` is the exact list of what the evidence-bundle phase must decide a fact can bind to, and `BLK-CONFLICT`'s question (does `FINANCIALS.XCHECK` expose both sides as separate objects?) is the first one. To **PR.4**: `ops.templates.block_keys` is a 6–11-code enum in which every code renders, is permitted, and has a live source — plus `deferred_blocks` telling the writer what was withheld and why. To **PR.5**: the ceiling widens by *adding a renderer* and regenerating; `pipeline-templates.json` is the only editorial file to touch. To **PR.6**: `DEF-BLOCK-DELTA-LITERAL-MAGNITUDE` and `DEF-FIT-PAYLOAD-BINDING-UNRESOLVED` are the two open holes on the lane that publishes itself, and both must close before `auto_publish_wires` flips.

---

## 7. Dependencies

| # | What must be true | Owner |
|---|---|---|
| 1 | Nothing. Steps 1–10 are repo-only and need no DB, no credential and no CI. **PR.0c can start immediately.** | agent |
| 2 | `generate-registry-seed.mjs --check` green at baseline (step 1). If red, an unrelated drift must be reconciled first. | agent |
| 3 | `docker` available for step 6 (`/usr/local/bin/docker`; `psql` is not on the host). If unavailable, step 6 degrades to review-only and acceptance loses the assertion coverage — say so in the PR rather than skipping silently. | host |
| 4 | **A privileged write path to apply both migrations** (step 11). No agent session has one; this is the same gate holding `20260727161500` and `20260727170000`. Batch all four. | **owner** |
| 5 | Deploy order: the worker may ship before the apply (§3.8(b) makes the read schema-tolerant and the fallback map covers the absent column). Do not delete `PIECE_TYPE_BY_TEMPLATE` until step 12's smoke query has run. | agent |
| 6 | `ops.article_templates` 1a/1b/3a/3b already seeded — `20260727144600_design_registry_seed_templates.sql`, applied. If it is not live, `layoutTemplate` resolves null everywhere and `FIT-CUT` is reported unchecked rather than enforced; confirm in step 12. | prior (PD.2) |
| 7 | **Not required:** `20260727161500` (`payload_schema`). The reseed has no dependency on it — `checkPayloadSchema` (`fit-engine.ts:743`) validates against the **Zod** schemas in `marsad-ingestion`, never the DB column, which exists for the writer's `response_format: json_schema`. | — |
| 8 | Blocks: nothing downstream. **Gates: PR.4.** PR.1/PR.2/PR.3/PR.5 can run in parallel. | — |

---

### Two objections answered here rather than absorbed

- *"`checkPayloadSchema` reports `unchecked` while `payload_schema` is null on all 61 rows, so a `BLK-SPARK` with 30 fabricated numbers passes."* — Wrong: `fit-engine.ts:743` reads `BLOCK_PAYLOAD_SCHEMAS[reg.key]` (Zod, bundled in the worker), and a literal array where `a-inline.ts:159-162` declares an `ObjectBinding` is refused `FIT-PAYLOAD-SCHEMA` today. The real residual hole is narrower and is §2.1(2), parked as `DEF-FIT-PAYLOAD-BINDING-UNRESOLVED`.
- *"`checkBinding` refuses `BLK-FRESH` because no live object type matches `market.status`."* — Wrong: it never compares `binds_to` to anything (`fit-engine.ts:362-396`). The withholding rule in §3.2 rests on the opposite fact — that a wrong binding is *invisible* — which is why it is applied symmetrically to `BLK-EXDATE`, `BLK-KEYSTATS` and `BLK-BEATMISS` as well.
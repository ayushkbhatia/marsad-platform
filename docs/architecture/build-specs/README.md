# Build specs — the PR phases, and what survived contact with `main`

⚠️ **Read this section first. Most of these specs were overtaken by work on `main`.**

They were written on 2026-07-27 against a tree at `87763e5`. While that branch sat detached,
`main` advanced 29 commits (2026-08-16) and independently built most of what they describe —
in several cases better. This file records what is still true. The specs themselves are kept
because their *investigations* remain accurate and their adversarial reviews found real defects,
but **do not build from them without checking this table.**

| spec | status against `main` today |
|---|---|
| `PR0c-templates-reseed.md` | ⛔ **Superseded** by `#98` and `20260816230000_templates_recut_and_piece_type.sql`. `ops.templates.piece_type` exists. |
| `PR1-evidence-bundles.md` | 🔶 **Built.** All 12 legs, the assembler and the `pipeline_research` stage are in. Two corrections to the spec are recorded below. Outstanding: `20260817090000` unapplied, and the switch is still off. |
| `PR4-compose-stage.md` | ⛔ **Superseded** by `#97` — the compose stage is built, armed, and has produced a real article. |
| `PR5-renderers-chart-compiler.md` | 🔶 **Partly superseded.** 33 of 61 built (A/B/C/G/H complete). Families D (12), E (8), F (8) remain — 28 blocks. The chart substrate (`src/lib/blocks/{bindings,chart-svg,resolve}.ts`) now exists, so PD.6 has a foundation the spec assumed it would have to create. |
| `PR6-open-the-gate.md` | ✅ **Still accurate and still last.** `pipeline_intake_enabled` is `false`; nothing flows automatically. |
| `apply-pending-migrations.md` (runbook) | ⛔ **Superseded.** Its six migrations were all independently landed on `main`; the ledger is at 158, not 137. Kept only for the apply/stamp *procedure*, which is still correct. |

## What `main` proved, and what it did not

**The conveyor works end to end.** Stages are `classify → draft → edit → compose → rules → fit →
approval`, with `newsroom_compose_stage`, `newsroom_fit_stage` and `newsroom_intake_sweep` all
armed. One item composed as **9 designed blocks** (`BLK-TICKER`, `BLK-BIGNUM`, `BLK-DELTA` ×2,
`BLK-STATSTRIP` ×3, `BLK-PROV`, `BLK-CITE`), carried 33 citations, cost $0.16 across 12 LLM calls,
and passed ruleset v10. Live `content_blocks` now holds real `BLK-*` rows — 6 of them. The D-8
binding contract holds in practice: payloads carry `{"field":…,"object_id":…}`, not typed numbers.

**It was not published**, and that is the right call: reading the output exposed two defects, and
the piece is a demonstration rather than a product.

## Three independent convergences

Recorded because they are evidence the analysis was sound rather than idiosyncratic — two sessions,
working separately, reached the same conclusions:

1. **The VERIFIED wall had to be widened per-object-type** via
   `ops.materiality_prefilter.citable_states`. `main`'s version (`#87`, R-03 provenance floor) also
   refuses `CONFLICT`, which the branch version did not.
2. **`ops.templates` needed a `piece_type` column** to stop every ARTICLE inheriting chassis `1a`
   and its required metered cut.
3. **The registry needed a drift guard.** `main`'s `scripts/design/check-block-renderers.mjs` is the
   better shape — offline, and wired into CI — so the branch's `registry.test.ts` was dropped.

## The one thing still genuinely unbuilt: the research stage

`20260816150000_pipeline_state_machine_complete.sql:94` seeds a `newsroom_research_stage` switch.
**Nothing reads it.** There is no `pipeline_research` handler, and no research module anywhere in
`worker/` or `ingestion/`.

What exists instead is `lake.fn_writer_context` + `worker/src/handlers/newsroom/pack.ts` — a
*context pack* for the writer: ordered, budgeted, and valid JSON, with a citation allow-set built
as a typed by-product. It is a real fix to a real bug (the pack used to be truncated mid-token at
12,000 chars, cutting off the only citable section). But it is the writer's **input**, not a
research desk: it reads a fixed set of sections for one security and does not decide what to look
for, follow a thread, or report what it looked for and did not find.

`ingestion/src/research/` (PR.1 steps 1–2, on this branch) is the contract for that stage:

- `Evidence` is a discriminated union of `BoundFact | BoundRef | UnboundFact` — **not** one type
  with an optional binding, so composing a D-8 binding from something unbindable is a *type error*.
- an absence contract that distinguishes `empty` (this company filed nothing) from `absent` (no
  producer exists for anyone) — the difference between a sentence a writer may write and one it
  may not.
- `RebindKey`, because a binding to `COMPUTED.RATIOS` has a ~24-hour life: 13.9 revisions per
  natural key, every live row rewritten nightly.
- `FIELD_FORMAT`, the single place the fraction-vs-percent decision lives — read off the producer
  (`ratios-compute.ts:202` computes `roe = netIncome/equity`), not guessed.
- `verify.ts` + 18 tests that pass with the network down.

## Corrections to the PR.1 spec, found while building it

Both were spec errors, not implementation choices:

1. **`public.financial_statement_history` does not exist.** The spec named it as `EB-REVISIONS`'
   source. Revisions are detected instead from `financial_statements.is_restated` / `version` plus
   the lake supersede chain. Measured while fixing it: **13,181 of 52,415 statements are restated —
   one in four**, so a naive period pair has a 25% chance of comparing a revision with a result.
2. **`EB-QUOTE` cannot use a plain `security_id` join.** `QUOTE.LAST` carries `security_id` on
   19,437 of 34,383 live rows (56.5%), so the naive query reports a false `empty` for four in ten
   securities. It falls back to a venue+ticker match on the natural key and *reports* that it did,
   because a quote matched by ticker is a slightly weaker claim about identity.

## Re-derived sequence

Ordered by what actually stands between today and an autonomous editorial deep dive.

1. **Family E + F renderers (16 blocks).** Cheapest real progress: zero bindings across both
   families, no chart compiler needed. E completes the Explainer template outright; F unlocks the
   wire lane. Nothing blocks this.
2. **The research stage (PR.1 → PR.2).** The switch is already there and dead. This is what turns
   "the writer receives a context pack" into "a researcher reads the lake" — the difference between
   a competent recap and a deep dive. Largest single lever on output quality.
3. **The chart compiler + D's remaining 12.** A deep dive without exhibits is not a deep dive. The
   substrate exists now, so this is no longer a from-scratch build.
4. **A quality pass on composed output**, then **PR.6 — open the intake gate narrowly.** The gate is
   last on purpose: the conveyor already works, so opening it multiplies whatever quality exists at
   that moment. The first composed piece was not publishable; opening intake before that is fixed
   would industrialise the defect rather than the capability.

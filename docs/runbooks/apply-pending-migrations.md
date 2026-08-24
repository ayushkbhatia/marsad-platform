# Runbook — apply the pending migration batch

> ⛔ **SUPERSEDED 2026-08-16. Do not run this list.** Every one of the six migrations below was
> independently landed on `main` (D-14's `citable_states` as `20260816160000`, the `piece_type`
> recut as `20260816230000`, `'fit'` as a pipeline stage as `20260816150000`). The ledger is at
> **158**, not the 137 this page checks for, and the pre-flight assertion will fail.
>
> Kept because the **procedure** is still correct and still non-obvious: the ordering rule
> (cheapest and least-locking first), the `CREATE INDEX` lock warning on a hot table, and above
> all the stamping step — `psql -f` does not write `supabase_migrations.schema_migrations`, and
> the MCP path generates its own wall-clock version that will not match the filename. That has
> bitten this project twice. Reuse the shape; ignore the list.


**Status 2026-07-27:** six migrations are committed and unapplied. They are the whole of Track 0's
mechanical half. No agent session can apply them — the Supabase MCP returns
`You do not have permission to perform this action`, `marsad_worker` has no DDL rights, the local
checkout holds only an anon key, and the `supabase` CLI is not installed. This needs one session
with the service-role/postgres DSN.

Nothing here starts the newsroom. Every switch stays as it is; `pipeline_intake_enabled` and
`newsroom_fit_stage` are both false before and after.

---

## Pre-flight

```bash
node scripts/check-migration-ledger.mjs
```

Must print `✓ migration ledger in sync — 137 migrations`. If it does not, stop: the repo and the
ledger disagree and applying will make the drift permanent.

Then confirm all six are genuinely absent from the live DB:

```sql
select version from supabase_migrations.schema_migrations
 where version in ('20260727161500','20260727170000','20260727180000','20260727190000',
                   '20260727195000','20260727200000')
 order by version;
```

Expect **zero rows**. Any row that comes back is already applied — skip that migration and re-stamp
rather than re-running it.

---

## Order, and why it is this order

Cheapest and least locking first, so a failure costs the least and the riskiest step runs last with
the others already banked.

### 1 — `20260727161500_design_block_payload_schemas.sql`

Projects the 61 Zod block schemas into `ops.story_blocks.payload_schema`.

- **Cost:** an `UPDATE` over 61 rows plus a `do $$` assertion block. Sub-second.
- **Lock:** row locks on a 69-row table. Nothing contends with it.
- **Self-verifying:** the migration raises if fewer than 61 active blocks end up populated, if any
  legacy block gets a schema, if a schema is not titled after its own block, or if the bound-block
  set does not match the generator's count. A silent partial apply is not possible.
- **Size:** 133,941 bytes — too large for some inline paths. Apply from the file, not by pasting.

```bash
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727161500_design_block_payload_schemas.sql
```

Verify:

```sql
select count(*) total, count(payload_schema) filled
  from ops.story_blocks where status = 'active';   -- expect 61 / 61
```

Currently `61 / 0`.

### 2 — `20260727180000_newsroom_fit_stage.sql`

Makes `fit` a legal pipeline stage. **This is why PD.8 is unreachable rather than merely off:**
`ops.pipeline_items.stage` has no `'fit'` value today and `ops.fn_transition` has no `rules → fit`
edge, so the stage cannot be written to the column at all.

- **Cost:** one constraint swap, one `create or replace function`, one switch insert, one small
  table. Sub-second.
- **Lock:** `ALTER TABLE ... DROP/ADD CONSTRAINT` takes an ACCESS EXCLUSIVE lock on
  `ops.pipeline_items` — a 3-row table. Adding the CHECK re-validates all 3 rows. Harmless.
- **Safety:** §3 seeds `newsroom_fit_stage = false`, and `switchOn()` reads a missing key as false,
  so behaviour is identical before and after. The old `rules → approval | published` edges are kept
  deliberately, so the switch can be turned back off without a second migration.

```bash
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727180000_newsroom_fit_stage.sql
```

Verify:

```sql
select value from iam.global_switches where key = 'newsroom_fit_stage';  -- expect false
select to_regclass('ops.fit_reports');                                    -- expect ops.fit_reports
```

### 3 — `20260727190000_d14_citable_states.sql`

D-14. Adds `ops.materiality_prefilter.citable_states text[]` and admits PENDING for the four
families that can never reach VERIFIED because they never pass through `lake.staging_rows`.

- **Cost:** `ADD COLUMN` with a non-volatile default plus an `UPDATE` over a handful of rows.
  Sub-second; Postgres 11+ does not rewrite the table for a constant default.
- **Lock:** brief ACCESS EXCLUSIVE on a tiny config table.
- **Safety:** the code already shipped and is live-safe *before* this applies —
  `fit.ts` probes `information_schema` for the column and falls back to an empty map, which the
  engine reads as VERIFIED-only, i.e. exactly the pre-D-14 behaviour. Applying it is the switch.

```bash
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727190000_d14_citable_states.sql
```

Verify:

```sql
select object_type, accepted_states, citable_states
  from ops.materiality_prefilter order by object_type;
```

`FILING.FINANCIALS`, `COMPUTED.RATIOS`, `COMPUTED.SCORE` and `PROFILE.SECURITY` must show
`{VERIFIED,PENDING}`; everything else `{VERIFIED}`. **`OHLCV.CLOSE` and `QUOTE.LAST` must stay
`{VERIFIED}`** — both genuinely flow through `lake.staging_rows` (641,542 and 194,808 rows), so
cross-check can promote them and a non-VERIFIED one means corroboration really has not happened.

### 4 — `20260727195000_pr0c_templates_piece_type.sql`, then `20260727200000_pr0c_pipeline_templates_reseed.sql`

PR.0c. **Order matters between these two** — the seed writes the column the first one adds.

- **Cost:** an `ADD COLUMN` + CHECK on an 8-row table, then an `UPDATE` over those 8 rows.
- **Safety:** the code shipped ahead of both and probes for the column, so `resolvePieceType` falls
  back to its hard-coded map until they land. The seed migration self-asserts: it raises if any
  declared `block_keys` entry is unknown or legacy, and again if a row's `piece_type` does not admit
  a block it declares.

```bash
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727195000_pr0c_templates_piece_type.sql
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727200000_pr0c_pipeline_templates_reseed.sql
```

Verify:

```sql
select key, piece_type, array_length(block_keys, 1) n, max_words, auto_publish_eligible
  from ops.templates order by key;
```

Expect all eight typed, `n` between 6 and 11, `max_words` null everywhere except TPL-01 = 40, and
`auto_publish_eligible` true on TPL-01 only.

### 5 — `20260727170000_ohlcv_daily_trade_date_turnover_index.sql`

The index the reader's prerender head needs. Last, because it is the only one that touches a hot
table.

⚠️ **This is a plain `CREATE INDEX` on a 609,723-row / 97 MB table.** It takes a `SHARE` lock, which
**blocks writes to `public.ohlcv_daily` for the duration** (expect seconds, not minutes, but it is
real). The ingest fleet writes to that table.

Two options — pick deliberately:

- **Off-market, as written.** GCC venues close by ~11:00 UTC; the quote and OHLCV lanes are quiet
  after that. Simplest, and the file applies as-is.
- **`CONCURRENTLY`, if you would rather not block at all.** `CREATE INDEX CONCURRENTLY` cannot run
  inside a transaction block, so it must be run standalone and **the migration file must be edited
  first** — do not silently diverge from the committed .sql. It is also slower and can leave an
  `INVALID` index if it fails, which then needs dropping.

```bash
psql "$PRIVILEGED_DSN" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260727170000_ohlcv_daily_trade_date_turnover_index.sql
```

Verify — the point of the index is that this stops being a sequential scan:

```sql
explain (analyze, buffers)
select security_id, value_traded from public.ohlcv_daily
 where trade_date = (select max(trade_date) from public.ohlcv_daily)
 order by value_traded desc nulls last limit 60;
```

Baseline before: **Seq Scan, 1,855 ms** as `marsad_worker` on a warm cache. After: an index scan
that stops at 60 rows. The reader-side proof is that `[prerender:stocks] primary head FAILED` stops
appearing in the Vercel build log.

---

## Stamping — do not skip

Applying by `psql -f` does **not** write `supabase_migrations.schema_migrations`. The repo would
then believe six migrations are pending forever, and the next `--write` would paper over it.

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20260727161500','design_block_payload_schemas'),
       ('20260727170000','ohlcv_daily_trade_date_turnover_index'),
       ('20260727180000','newsroom_fit_stage'),
       ('20260727190000','d14_citable_states'),
       ('20260727195000','pr0c_templates_piece_type'),
       ('20260727200000','pr0c_pipeline_templates_reseed')
on conflict (version) do nothing;
```

If you applied through the Supabase MCP instead, it generates its **own** wall-clock version and the
stamp will not match the filename. Re-stamp the row to the filename's version before reconciling —
this has bitten this project twice (PE.6 landed as `20260727143731` against a filename of
`20260727150000`).

Then confirm:

```bash
node scripts/check-migration-ledger.mjs   # ✓ in sync — 137 migrations
```

---

## Rollback

1. **Payload schemas** — `update ops.story_blocks set payload_schema = null, schema_version = null;`
   Nothing reads the column at runtime today (the fit stage enforces the Zod schemas directly), so
   reverting is inert.
2. **Fit stage** — leave the switch false. The table and the widened CHECK are additive and harm
   nothing. To fully revert, restore the 8-value CHECK from
   `20260713000009_rules_pipeline.sql:81-82` and drop `ops.fit_reports`.
3. **Index** — `drop index if exists public.ohlcv_daily_date_turnover;` Purely additive; the only
   cost of keeping it is write amplification on `ohlcv_daily`.

---

## Afterwards

Two things become true that were not:

- `ops.story_blocks.payload_schema` is populated, so **PR.4's constrained generation has a schema to
  send the provider**. It is the reason that migration matters — the fit stage never needed it.
- `fit` is a legal stage, so **PD.8 becomes reachable** — still off, but no longer structurally
  impossible.

Neither changes reader-facing behaviour. The web build fix from PR #82/#83 is unaffected either way;
the index only restores the *intended* 60 warm pages in place of the alphabetical fallback.

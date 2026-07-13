# freshness — failure-signal layer (01-ingestion.md §8, §10)

The **code half** of Marsad's two-loop freshness design. It feeds the 6-state
machine (`live · reconnecting · delayed · offline · halted · auction` + `closed`)
that screen 33a and every reader `FreshnessBadge` consume.

## What this module does and does NOT do

| Concern | Owner |
|---|---|
| Write `public.venue_feed_status` (the venue badge) | **SQL** — `ingest.sweep_feed_status()` (pg_cron `feed_status_sweep`, every minute). Applied in `20260713000005_prices.sql`. **This module never writes that table.** |
| Give the sweep its signal (`ingest.fetch_log` + `ingest.sources.last_success_at / consecutive_failures`) | **`fetch-log.ts`** (Loop A, runs per fetch on the VPS worker) |
| Classify each fetch/parse failure into the frozen taxonomy + retry/escalate policy | **`taxonomy.ts`** |
| Derive ticker-level `halted / auction / stale` facts from parsed board data | **`halt-auction.ts`** (emits facts; the lake owns `public.security_status`) |
| Pure, testable mirror of the SQL sweep's transition table | **`state-machine.ts`** |

The SQL sweep is the runtime source of truth. `state-machine.ts` is a faithful
TS mirror used for unit assertions (§8) and for readers that already hold the
raw signals; the golden tests exist to catch drift between the two.

## The two loops (01 §8)

**Loop A (this module, TypeScript, per fetch).** A worker handler runs a
`TaskSpec.fetch`, classifies the outcome (`taxonomy.ts`), and calls
`FetchLogWriter.record()` (`fetch-log.ts`):

- **success** → `ingest.fetch_log(changed, duration_ms)` + `ingest.sources.last_success_at = now, consecutive_failures = 0`.
  This is the **only** writer that advances `last_success_at` on an *unchanged*
  (deduped) fetch — critical so a quiet off-peak board does not drift to `offline`.
- **failure** → `ingest.fetch_log(http_status, error)` + `consecutive_failures += 1`.
  `HTTP_4XX` and `PARSE_DRIFT` are *quality errors*: no retry, straight to the
  Desk (`outcomeEscalates()` returns true).

**Loop B (SQL, per minute).** `ingest.sweep_feed_status()` reads
`max(last_success_at)` over each venue's active `quotes` sources and, gated by
`ingest.venue_is_open()`, walks the ladder (C = 10 min):

```
open  & ≤15 min → live
open  & 15–30   → reconnecting
open  & 30–45   → delayed
open  & >45/never → offline   (+ ops.incidents + banner; auto-expire on recovery)
!open           → closed      (weekend/holiday — NEVER offline)
desk/parser halted|auction    → preserved unless closed wins
```

## Ticker-level states (halt/auction/stale)

`halt-auction.ts` derives per-security facts from a parsed board + the session
clock: `HALTED` (per-row board status token), `AUCTION` (pre-open/pre-close
window; halt beats auction), `STALE` (present on the previous fresh snapshot,
absent now). These are handed to the staging/lake layer — this module does not
write `public.security_status`. `deriveVenueOverride()` produces the venue-level
`halted`/`auction` the state machine preserves.

## Running the tests (zero framework deps — `node:test`)

```
npm test    # node --import tsx --test "src/**/*.test.ts"
```

The package tsconfig uses `moduleResolution: "bundler"`, which permits (but does
not require) the `.js` import specifiers that the `tsx` loader rewrites to their
`.ts` sources at runtime. The tests cover the §8 transitions (incl.
weekend/holiday → `closed`, the `live→reconnecting→delayed→offline` ladder,
`closed`/override precedence), the taxonomy, the fetch-log writer, and
halt/auction/stale detection.
